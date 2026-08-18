/**
 * Outbox delivery planning (NEXT_PHASE_DEVELOPER_BRIEF §WP4.4/4.5). Pure and
 * deterministic — the sender worker and the admin replay UI use these to decide what
 * to send, what to do after an attempt, and how to dead-letter / replay. The DB reads
 * and provider send live in the worker; this module never performs I/O.
 */
import { classifyAfterFailure, nextRetryAt, isDue, type OutboxStatus } from "@/events/outbox";
import { consumesRetryBudget, type FailureClass } from "@/lib/provider/failure";

export interface OutboxRow {
  id: string;
  status: OutboxStatus;
  attempts: number;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** Rows eligible to send now: pending, or previously-failed and past their retry time. */
export function selectDueForDelivery(rows: OutboxRow[], now: Date = new Date()): OutboxRow[] {
  return rows
    .filter((r) => {
      if (r.status === "pending") return true;
      if (r.status === "failed") return isDue(r.next_retry_at, now);
      return false; // sent / dead are not sendable
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at)); // oldest first (FIFO)
}

export interface AttemptPatch {
  status: OutboxStatus;
  attempts: number;
  next_retry_at: string | null;
  last_error: string | null;
}

/**
 * Compute the row patch after a delivery attempt.
 *
 * `failure` classifies WHY it failed, and the three classes are handled differently on purpose:
 *
 *   * `not_configured` — no call was made, so no attempt is counted. The row stays retryable with a
 *     fresh backoff. Counting these burned the retry budget while an owner was still setting
 *     credentials, so queued messages were already dead by the time sending became possible.
 *   * `permanent` — an invalid recipient, an unapproved template, a closed 24-hour window, a
 *     rejected token. It is dead-lettered IMMEDIATELY: seven more identical rejections tell nobody
 *     anything and delay the moment a person sees it.
 *   * `transient` (the default) — normal budgeted backoff.
 */
export function planAfterAttempt(
  row: Pick<OutboxRow, "attempts">,
  result: { ok: true } | { ok: false; error: string; failure?: FailureClass },
  now: Date = new Date(),
): AttemptPatch {
  if (result.ok) {
    return { status: "sent", attempts: row.attempts + 1, next_retry_at: null, last_error: null };
  }

  const failure: FailureClass = result.failure ?? "transient";
  const error = result.error.slice(0, 500);

  if (!consumesRetryBudget(failure)) {
    // Deliberately NOT `row.attempts + 1`. The message was never offered to the provider.
    return {
      status: "failed",
      attempts: row.attempts,
      next_retry_at: nextRetryAt(row.attempts, now) ?? new Date(now.getTime() + 60_000).toISOString(),
      last_error: error,
    };
  }

  if (failure === "permanent") {
    return { status: "dead", attempts: row.attempts + 1, next_retry_at: null, last_error: error };
  }

  const status = classifyAfterFailure(row.attempts); // "failed" or "dead"
  return {
    status,
    attempts: row.attempts + 1,
    next_retry_at: status === "dead" ? null : nextRetryAt(row.attempts, now),
    last_error: error,
  };
}

/** Rows that exhausted retries and need human triage. */
export function deadLetters(rows: OutboxRow[]): OutboxRow[] {
  return rows.filter((r) => r.status === "dead");
}

/** Only failed/dead rows may be replayed; returns the reset patch for an admin action. */
export function replayReset(row: Pick<OutboxRow, "status">): AttemptPatch | null {
  if (row.status !== "dead" && row.status !== "failed") return null;
  return { status: "pending", attempts: 0, next_retry_at: null, last_error: null };
}
