/**
 * Source-event ingestion orchestration. Guide invariant #9: every external event
 * is stored BEFORE it is processed, is idempotent, deduplicated, retryable and
 * traceable. A failed process must never lose the original event.
 *
 * This is pure orchestration over ports so it is unit-testable without a DB or a
 * live queue. The webhook route + Inngest wire the real ports at the boundary.
 */
import { contentHash, idempotencyKeyForEvent, newCorrelationId } from "@/lib/ids";

export type SourceChannel =
  | "whatsapp"
  | "email"
  | "upload"
  | "google_sheets"
  | "bank_file"
  | "operational"
  | "manual";

export interface RawSourceEvent {
  source: SourceChannel;
  providerMessageId: string;
  rawPayload: unknown;
  /** Raw bytes/body used for content-hash dedup, when available. */
  body?: string | Buffer;
  companyId?: string | null;
}

export interface StoredSourceEvent {
  id: string;
  idempotency_key: string;
  correlation_id: string;
  status: string;
}

/** Persistence + queue ports implemented by the DB/Inngest layer. */
export interface SourceEventStore {
  /** Insert; MUST be idempotent on idempotency_key (unique constraint). Returns
   *  the row, and whether it already existed. */
  upsert(row: {
    source: SourceChannel;
    provider_message_id: string;
    company_id: string | null;
    raw_payload: unknown;
    content_hash: string | null;
    idempotency_key: string;
    correlation_id: string;
  }): Promise<{ event: StoredSourceEvent; alreadyExisted: boolean }>;
}

export interface EventQueue {
  enqueue(event: { name: string; data: { source_event_id: string; correlation_id: string } }): Promise<void>;
}

export type IngestResult =
  | { status: "enqueued"; event: StoredSourceEvent }
  | { status: "duplicate"; event: StoredSourceEvent };

/**
 * Ingest one raw external event. Persist first; only enqueue if this is the first
 * time we've seen it. A duplicate delivery (same provider message id) short-circuits
 * — it never enqueues a second processing job, so it can never create a duplicate
 * downstream record (guide invariant #9, §14 "duplicate webhook delivery").
 */
export async function ingestSourceEvent(
  raw: RawSourceEvent,
  store: SourceEventStore,
  queue: EventQueue,
): Promise<IngestResult> {
  const idempotencyKey = idempotencyKeyForEvent(raw.source, raw.providerMessageId);
  const hash = raw.body !== undefined ? contentHash(raw.body) : null;
  const correlationId = newCorrelationId();

  const { event, alreadyExisted } = await store.upsert({
    source: raw.source,
    provider_message_id: raw.providerMessageId,
    company_id: raw.companyId ?? null,
    raw_payload: raw.rawPayload,
    content_hash: hash,
    idempotency_key: idempotencyKey,
    correlation_id: correlationId,
  });

  if (alreadyExisted) {
    return { status: "duplicate", event };
  }

  await queue.enqueue({
    name: "financial/source_event.received",
    data: { source_event_id: event.id, correlation_id: event.correlation_id },
  });

  return { status: "enqueued", event };
}
