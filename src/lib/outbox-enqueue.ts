/**
 * Transactional-outbox enqueue (NEXT_PHASE_DEVELOPER_BRIEF §WP4.3). Server-only. Writes
 * one pending outbound message; the deterministic idempotency key (unique in the DB)
 * makes a duplicate enqueue — a retry, or a concurrent trigger — a no-op. The drain
 * worker (`/api/cron/outbox`) sends pending/failed-due rows. This is the SERVICE-ROLE
 * worker path (a tightly-scoped privileged write, permitted by the Brief).
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildOutboxRow, type OutboxEntry } from "@/events/outbox";
import { log } from "@/lib/log";
import { getCommunicationPreference } from "@/lib/comms/preferences";
import { isOptedOut } from "@/modules/comms/preferences";

export type EnqueueResult = "enqueued" | "duplicate" | "unavailable" | "opted_out";

export async function enqueueOutbox(entry: OutboxEntry, db?: SupabaseClient): Promise<EnqueueResult> {
  try {
    // COM-007: respect opt-out before persisting any outbound message.
    const pref = await getCommunicationPreference(entry.companyId, entry.channel, entry.recipient);
    if (isOptedOut(pref)) {
      log("info", "outbound send blocked by opt-out", {
        event: "outbox.opted_out",
        companyId: entry.companyId,
        channel: entry.channel,
        recipient: entry.recipient,
      });
      return "opted_out";
    }

    const row = buildOutboxRow(entry);
    const client = db ?? supabaseAdmin();
    // Atomic, service-only enqueue via `enqueue_outbox_row` (migration 0061): a single INSERT …
    // ON CONFLICT (idempotency_key) DO NOTHING inside the DB, so two concurrent finalisers can never
    // create two logical rows (the key is a globally-unique SHA). Returns 'enqueued' | 'duplicate'.
    // The RPC is service-only; callers that need RLS for table work pass a separate client.
    const { data, error } = await client.rpc("enqueue_outbox_row", {
      p_company: row.company_id,
      p_channel: row.channel,
      p_recipient: row.recipient,
      p_body: row.body,
      p_idempotency_key: row.idempotency_key,
      p_correlation_id: row.correlation_id,
      p_template_name: row.template_name,
      p_template_params: row.template_params,
      p_source_type: row.source_type,
      p_source_id: row.source_id,
      p_message_purpose: row.message_purpose,
    });
    if (!error && (data === "enqueued" || data === "duplicate")) return data;
    log("error", "outbox enqueue failed", { event: "outbox.enqueue_failed", error: error?.message ?? "unexpected enqueue result" });
    return "unavailable"; // RPC missing/error → don't break the caller (retryable)
  } catch (e) {
    log("error", "outbox enqueue threw", { event: "outbox.enqueue_threw", error: (e as Error).message });
    return "unavailable";
  }
}
