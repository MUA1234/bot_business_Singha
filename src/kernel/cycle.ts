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
 * If either is absent or false the kernel does not scan, does not recommend, changes no
 * management state and WRITES NOTHING AT ALL — no run row, no audit event, no lock. It
 * returns a typed disabled result and logs to the server only. "Nothing looked" and
 * "nothing needed attention" stay distinguishable through that status, not through a
 * database write performed by a cycle that never ran.
 *
 * WHAT THE CYCLE NEVER DOES: send a message, move money, post a journal, approve a financial
 * event, contact a provider, take a customer-facing action, invoke a paid or live model, or
 * cross a company boundary. Those are structural, not conventions — the action catalogue is
 * internal-only, the interpreter is a deterministic fixture, and every query is
 * company-scoped.
 */
import { randomUUID } from "node:crypto";
import { log } from "@/lib/log";
import {
  detectFinanceObservations, detectWorkforceObservations, detectOperationsObservations,
  detectCrmObservations, detectSystemHealthObservations,
  detectGovernanceObservations, detectObjectiveObservations, detectMarketingObservations,
  detectProcurementObservations, detectAssetObservations, detectLegalObservations,
  detectProviderObservations,
  FINANCE_SOURCE, WORKFORCE_SOURCE, OPERATIONS_SOURCE, CRM_SOURCE, SYSTEM_SOURCE,
  GOVERNANCE_SOURCE, OBJECTIVES_SOURCE, MARKETING_SOURCE, PROCUREMENT_SOURCE,
  ASSETS_SOURCE, LEGAL_SOURCE, PROVIDERS_SOURCE,
} from "./adapters";
import { ingestObservation, type ExistingItem, type IngestDecision } from "./ingest";
import { actionById } from "./catalogue";
import type { CandidateEvidence } from "./people/candidate";
import { resolveCandidates, type SignalLookup } from "./people/resolve";
import { buildSnapshots, RESOLVER_VERSION, type RecommendationSnapshot } from "./people/snapshot";
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
  /** Recommendation snapshot rows written this cycle (R2B). Advice, never assignment. */
  recommendationsRecorded: number;
  /** Items for which NOBODY was suitable, recorded truthfully rather than force-assigned. */
  itemsNeedingRouting: number;
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
  persist(
    o: Observation,
    rec: PersistRecommendation | null,
    snapshots?: readonly RecommendationSnapshot[],
  ): Promise<string>;
  /**
   * Candidate evidence for one company, built ENTIRELY from server-side reads (R2B, Decision 2).
   *
   * Optional: a deployment without it simply produces no candidate recommendation, which the
   * surface reports honestly. Throwing is treated as "evidence unavailable" and recorded as a
   * routing reason — never as "nobody is suitable", which is a different and much stronger claim.
   */
  loadCandidates?(companyId: string): Promise<readonly CandidateEvidence[]>;
  /** Verified outcome history for the same company, folded into a task-specific signal. */
  loadSignals?(companyId: string): Promise<SignalLookup>;
  /** Records the run. Called for cycles that actually RAN — never for a disabled one. */
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

/**
 * Who could hold this work (R2B, owner Decision 2). **RECOMMENDATION ONLY.**
 *
 * The cycle never assigns anyone, grants authority, alters workload, notifies a consultant,
 * sends a message, approves anything or performs the work. That is structural, not a
 * convention: this function returns snapshot ROWS, and the create RPC it feeds accepts no
 * accountable owner at all, so there is no shape in which a cycle can make an assignment.
 *
 * EVERY failure mode below produces a TRUTHFUL `needs_routing` snapshot with an exact reason
 * rather than a candidate. The owner's rule — "never select an unchecked candidate to keep the
 * cycle moving" — is enforced by there being no branch that returns one.
 */
