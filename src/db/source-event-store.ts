/**
 * Supabase-backed SourceEventStore. Idempotency is enforced by the DB unique
 * constraint on source_events.idempotency_key (migration 0004): a concurrent
 * duplicate delivery hits the constraint and we treat it as "already existed".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SourceEventStore, StoredSourceEvent } from "@/events/source-event";

export function makeSupabaseSourceEventStore(db: SupabaseClient): SourceEventStore {
  return {
    async upsert(row) {
      // Try insert; on unique-violation, fetch the existing row.
      const insert = await db
        .from("source_events")
        .insert({
          source: row.source,
          provider_message_id: row.provider_message_id,
          company_id: row.company_id,
          raw_payload: row.raw_payload,
          content_hash: row.content_hash,
          idempotency_key: row.idempotency_key,
          correlation_id: row.correlation_id,
          status: "received",
        })
        .select("id, idempotency_key, correlation_id, status")
        .single();

      if (!insert.error && insert.data) {
        return { event: insert.data as StoredSourceEvent, alreadyExisted: false };
      }

      // 23505 = unique_violation → already ingested; return the stored one.
      if (insert.error && insert.error.code === "23505") {
        const existing = await db
          .from("source_events")
          .select("id, idempotency_key, correlation_id, status")
          .eq("idempotency_key", row.idempotency_key)
          .single();
        if (existing.data) {
          return { event: existing.data as StoredSourceEvent, alreadyExisted: true };
        }
      }
      throw new Error(`source_events upsert failed: ${insert.error?.message ?? "unknown"}`);
    },
  };
}
