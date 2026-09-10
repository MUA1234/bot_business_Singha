/**
 * Scheduling outcome verification inside the management cycle (R2F-F-009).
 *
 * ── The two ways this goes wrong, and what prevents each ─────────────────────────────────────
 *
 * **Starvation by a bad first item.** An item whose source keeps failing, or whose record cannot be
 * interpreted, would otherwise sit at the front of the queue consuming every cycle's budget while
 * everything behind it is never attempted. So each attempt sets a NEXT-ATTEMPT time with bounded
 * exponential backoff, and selection orders by that time: a failing item steps back, it does not
 * block. It is not forgotten either — `attempts` and `last_outcome` stay readable, and the cycle
 * reports how many remain.
 *
 * **Starvation of ordinary observation.** Verification takes a bounded slice per company per cycle
 * and no more. Twelve domains still have to be looked at, and a queue of pending verifications must
 * not stop the system noticing new problems.
 *
 * ── Determinism ──────────────────────────────────────────────────────────────────────────────
 *
 * No model is consulted about whether work succeeded. Every conclusion comes from re-reading the
 * originating record and running the same detector that raised the condition.
 *
 * ── One implementation ───────────────────────────────────────────────────────────────────────
 *
 * Everything below runs against a `VerificationStore`, and both transports — direct PostgreSQL and
 * Supabase — reach this same code. Ordering, budget, backoff and the decision to defer are decided
 * here, once, so no deployment can get different fairness by using a different transport.
 */
import type { SweepState, VerificationOutcome } from "./contract";
import { verifyManagementOutcome, type VerificationEnvironment } from "./service";
import type { PendingVerification } from "./store";

/**
 * How many items one company may have verified in one cycle.
 *
 * Deliberately small. Verification is bounded work that must leave room for the twelve domain
 * reads; a company with a hundred pending items works through them over cycles rather than
 * starving observation once.
 */
export const VERIFICATION_BUDGET_PER_CYCLE = 10;

/** Backoff schedule, in minutes, by attempt number. The last value repeats — bounded, not endless. */
const BACKOFF_MINUTES = [5, 15, 60, 240, 1440];

export function backoffMinutesFor(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[i]!;
}

/**
 * The single selection order: earliest due first, then item id.
 *
 * A never-attempted item (`nextAttemptAt: null`) is due now and sorts first. Deterministic, and the
 * reason a failing item cannot hold the front of the queue. Applied here rather than in each
 * transport, so fairness cannot come to depend on which adapter a deployment happens to use.
 */
export function orderPending(rows: readonly PendingVerification[]): PendingVerification[] {
  return [...rows].sort((a, b) => {
    const at = a.nextAttemptAt?.getTime() ?? 0;
    const bt = b.nextAttemptAt?.getTime() ?? 0;
    if (at !== bt) return at - bt;
    return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
  });
}

/**
 * Outcomes that end the matter. An item that reached one of these has transitioned and will not be
 * selected again, because it is no longer in a verifiable state.
 */
const TERMINAL_OUTCOMES = new Set<VerificationOutcome>([
  "verified_resolved",
  "condition_persists",
  "condition_worsened",
  "contradicted",
]);

export interface VerificationSweepSummary {
  /** Pending items that exist at all, before the budget is applied. */
  considered: number;
  attempted: number;
  verified: number;
  persists: number;
  contradicted: number;
  unavailable: number;
  /** Eligible but not attempted this cycle — budget exhausted, or still in backoff. */
  deferred: number;
  /** The attempt itself threw. Distinct from a conclusion of `unavailable`. */
  failed: number;
  /** Still pending after this cycle. */
  remaining: number;
  /**
   * True when verification work is left unknown — budget exhausted, backoff pending, or an
   * attempt threw. A cycle with this set must never be reported as calm.
   */
  partial: boolean;
  /**
   * Why NO sweep ran at all, or null when one did.
   *
   * This is the difference between "there was nothing to verify" and "verification could not be
   * reached", which a summary of zeroes cannot express. A deployment without the verification
   * schema, or one whose transport failed, says so here — and sets `partial`, because unknown
   * verification work is not a calm cycle.
   */
  unavailableReason: string | null;
  /** Which transport reached the database, or null when none did. */
  transport: "postgres" | "supabase" | null;
}

