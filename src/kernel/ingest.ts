/**
 * Observation ingest (R1 checkpoint 3).
 *
 * Turns validated observations into management items. This is the ONLY place observations
 * become work, so the rules the owner set live here in one readable list:
 *
 *   * a duplicate observation REUSES its management item — it never creates noise;
 *   * an out-of-order observation never moves an item backwards;
 *   * a resolved or stale condition does not reappear as new work;
 *   * missing or contradictory evidence FAILS CLOSED;
 *   * an unresolved company identity FAILS CLOSED;
 *   * a detector failure is recorded as UNOBSERVED, never as "nothing found";
 *   * nothing here performs the suggested action.
 *
 * Pure and transport-free: it takes the current item state and returns a DECISION. The caller
 * applies it in a transaction, so a rollback leaves no partial item.
 */
import { assertObservationSafe, ObservationRejected, type Observation } from "./observation";
import type { Department } from "./types";

/** What ingest decided to do with one observation. */
export type IngestDecision =
  | { action: "create"; observation: Observation }
  | { action: "reuse"; itemId: string; observation: Observation; refreshedFields: string[] }
  | { action: "skip"; reason: SkipReason; itemId?: string }
  | { action: "reject"; code: string; message: string };

export type SkipReason =
  | "already_terminal"
  | "out_of_order"
  | "unchanged"
  | "stale_source";

/** The existing item for an identity key, as far as ingest needs to know it. */
export interface ExistingItem {
  id: string;
  state: string;
  severity?: string | null;
  priority?: string | null;
  evidenceAt?: string | null;
}

const TERMINAL = new Set(["verified", "rejected", "dismissed", "expired"]);

/**
 * Decide what to do with one observation.
 *
 * `existing` is the item already holding this observation's identity key, or null.
 */
export function ingestObservation(
  o: Observation,
  ctx: { companyId: string },
  existing: ExistingItem | null,
): IngestDecision {
  // FAIL CLOSED on anything unsafe: unresolved company, missing evidence, malformed
  // confidence, sensitive payload, invented deadline.
  try {
    assertObservationSafe(o, ctx);
  } catch (e) {
    if (e instanceof ObservationRejected) return { action: "reject", code: e.code, message: e.message };
    throw e;
  }

  // A STALE source record is not new work. The condition may well be real, but acting on
  // month-old evidence without re-reading it is how an automated system produces confidently
  // wrong instructions. It is skipped rather than queued.
  if (o.freshness === "stale" && !existing) {
    return { action: "skip", reason: "stale_source" };
  }

  if (!existing) return { action: "create", observation: o };

  // A RESOLVED (terminal) item is not reopened by another sighting of the same condition in
  // the same window. Re-work begins with a NEW occurrence window, which yields a new key.
  if (TERMINAL.has(existing.state)) {
    return { action: "skip", reason: "already_terminal", itemId: existing.id };
  }

  // OUT OF ORDER: a scan carrying older evidence than the item already holds must not
  // overwrite it. Two sweeps can overlap, and the later-arriving one is not always the newer.
  if (existing.evidenceAt && Date.parse(o.evidenceAt) < Date.parse(existing.evidenceAt)) {
    return { action: "skip", reason: "out_of_order", itemId: existing.id };
  }

  // DUPLICATE: same condition, same window, nothing materially different. Refresh what
  // legitimately changes; never create a second item.
  const refreshed: string[] = [];
  if (existing.severity !== o.severity) refreshed.push("severity");
  if (existing.priority !== o.priority) refreshed.push("priority");
  if (existing.evidenceAt !== o.evidenceAt) refreshed.push("evidence_at");

  if (refreshed.length === 0) {
    return { action: "skip", reason: "unchanged", itemId: existing.id };
  }
  return { action: "reuse", itemId: existing.id, observation: o, refreshedFields: refreshed };
}

/** The outcome of scanning ONE source for ONE company. */
export type ScanOutcome =
  | { ok: true; source: string; department: Department; decisions: IngestDecision[] }
  | { ok: false; source: string; department: Department; unobserved: true; reason: string };

/**
 * Run one detector and ingest what it produced.
 *
 * A detector that THROWS does not yield an empty list. The department is recorded as
 * UNOBSERVED and the surface must say so — the Command Centre's existing rule that a failed
 * data source produces "no all-clear can be given" rather than a reassuring zero.
 */
export function runSource(
  source: string,
  department: Department,
  detect: () => Observation[],
  ctx: { companyId: string },
  lookup: (identityKey: string) => ExistingItem | null,
): ScanOutcome {
  let observations: Observation[];
  try {
    observations = detect();
  } catch (e) {
    return { ok: false, source, department, unobserved: true, reason: (e as Error).message };
  }

  // MALFORMED DETECTOR OUTPUT: a detector that returns a non-array, or entries that are not
  // observations, is a failure — not an empty result.
  if (!Array.isArray(observations)) {
    return { ok: false, source, department, unobserved: true, reason: "detector did not return an array" };
  }

  const decisions: IngestDecision[] = [];
  for (const o of observations) {
    if (!o || typeof o !== "object") {
      decisions.push({ action: "reject", code: "malformed_observation", message: "detector produced a non-object" });
      continue;
    }
    decisions.push(ingestObservation(o, ctx, lookup(o.identityKey)));
  }
  return { ok: true, source, department, decisions };
}

/** Roll several scan outcomes into the counts a queue surface needs. */
export function summarise(outcomes: ScanOutcome[]) {
  const unobserved = outcomes.filter((o) => !o.ok).map((o) => o.department);
  const decisions = outcomes.flatMap((o) => (o.ok ? o.decisions : []));
  return {
    created: decisions.filter((d) => d.action === "create").length,
    reused: decisions.filter((d) => d.action === "reuse").length,
    skipped: decisions.filter((d) => d.action === "skip").length,
    rejected: decisions.filter((d) => d.action === "reject").length,
    /** Departments whose detector failed. NEVER report these as "nothing to report". */
    unobservedDepartments: [...new Set(unobserved)],
    /** True only when every registered source actually ran. */
    completeSweep: outcomes.every((o) => o.ok),
  };
}
