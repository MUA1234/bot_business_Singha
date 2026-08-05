/**
 * Transactional outbox for outbound messages (Architecture V2 change plan §5.7).
 * Every external send is recorded ONCE (idempotency key) so a retry or a concurrent
 * quotation finalisation can never deliver twice. A delivery worker sends pending
 * rows and records the provider id + status.
 *
 * This module holds the pure, testable rules. The DB read/write (service-role,
 * company-scoped) lives in the worker layer and is wired in a later, tested step so
 * the current synchronous WhatsApp reply (owner instruction 2026-08-04) is unchanged.
 */
import { sha256 } from "@/lib/ids";

export type OutboxStatus = "pending" | "sent" | "failed" | "dead";

/** After this many failed attempts a message is dead-lettered, not retried. */
export const MAX_OUTBOX_ATTEMPTS = 5;

export interface OutboxEntry {
  channel: "whatsapp" | "email";
  companyId: string;
  recipient: string;
  body: string;
  /** Stable dedupe input, e.g. `quotation:<id>` or `wa_reply:<message_id>`. */
  dedupeKey: string;
  correlationId?: string;
}

/**
 * Deterministic idempotency key: same channel + same dedupeKey ⇒ same key, so the
 * unique constraint on the outbox turns a duplicate enqueue into a no-op.
 */
export function outboundIdempotencyKey(channel: string, dedupeKey: string): string {
  return `out_${sha256(`${channel}:${dedupeKey}`)}`;
}

/** Only pending or previously-failed rows may be (re)sent. */
export function isSendable(status: OutboxStatus): boolean {
  return status === "pending" || status === "failed";
}

/** Status after a failed delivery attempt: retry until the cap, then dead-letter. */
export function classifyAfterFailure(attemptsSoFar: number): OutboxStatus {
  return attemptsSoFar + 1 >= MAX_OUTBOX_ATTEMPTS ? "dead" : "failed";
}

/** Build the row to insert. Pure — the caller persists it with a service-role client. */
export function buildOutboxRow(entry: OutboxEntry) {
  return {
    channel: entry.channel,
    company_id: entry.companyId,
    recipient: entry.recipient,
    body: entry.body,
    idempotency_key: outboundIdempotencyKey(entry.channel, entry.dedupeKey),
    status: "pending" as OutboxStatus,
    attempts: 0,
    correlation_id: entry.correlationId ?? null,
  };
}
