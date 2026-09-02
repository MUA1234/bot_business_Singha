/**
 * The management cycle — R1's single server-side runtime entrypoint.
 *
 * ONE implementation, used by every trigger mode: an authorised manual invocation, an
 * internal test invocation, and a future scheduler that is defined but NOT registered. A
 * route must never contain a second management implementation.
 *
 * TWO INDEPENDENT SWITCHES, both required, both server-side:
 *   1. a global server flag (`MANAGEMENT_KERNEL`), default OFF, deliberately NOT prefixed
 *      `NEXT_PUBLIC_` so it can never be set or read from a browser;
 *   2. an explicit per-company enablement row, writable only with the existing
 *      `admin.organisation.manage` capability.
 * If either is absent or false the kernel does not scan, does not recommend and changes no
 * management state. It records that it was skipped, because "nothing looked" and "nothing
 * needed attention" are different facts.
 *
 * WHAT THE CYCLE NEVER DOES: send a message, move money, post a journal, approve a financial
 * event, contact a provider, take a customer-facing action, invoke a paid or live model, or
 * cross a company boundary. Those are structural, not conventions — the action catalogue is
 * internal-only, the interpreter is a deterministic fixture, and every query is
 * company-scoped.
 */
import { randomUUID } from "node:crypto";
import {
  detectFinanceObservations, detectWorkforceObservations, detectOperationsObservations,
  detectCrmObservations, detectSystemHealthObservations,
  FINANCE_SOURCE, WORKFORCE_SOURCE, OPERATIONS_SOURCE, CRM_SOURCE, SYSTEM_SOURCE,
} from "./adapters";
import { ingestObservation, type ExistingItem, type IngestDecision } from "./ingest";
import { buildRecommendation } from "./recommend";
import { fixtureInterpreter, interpretWithGuards } from "./interpretation";
import type { Observation } from "./observation";
import type { Department } from "./types";
import type { AuthorityContext } from "@/policy/authority-engine";

export type TriggerMode = "manual" | "scheduled" | "test";

export type CycleStatus = "completed" | "partial" | "skipped_disabled" | "skipped_locked" | "failed";

export interface CycleSummary {
  correlationId: string;
  companyId: string;
  trigger: TriggerMode;
  status: CycleStatus;
  sourcesRegistered: number;
  sourcesSucceeded: number;
  sourcesFailed: number;
  itemsCreated: number;
  itemsReused: number;
  observationsSkipped: number;
  observationsRejected: number;
  /** Departments whose adapter failed. A cycle with any of these can never be `completed`. */
  unobservedDepartments: Department[];
  failureReason: string | null;
  durationMs: number;
}

/** Everything the cycle needs, injected so it is testable and has no ambient I/O. */
export interface CycleDeps {
  /** Reads company-scoped source rows for one adapter. Throwing marks that source failed. */
  loadFor(source: string, companyId: string): Promise<unknown>;
  /** True only when the per-company enablement row says so. */
  isCompanyEnabled(companyId: string): Promise<boolean>;
  /** Returns false when another cycle already holds this company's lock. */
  tryLock(companyId: string): Promise<boolean>;
  releaseLock(companyId: string): Promise<void>;
  /** Existing item for an identity key, or null. */
  findByIdentity(companyId: string, identityKey: string): Promise<ExistingItem | null>;
  /** Persists item + evidence + opening transition in ONE transaction. */
  persist(o: Observation, rec: PersistRecommendation | null): Promise<string>;
  /** Records the run. Always called, including for skipped and failed cycles. */
  recordRun(summary: CycleSummary, actorId: string | null): Promise<void>;
  /** Company authority context for the existing authority engine. */
  authorityFor(companyId: string): Promise<AuthorityContext>;
  now(): Date;
}

export interface PersistRecommendation {
  actionId: string;
  requiredAuthority: string;
  evidenceQuality: string;
  mayRunUnattended: boolean;
}

export interface CycleRequest {
  companyId: string;
  actorId: string | null;
  trigger: TriggerMode;
  /** Ties every item, transition and audit row of this cycle together. */
  correlationId?: string;
}

/** The global switch. Server-side only — never `NEXT_PUBLIC_`. */
export function kernelGloballyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MANAGEMENT_KERNEL === "on";
}

/** The registered sources, and how each turns loaded rows into observations. */
const SOURCES: ReadonlyArray<{
  source: string;
  department: Department;
  detect(rows: unknown, ctx: { companyId: string; correlationId: string; now: Date }): Observation[];
}> = [
  {
    source: FINANCE_SOURCE, department: "finance",
    detect: (rows, ctx) => detectFinanceObservations({ ...ctx, invoices: rows as never }),
  },
  {
    source: WORKFORCE_SOURCE, department: "workforce",
    detect: (rows, ctx) => detectWorkforceObservations({ ...ctx, capacities: rows as never }),
  },
  {
    source: OPERATIONS_SOURCE, department: "operations",
    detect: (rows, ctx) => detectOperationsObservations({ ...ctx, tasks: rows as never }),
  },
  {
    source: CRM_SOURCE, department: "crm",
    detect: (rows, ctx) => detectCrmObservations({ ...ctx, conversations: rows as never }),
  },
  {
    source: SYSTEM_SOURCE, department: "system",
    // The system-health adapter takes a shaped signal object rather than a row list.
    detect: (rows, ctx) => detectSystemHealthObservations({ ...ctx, ...(rows as object) } as never),
  },
];

export const REGISTERED_SOURCE_COUNT = SOURCES.length;

/**
 * Run one management cycle for one company.
 *
 * NEVER THROWS. Every outcome — disabled, locked, partially failed, wholly failed — is a
 * recorded summary, because a management sweep that vanishes without trace is worse than
 * one that reports failure.
 */
