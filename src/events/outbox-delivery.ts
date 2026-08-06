/**
 * Outbox delivery planning (NEXT_PHASE_DEVELOPER_BRIEF §WP4.4/4.5). Pure and
 * deterministic — the sender worker and the admin replay UI use these to decide what
 * to send, what to do after an attempt, and how to dead-letter / replay. The DB reads
 * and provider send live in the worker; this module never performs I/O.
 */
import { classifyAfterFailure, nextRetryAt, isDue, type OutboxStatus } from "@/events/outbox";

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

/** Compute the row patch after a delivery attempt. */
export function planAfterAttempt(
  row: Pick<OutboxRow, "attempts">,
  result: { ok: true } | { ok: false; error: string },
  now: Date = new Date(),
): AttemptPatch {
  const attempts = row.attempts + 1;
  if (result.ok) {
    return { status: "sent", attempts, next_retry_at: null, last_error: null };
  }
  const status = classifyAfterFailure(row.attempts); // "failed" or "dead"
  return {
    status,
    attempts,
    next_retry_at: status === "dead" ? null : nextRetryAt(row.attempts, now),
    last_error: result.error.slice(0, 500),
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
