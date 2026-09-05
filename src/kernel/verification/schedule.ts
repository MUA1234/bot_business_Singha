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
 */
import type { SqlExec } from "../execution/ledger";
import type { SweepState, VerificationOutcome } from "./contract";
import { verifyManagementOutcome, type VerificationEnvironment } from "./service";

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
}

export const emptySweepSummary = (): VerificationSweepSummary => ({
  considered: 0, attempted: 0, verified: 0, persists: 0, contradicted: 0,
  unavailable: 0, deferred: 0, failed: 0, remaining: 0, partial: false,
});

export interface VerificationSweepInput {
  readonly companyId: string;
  /** The sweep the cycle just performed, so verification inherits its truthfulness. */
  readonly sweep: SweepState;
  /** Whether the cycle's own source reads were complete. A partial cycle verifies nothing. */
  readonly cycleComplete: boolean;
  readonly budget?: number;
}

/**
 * Run verification for the pending items of one company.
 *
 * Ordering is `next_attempt_at`, then `item_id` — deterministic, and the reason a failing item
 * cannot hold the front of the queue.
 */
export async function runVerificationSweep(
  env: VerificationEnvironment,
  input: VerificationSweepInput,
): Promise<VerificationSweepSummary> {
  const summary = emptySweepSummary();
  const { sql } = env;
  const budget = input.budget ?? VERIFICATION_BUDGET_PER_CYCLE;

  // Every pending item, whether or not it is due. `considered` must be the honest total, or
  // "nothing to do" and "nothing due yet" become indistinguishable.
  const { rows: pending } = await sql(
    `select i.id,
            coalesce(s.attempts, 0) as attempts,
            coalesce(s.next_attempt_at, now()) as next_attempt_at
       from management_items i
       left join management_verification_schedule s
              on s.company_id = i.company_id and s.item_id = i.id
      where i.company_id = $1
        and i.state in ('verifying', 'monitoring')
      order by coalesce(s.next_attempt_at, now()) asc, i.id asc`,
    [input.companyId],
  );

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
    const itemId = String(row.id);
    const dueAt = new Date(String(row.next_attempt_at));

    if (dueAt > now) {
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
    const attemptNo = Number(row.attempts ?? 0) + 1;

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

    await recordAttempt(sql, {
      companyId: input.companyId,
      itemId,
      attemptNo,
      outcome,
      detail,
      observedAt: input.sweep.observedAt,
      generation: input.sweep.generation,
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

/** Record the attempt and move the schedule forward. Append-only history, updatable state. */
async function recordAttempt(
  sql: SqlExec,
  a: {
    companyId: string;
    itemId: string;
    attemptNo: number;
    outcome: VerificationOutcome;
    detail: string;
    observedAt: Date;
    generation: string;
  },
): Promise<void> {
  await sql(
    `insert into management_verification_attempts
       (company_id, item_id, attempt_no, outcome, detail, observed_at, generation, actor_type)
     values ($1,$2,$3,$4,$5,$6,$7,'system')`,
    [a.companyId, a.itemId, a.attemptNo, a.outcome, a.detail.slice(0, 500),
     a.observedAt.toISOString(), a.generation],
  );

  await sql(
    `insert into management_verification_schedule
       (company_id, item_id, attempts, next_attempt_at, last_outcome, last_detail, last_attempt_at)
     values ($1,$2,$3, now() + ($4 || ' minutes')::interval, $5,$6, now())
     on conflict (company_id, item_id) do update
       set attempts        = excluded.attempts,
           next_attempt_at = excluded.next_attempt_at,
           last_outcome    = excluded.last_outcome,
           last_detail     = excluded.last_detail,
           last_attempt_at = excluded.last_attempt_at`,
    [
      a.companyId, a.itemId, a.attemptNo,
      String(backoffMinutesFor(a.attemptNo)),
      a.outcome, a.detail.slice(0, 500),
    ],
  );
}