export const emptySweepSummary = (): VerificationSweepSummary => ({
  considered: 0, attempted: 0, verified: 0, persists: 0, contradicted: 0,
  unavailable: 0, deferred: 0, failed: 0, remaining: 0, partial: false,
  unavailableReason: null, transport: null,
});

/**
 * The result of a sweep that could not happen.
 *
 * Never zeroes with no explanation: a cycle that could not verify anything must be distinguishable
 * from a cycle with nothing to verify, or a deployment can run for ever verifying nothing while
 * every summary reads as calm completion.
 */
export const unavailableSweepSummary = (reason: string): VerificationSweepSummary => ({
  ...emptySweepSummary(),
  unavailableReason: reason,
  partial: true,
});

export interface VerificationSweepInput {
  readonly companyId: string;
  /** The sweep the cycle just performed, so verification inherits its truthfulness. */
  readonly sweep: SweepState;
  /** Whether the cycle's own source reads were complete. A partial cycle verifies nothing. */
  readonly cycleComplete: boolean;
  readonly budget?: number;
}

/** Run verification for the pending items of one company. */
export async function runVerificationSweep(
  env: VerificationEnvironment,
  input: VerificationSweepInput,
): Promise<VerificationSweepSummary> {
  const summary = emptySweepSummary();
  const { store } = env;
  summary.transport = store.transport;
  const budget = input.budget ?? VERIFICATION_BUDGET_PER_CYCLE;

  // Every pending item, whether or not it is due. `considered` must be the honest total, or
  // "nothing to do" and "nothing due yet" become indistinguishable.
  const pending = orderPending(await store.listPending(input.companyId));

  summary.considered = pending.length;
  summary.remaining = pending.length;
  if (pending.length === 0) return summary;

  // A partial cycle cannot support a conclusion. Every pending item is deferred, and the summary
  // says so rather than reporting a calm cycle with nothing verified.
  if (!input.cycleComplete) {
    summary.deferred = pending.length;
    summary.partial = true;
    return summary;
  }

  const now = env.now();
  let used = 0;

  for (const row of pending) {
    const itemId = row.itemId;

    if (row.nextAttemptAt !== null && row.nextAttemptAt > now) {
      // In backoff. Deferred, not failed — and it does not consume budget.
      summary.deferred++;
      summary.partial = true;
      continue;
    }
    if (used >= budget) {
      summary.deferred++;
      summary.partial = true;
      continue;
    }

    used++;
    summary.attempted++;
    const attemptNo = row.attempts + 1;

    let outcome: VerificationOutcome;
    let detail: string;
    try {
      const out = await verifyManagementOutcome(env, {
        companyId: input.companyId,
        itemId,
        // Scheduled verification is the SYSTEM's act. The learning fold excludes non-human
        // deciders, so a machine conclusion cannot become evidence about a person.
        actorId: null,
        sweep: input.sweep,
      });
      outcome = out.outcome;
      detail = out.detail;
      if (out.outcome === "verified_resolved") summary.verified++;
      else if (out.outcome === "condition_persists" || out.outcome === "condition_worsened") {
        summary.persists++;
      } else if (out.outcome === "contradicted") summary.contradicted++;
      else summary.unavailable++;
    } catch (e) {
      // The attempt threw. That is not a conclusion about the business, and it must not be
      // recorded as one — nor may it stop the remaining items being attempted.
      summary.failed++;
      summary.partial = true;
      outcome = "unavailable";
      detail = `verification attempt failed: ${(e as Error).message}`;
    }

    const backoff = backoffMinutesFor(attemptNo);
    await store.recordAttempt({
      companyId: input.companyId,
      itemId,
      attemptNo,
      outcome,
      detail: detail.slice(0, 500),
      observedAt: input.sweep.observedAt,
      generation: input.sweep.generation,
      // The backoff rule lives here, applied to one clock, so both transports schedule identically.
      nextAttemptAt: new Date(now.getTime() + backoff * 60_000),
      attemptedAt: now,
    });

    if (TERMINAL_OUTCOMES.has(outcome)) {
      summary.remaining--;
    } else {
      // Inconclusive: it stays pending, and the next attempt is pushed back so it cannot hold the
      // front of the queue.
      summary.partial = true;
    }
  }

  return summary;
}