export async function runManagementCycle(deps: CycleDeps, req: CycleRequest): Promise<CycleSummary> {
  const startedAt = deps.now().getTime();
  const correlationId = req.correlationId ?? randomUUID();

  const base: CycleSummary = {
    correlationId,
    companyId: req.companyId,
    trigger: req.trigger,
    status: "completed",
    sourcesRegistered: SOURCES.length,
    sourcesSucceeded: 0,
    sourcesFailed: 0,
    itemsCreated: 0,
    itemsReused: 0,
    observationsSkipped: 0,
    observationsRejected: 0,
    unobservedDepartments: [],
    failureReason: null,
    durationMs: 0,
  };

  const finish = async (s: CycleSummary): Promise<CycleSummary> => {
    const out = { ...s, durationMs: deps.now().getTime() - startedAt };
    try {
      await deps.recordRun(out, req.actorId);
    } catch {
      // A failure to record the run must not mask the cycle's own outcome; the caller
      // still receives a truthful summary.
    }
    return out;
  };

  // ── 1. BOTH switches, before anything is read ────────────────────────────────────────
  if (!kernelGloballyEnabled()) {
    return finish({ ...base, status: "skipped_disabled", failureReason: "global flag MANAGEMENT_KERNEL is not on", sourcesRegistered: 0 });
  }
  let companyEnabled = false;
  try {
    companyEnabled = await deps.isCompanyEnabled(req.companyId);
  } catch (e) {
    return finish({ ...base, status: "failed", failureReason: `enablement check failed: ${(e as Error).message}`, sourcesRegistered: 0 });
  }
  if (!companyEnabled) {
    return finish({ ...base, status: "skipped_disabled", failureReason: "company enablement is absent or false", sourcesRegistered: 0 });
  }

  // ── 2. Company-scoped concurrency lock ───────────────────────────────────────────────
  let locked = false;
  try {
    locked = await deps.tryLock(req.companyId);
  } catch (e) {
    return finish({ ...base, status: "failed", failureReason: `lock failed: ${(e as Error).message}` });
  }
  if (!locked) {
    return finish({ ...base, status: "skipped_locked", failureReason: "another cycle is already running for this company" });
  }

  const summary = { ...base };

  try {
    const authority = await deps.authorityFor(req.companyId);
    const ctx = { companyId: req.companyId, correlationId, now: deps.now() };

    // ── 3-11. Each registered source, bounded and independent ─────────────────────────
    for (const s of SOURCES) {
      let observations: Observation[];
      try {
        const rows = await deps.loadFor(s.source, req.companyId);
        const produced = s.detect(rows, ctx);
        // 5. VALIDATE the adapter result. A detector that returns a non-array is a
        //    failure, not an empty result.
        if (!Array.isArray(produced)) throw new Error("adapter did not return an array");
        observations = produced;
      } catch (e) {
        // A failing adapter marks ITS department unobserved and the cycle partial. It never
        // becomes a silent success, and it never aborts the other four.
        summary.sourcesFailed++;
        summary.unobservedDepartments.push(s.department);
        continue;
      }
      summary.sourcesSucceeded++;

      for (const o of observations) {
        // 6. DEDUPLICATE, and fail closed on anything unsafe.
        const existing = await deps.findByIdentity(req.companyId, o.identityKey);
        const decision: IngestDecision = ingestObservation(o, { companyId: req.companyId }, existing);

        if (decision.action === "reject") {
          summary.observationsRejected++;
          continue;
        }
        if (decision.action === "skip") {
          summary.observationsSkipped++;
          continue;
        }
        if (decision.action === "reuse") {
          summary.itemsReused++;
          continue;
        }

        // 8-9. Prioritisation rides on the observation; the recommendation may only ever be
        //      a catalogue-registered, internal-only action.
        const interpretation = await interpretWithGuards(o, o.evidence, fixtureInterpreter());
        let rec: PersistRecommendation | null = null;
        try {
          const built = buildRecommendation({ observation: o, interpretation, authority });
          if (built) {
            rec = {
              actionId: built.action.id,
              requiredAuthority: built.requiredAuthority, // 10. authority from the existing engine
              evidenceQuality: built.evidenceQuality,
              mayRunUnattended: built.mayRunUnattended,
            };
          }
        } catch {
          // A recommendation that cannot be made is not a reason to lose the observation:
          // the item is still recorded, with no proposed action, for a human to look at.
          rec = null;
        }

        // 7 + 12. Persist item, evidence and the opening transition in ONE transaction,
        //         carrying the correlation id.
        try {
          await deps.persist(o, rec);
          summary.itemsCreated++;
        } catch {
          // A persistence failure for one observation must not lose the other four
          // departments' work, and must not be reported as success.
          summary.observationsRejected++;
          if (!summary.unobservedDepartments.includes(s.department)) {
            summary.unobservedDepartments.push(s.department);
          }
        }
      }
    }

    // 13. A cycle that did not observe everything it registered is PARTIAL, never complete.
    summary.status =
      summary.sourcesFailed > 0 || summary.unobservedDepartments.length > 0 ? "partial" : "completed";
    if (summary.status === "partial") {
      summary.failureReason = `unobserved: ${summary.unobservedDepartments.join(", ")}`;
    }
    return await finish(summary);
  } catch (e) {
    return await finish({ ...summary, status: "failed", failureReason: (e as Error).message });
  } finally {
    // 14. Release the lock whatever happened.
    try {
      await deps.releaseLock(req.companyId);
    } catch {
      /* the advisory lock is released with the session in any case */
    }
  }
}
