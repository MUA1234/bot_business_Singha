/**
 * Correlation IDs and idempotency keys. Guide §5: every external write carries an
 * `idempotency_key`; every record carries a `correlation_id` so a single business
 * action can be traced across source-event → draft → journal → audit.
 */
import { createHash, randomUUID } from "node:crypto";

/** A fresh correlation id for a new business action / trace. */
export function newCorrelationId(): string {
  return `corr_${randomUUID()}`;
}

/**
 * Deterministic idempotency key for an external event. Same source + same provider
 * message id => same key => the pipeline dedups it. Guide invariant #9 / §7.
 */
export function idempotencyKeyForEvent(source: string, providerMessageId: string): string {
  return `evt_${sha256(`${source}:${providerMessageId}`)}`;
}

/**
 * Content hash used to detect duplicate documents/receipts (guide invariant:
 * "prevent duplicate receipts"). Two uploads of the same bytes collide.
 */
export function contentHash(bytes: Buffer | Uint8Array | string): string {
  return sha256(bytes);
}

export function sha256(input: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}
