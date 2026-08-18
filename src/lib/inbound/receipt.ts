/**
 * The canonical inbound receipt and its dispatch lifecycle (migration 0076).
 *
 * One provider message becomes ONE row, identified by trusted provider facts — channel, the account
 * that received it, and the provider's message id. Deciding what the message IS happens under a
 * lease, so two concurrent deliveries of the same message can produce at most one business dispatch.
 *
 * Before this, the webhook persisted a receipt under one idempotency key and the ingestion path
 * persisted a SECOND row under another, which meant every inbound message — customer orders
 * included — looked like unprocessed work to the sweeper and to the health signal.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoredSourceEvent } from "@/events/source-event";
import { log } from "@/lib/log";

export type DispatchOutcome = "customer_order" | "staff_finance" | "manual_review" | "recorded" | "clarification";

export interface InboundReceipt {
  event: StoredSourceEvent;
  /** False when this exact provider message was already received before. */
  created: boolean;
  /** Null when the provider supplied no message id — such a receipt is never deduplicated. */
  identity: string | null;
  dispatchState: string;
}

/** Persist the message durably BEFORE anything reads it. Idempotent on the canonical identity. */
export async function recordInboundReceipt(
  db: SupabaseClient,
  input: {
    source: string;
    providerAccountId: string | null;
    providerMessageId: string | null;
    rawPayload: unknown;
    contentHash: string | null;
    correlationId: string;
    purpose?: string;
  },
): Promise<InboundReceipt> {
  const { data, error } = await db.rpc("record_inbound_receipt", {
    p_source: input.source,
    p_provider_account_id: input.providerAccountId,
    p_provider_message_id: input.providerMessageId,
    p_raw_payload: input.rawPayload,
    p_content_hash: input.contentHash,
    p_correlation_id: input.correlationId,
    p_purpose: input.purpose ?? "inbound_message",
  });
  if (error) throw new Error(`inbound receipt failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { event_id: string; created: boolean; event_identity: string | null; dispatch_state: string }
    | null;
  if (!row?.event_id) throw new Error("inbound receipt returned no event");
  return {
    event: {
      id: row.event_id,
      idempotency_key: row.event_identity ?? row.event_id,
      correlation_id: input.correlationId,
      status: "received",
    },
    created: row.created,
    identity: row.event_identity,
    dispatchState: row.dispatch_state,
  };
}

/**
 * Take the dispatch lease. Returns false when this receipt is already decided, already being
 * decided by a live lease, waiting out a backoff, superseded, or with a person — which is exactly
 * how "at most one business dispatch" survives two concurrent deliveries.
 */
export async function claimInboundDispatch(
  db: SupabaseClient,
  eventId: string,
  owner: string,
  leaseSeconds = 120,
): Promise<boolean> {
  const { data, error } = await db.rpc("claim_inbound_dispatch", {
    p_event: eventId,
    p_owner: owner,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw new Error(`dispatch claim failed: ${error.message}`);
  return data === true;
}

/**
 * Record what the dispatch decided. Called AFTER the downstream effect exists, so a crash can never
 * leave a marker without one; the reverse — an effect with no marker — is recovered by the retry,
 * because every downstream is independently idempotent.
 */
export async function recordInboundDispatch(
  db: SupabaseClient,
  input: {
    eventId: string;
    owner: string;
    outcome: DispatchOutcome;
    companyId?: string | null;
    downstreamKind?: string | null;
    downstreamId?: string | null;
  },
): Promise<{ state: string; consumerReady: boolean; already: boolean }> {
  const { data, error } = await db.rpc("record_inbound_dispatch", {
    p_event: input.eventId,
    p_owner: input.owner,
    p_outcome: input.outcome,
    p_company: input.companyId ?? null,
    p_downstream_kind: input.downstreamKind ?? null,
    p_downstream_id: input.downstreamId ?? null,
  });
  if (error) throw new Error(`recording the dispatch failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { dispatch_state: string; consumer_ready: boolean; already: boolean }
    | null;
  return {
    state: String(row?.dispatch_state ?? "dispatched"),
    consumerReady: row?.consumer_ready === true,
    already: row?.already === true,
  };
}

/** The receipt's current dispatch state, for deciding whether a refused claim is retryable. */
export async function dispatchStateOf(db: SupabaseClient, eventId: string): Promise<string | null> {
  const { data, error } = await db.from("source_events").select("dispatch_state").eq("id", eventId).maybeSingle();
  if (error) return null;
  return (data?.dispatch_state as string | undefined) ?? null;
}

/** A dispatch that threw. Bounded backoff, then a person — never a silent disappearance. */
export async function failInboundDispatch(
  db: SupabaseClient,
  eventId: string,
  owner: string,
  errorCode: string,
  message: string,
): Promise<string> {
  const { data, error } = await db.rpc("fail_inbound_dispatch", {
    p_event: eventId,
    p_owner: owner,
    p_error_code: errorCode,
    p_error: message,
  });
  if (error) {
    // The receipt is durable and its lease expires, so the worker recovers it. Say so rather than
    // pretending the failure was recorded.
    log("error", "could not record a dispatch failure", {
      event: "inbound.fail_record_failed",
      eventId,
      error: error.message,
    });
    return "unrecorded";
  }
  return String(data ?? "failed");
}
