/**
 * Transactional-outbox enqueue (NEXT_PHASE_DEVELOPER_BRIEF §WP4.3). Server-only. Writes
 * one pending outbound message; the deterministic idempotency key (unique in the DB)
 * makes a duplicate enqueue — a retry, or a concurrent trigger — a no-op. The drain
 * worker (`/api/cron/outbox`) sends pending/failed-due rows. This is the SERVICE-ROLE
 * worker path (a tightly-scoped privileged write, permitted by the Brief).
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import { buildOutboxRow, type OutboxEntry } from "@/events/outbox";
import { log } from "@/lib/log";

export type EnqueueResult = "enqueued" | "duplicate" | "unavailable";

export async function enqueueOutbox(entry: OutboxEntry): Promise<EnqueueResult> {
  try {
    const row = buildOutboxRow(entry);
    const { error } = await supabaseAdmin().from("message_outbox").insert(row);
    if (!error) return "enqueued";
    if ((error as { code?: string }).code === "23505") return "duplicate"; // already enqueued
    log("error", "outbox enqueue failed", { event: "outbox.enqueue_failed", error: error.message });
    return "unavailable"; // table missing (pre-0011) or other → don't break the caller
  } catch (e) {
    log("error", "outbox enqueue threw", { event: "outbox.enqueue_threw", error: (e as Error).message });
    return "unavailable";
  }
}
