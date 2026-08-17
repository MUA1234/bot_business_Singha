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
  /** Approved template to deliver outside the 24h window (§WP4.7). */
  templateName?: string;
  templateParams?: string[];
  /**
   * WP12: link this send to the commercial document it delivers, so the fenced completion
   * (`complete_outbox_and_advance`) can advance the exact source when — and only when — the
   * provider send is durably recorded. No secrets: type + id + a coarse purpose only.
   */
  sourceType?: string;
  sourceId?: string;
  messagePurpose?: string;
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

/** Base + cap for exponential retry backoff (WP4.4). */
export const RETRY_BASE_MS = 60_000; // 1 minute
export const RETRY_CAP_MS = 3_600_000; // 1 hour

/**
 * When to next attempt delivery after `attemptsSoFar` failures: exponential backoff
 * (base·2^n) capped at RETRY_CAP_MS. Returns an ISO timestamp, or null once the
 * message is dead-lettered (no further retry).
 */
export function nextRetryAt(attemptsSoFar: number, now: Date = new Date()): string | null {
  if (attemptsSoFar + 1 >= MAX_OUTBOX_ATTEMPTS) return null; // will be dead-lettered
  const delay = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attemptsSoFar), RETRY_CAP_MS);
  return new Date(now.getTime() + delay).toISOString();
}

/** A failed row is due for retry when now ≥ its scheduled nextRetryAt. */
export function isDue(nextRetryIso: string | null, now: Date = new Date()): boolean {
  if (!nextRetryIso) return false; // dead-lettered or never scheduled
  return now.getTime() >= new Date(nextRetryIso).getTime();
}

/**
 * Deterministic dedup key for an INBOUND provider event (WP4.1): the same provider
 * message id maps to one key, so persisting raw events is idempotent and a webhook
 * retry never creates a second task/quotation/outbound.
 */
export function inboundEventKey(channel: string, providerMessageId: string): string {
  return `in_${sha256(`${channel}:${providerMessageId}`)}`;
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
    template_name: entry.templateName ?? null,
    template_params: entry.templateParams ?? null,
    source_type: entry.sourceType ?? null,
    source_id: entry.sourceId ?? null,
    message_purpose: entry.messagePurpose ?? null,
  };
}
