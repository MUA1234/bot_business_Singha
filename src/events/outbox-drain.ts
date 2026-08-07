/**
 * Outbox drain worker (WP C). Claims a leased batch atomically via the claim_outbox_batch
 * RPC (migration 0040 — FOR UPDATE SKIP LOCKED), sends each row through the official
 * WhatsApp Cloud API, and records the outcome, clearing the lease. Because rows are
 * claimed under a lease and moved to 'processing', two concurrent workers can NEVER send
 * the same row; a worker that crashes mid-send leaves an expired lease that the next
 * claim recovers. Delivery decisions come from the pure `outbox-delivery` engine.
 *
 * SERVICE-ROLE worker path (a tightly-scoped privileged write, permitted by the brief).
 * No recipient/body is ever returned to callers — counts only.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText, sendWhatsAppTemplate } from "@/lib/whatsapp";
import { planAfterAttempt } from "@/events/outbox-delivery";
import { log } from "@/lib/log";

interface ClaimedRow {
  id: string;
  channel: string;
  recipient: string;
  body: string;
  template_name: string | null;
  template_params: string[] | null;
  template_lang: string | null;
  attempts: number;
}

export interface DrainResult {
  ok: boolean;
  considered: number;
  sent: number;
  failed: number;
  dead: number;
}

export async function drainOutbox(db: SupabaseClient, opts?: { batch?: number; leaseSeconds?: number }): Promise<DrainResult> {
  const batch = opts?.batch ?? 50;
  const leaseSeconds = opts?.leaseSeconds ?? 120;
  const owner = `drain_${randomUUID()}`;

  const { data, error } = await db.rpc("claim_outbox_batch", {
    p_limit: batch,
    p_owner: owner,
    p_lease_seconds: leaseSeconds,
  });
  if (error) {
    log("error", "outbox claim failed", { event: "outbox.claim_failed", error: error.message });
    return { ok: false, considered: 0, sent: 0, failed: 0, dead: 0 };
  }

  const claimed = (data ?? []) as ClaimedRow[];
  let sent = 0,
    failed = 0,
    dead = 0;

  for (const row of claimed) {
    // Only WhatsApp is wired; release any other channel back to the queue (don't hold the lease).
    if (row.channel !== "whatsapp") {
      await db.from("message_outbox").update({ status: "pending", locked_at: null, lock_owner: null, lease_expires_at: null }).eq("id", row.id);
      continue;
    }

    const res = row.template_name
      ? await sendWhatsAppTemplate(row.recipient, row.template_name, row.template_params ?? [], row.template_lang ?? "en")
      : await sendWhatsAppText(row.recipient, row.body);

    const patch = planAfterAttempt({ attempts: row.attempts }, res.ok ? { ok: true } : { ok: false, error: res.reason ?? "send_failed" });
    const update: Record<string, unknown> = {
      status: patch.status,
      attempts: patch.attempts,
      next_retry_at: patch.next_retry_at,
      last_error: patch.last_error,
      // Release the lease on every terminal outcome.
      locked_at: null,
      lock_owner: null,
      lease_expires_at: null,
    };
    if (patch.status === "sent") {
      update.sent_at = new Date().toISOString();
      update.provider_message_id = res.messageId ?? null;
      sent++;
    } else if (patch.status === "dead") {
      update.dead_at = new Date().toISOString();
      dead++;
    } else {
      failed++;
    }
    await db.from("message_outbox").update(update).eq("id", row.id);
  }

  return { ok: true, considered: claimed.length, sent, failed, dead };
}