async function resolveForItem(
  deps: CycleDeps,
  o: Observation,
  rec: PersistRecommendation,
  action: { capability: string | null; department: Department } | null,
): Promise<RecommendationSnapshot[]> {
  // No loader configured: no recommendation is made, and the surface says exactly that.
  // This is NOT "nobody is suitable" — a claim we have no evidence for.
  if (!deps.loadCandidates) return [];

  const routed = (reasonCode: string, detail: string): RecommendationSnapshot[] => [{
    purpose: "assignee", outcome: "needs_routing",
    candidate_ref: null, candidate_type: null, rank_position: null,
    capabilities_used: [], skills_used: [], availability: null, confidence: null,
    reason_codes: [reasonCode], reasons: [{ code: reasonCode, detail }], missing_codes: [],
    routing_department: o.department, routing_reason_code: reasonCode,
    evidence_refs: [],
  }];

  // An unregistered action means we do not know what capability the work needs. Resolving
  // without that would offer someone for work whose requirements were never established.
  if (!action) return routed("action_not_registered", `proposed action ${rec.actionId} is not in the catalogue`);

  let candidates: readonly CandidateEvidence[];
  try {
    candidates = await deps.loadCandidates(o.companyId);
  } catch (e) {
    return routed("candidate_evidence_unavailable", `candidate evidence could not be read: ${(e as Error).message}`);
  }

  let signalFor: SignalLookup | undefined;
  try {
    signalFor = await deps.loadSignals?.(o.companyId);
  } catch {
    // Learning is an ORDERING input. Losing it is not a reason to refuse to recommend, and it
    // is not a reason to pretend history exists — the resolver simply proceeds without it.
    signalFor = undefined;
  }

  try {
    const resolution = resolveCandidates(
      {
        companyId: o.companyId,
        department: o.department,
        // Keyed on the ACTION, so outcome history is specific to this kind of work.
        taskKind: rec.actionId,
        roles: ["assignee"],
        requiredCapability: action.capability,
        // `automatic`, deliberately, and NOT rec.requiredAuthority.
        //
        // The item's required authority is the level needed to APPROVE the proposed action. The
        // assignee is the person who would DO the work once a human has approved it. Conflating
        // the two would mean only people senior enough to approve something could ever be
        // recommended to do it — a manager approving and then performing every task — and would
        // route ordinary work to `needs_routing` for want of an approval right the doer does not
        // need. Approval authority is checked separately, against the approver, at approval time.
        requiredAuthority: "automatic",
        authorityAmount: null,
        authorityDomain: null,
        requiredVerifiedSkills: [],
        preferredSkills: [],
        requiredLanguage: null,
        onDateIso: deps.now().toISOString().slice(0, 10),
        estimateHours: null,
        now: deps.now(),
      },
      candidates,
      signalFor ? { signalFor } : {},
    );
    return buildSnapshots(resolution);
  } catch (e) {
    // A resolver that throws must never be reported as "nobody qualified".
    return routed("resolver_failed", `candidate resolution failed: ${(e as Error).message}`);
  }
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

  // ── R2A: the remaining seven managed domains ───────────────────────────────────────
  {
    source: GOVERNANCE_SOURCE, department: "governance",
    detect: (rows, ctx) => detectGovernanceObservations({ ...ctx, directives: rows as never }),
  },
  {
    source: OBJECTIVES_SOURCE, department: "objectives",
    detect: (rows, ctx) => detectObjectiveObservations({ ...ctx, objectives: rows as never }),
  },
  {
    source: MARKETING_SOURCE, department: "marketing",
    detect: (rows, ctx) => detectMarketingObservations({ ...ctx, campaigns: rows as never }),
  },
  {
    source: PROCUREMENT_SOURCE, department: "procurement",
    detect: (rows, ctx) => detectProcurementObservations({ ...ctx, inventory: rows as never }),
  },
  {
    source: ASSETS_SOURCE, department: "assets",
    detect: (rows, ctx) => detectAssetObservations({ ...ctx, documents: rows as never }),
  },
  {
    source: LEGAL_SOURCE, department: "legal",
    detect: (rows, ctx) => detectLegalObservations({ ...ctx, records: rows as never }),
  },
  {
    source: PROVIDERS_SOURCE, department: "providers",
    detect: (rows, ctx) => detectProviderObservations({ ...ctx, providers: rows as never }),
  },
];

export const REGISTERED_SOURCE_COUNT = SOURCES.length;

/**
 * Run one management cycle for one company.
 *
 * NEVER THROWS. Every outcome is a typed summary. A cycle that RAN (including one that was
 * locked out or failed) is recorded, because a sweep that vanishes without trace is worse
 * than one reporting failure. A DISABLED cycle writes nothing — it did not run.
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
    recommendationsRecorded: 0,
    itemsNeedingRouting: 0,
    unobservedDepartments: [],
    failureReason: null,
    durationMs: 0,
  };

  /**
   * DISABLED IS ZERO-WRITE.
   *
   * A disabled cycle returns a typed result in memory and touches NOTHING: no run record,
   * no audit event, no lock, no detector, no company operational data. Recording a run row
   * while disabled would be a database write performed by a cycle that never ran, and it
   * would let a reader believe the business was observed.
   *
   * The distinction between "nobody needed attention" and "the kernel is disabled" survives
   * in the returned STATUS and in non-sensitive server logging - never in a company table.
   */
  const disabled = (reason: string): CycleSummary => {
    const out: CycleSummary = {
      ...base, status: "skipped_disabled", failureReason: reason,
      sourcesRegistered: 0, durationMs: deps.now().getTime() - startedAt,
    };
    // Server-side log only: status, trigger and correlation. No record data, no evidence,
    // no company name, no secret.
    log("info", "management cycle skipped - kernel disabled", {
      event: "management_cycle.skipped_disabled",
      correlationId: out.correlationId,
      trigger: out.trigger,
      reason,
    });
    return out;
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
  // The GLOBAL switch is checked first, so a globally-disabled kernel reads nothing at all -
  // not even the per-company enablement row.
  if (!kernelGloballyEnabled()) {
    return disabled("global flag MANAGEMENT_KERNEL is not on");
  }
  let companyEnabled = false;
  try {
    companyEnabled = await deps.isCompanyEnabled(req.companyId);
  } catch (e) {
    return finish({ ...base, status: "failed", failureReason: `enablement check failed: ${(e as Error).message}`, sourcesRegistered: 0 });
  }
  if (!companyEnabled) {
    return disabled("company enablement is absent or false");
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

        // 11. WHO could hold this work (R2B, owner Decision 2). RECOMMENDATION ONLY: the
        //     resolver returns candidates, nothing is assigned, no authority is granted, no
        //     workload changes and nobody is notified. The accountable owner stays NULL until
        //     an authorised human accepts, which the create RPC guarantees by not accepting it.
        const snapshots = rec
          ? await resolveForItem(deps, o, rec, actionById(rec.actionId) ?? null)
          : [];

        // 7 + 12. Persist item, evidence, the opening transition and the recommendation
        //         snapshots in ONE transaction, carrying the correlation id.
        try {
          await deps.persist(o, rec, snapshots);
          summary.itemsCreated++;
          if (snapshots.length > 0) summary.recommendationsRecorded += snapshots.length;
          if (snapshots.some((s) => s.outcome === "needs_routing")) summary.itemsNeedingRouting++;
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
