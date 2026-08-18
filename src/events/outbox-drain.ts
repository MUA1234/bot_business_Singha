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
import { classifyProviderFailure } from "@/lib/provider/failure";
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
  errors: number; // completion/release updates that did not durably affect exactly one row
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
    return { ok: false, considered: 0, sent: 0, failed: 0, dead: 0, errors: 1 };
  }

  const claimed = (data ?? []) as ClaimedRow[];
  let sent = 0,
    failed = 0,
    dead = 0,
    errors = 0;

  /** Fenced update: succeeds only if it durably affects EXACTLY ONE row we still own. */
  const fencedUpdate = async (update: Record<string, unknown>, id: string): Promise<boolean> => {
    const { data: rows, error: upErr } = await db.from("message_outbox").update(update).eq("id", id).eq("lock_owner", owner).select("id");
    if (upErr) {
      log("error", "outbox update failed", { event: "outbox.update_failed", id, error: upErr.message });
      return false;
    }
    if ((rows?.length ?? 0) !== 1) {
      // Zero rows → the lease was reclaimed by another worker (or the row moved). Not durable.
      log("error", "outbox update affected no owned row", { event: "outbox.lease_lost", id });
      return false;
    }
    return true;
  };

  for (const row of claimed) {
    // Only WhatsApp is wired; release any other channel back to the queue (don't hold the lease).
    if (row.channel !== "whatsapp") {
      if (!(await fencedUpdate({ status: "pending", locked_at: null, lock_owner: null, lease_expires_at: null }, row.id))) errors++;
      continue;
    }

    const res = row.template_name
      ? await sendWhatsAppTemplate(row.recipient, row.template_name, row.template_params ?? [], row.template_lang ?? "en")
      : await sendWhatsAppText(row.recipient, row.body);

    // Classify BEFORE planning: an absent credential, a rejected message and a 503 are three
    // different situations, and treating them as one produced dead-lettered messages that were
    // never actually offered to the provider.
    const patch = planAfterAttempt(
      { attempts: row.attempts },
      res.ok
        ? { ok: true }
        : {
            ok: false,
            error: res.reason ?? "send_failed",
            failure: classifyProviderFailure({
              reason: res.reason ?? "send_failed",
              status: res.status ?? null,
              code: res.code ?? null,
              notConfigured: res.notConfigured,
            }),
          },
    );

    if (patch.status === "sent") {
      // WP12: flip the outbox row to `sent` AND advance the linked commercial document
      // (quotation → sent / order → quoted / conversation → quoted) ATOMICALLY, via the fenced,
      // service-only RPC that verifies this worker's lease owner. Count sent ONLY when it durably
      // completes exactly one owned row.
      const { data: done, error: rpcErr } = await db.rpc("complete_outbox_and_advance", {
        p_outbox_id: row.id,
        p_lease_owner: owner,
        p_provider_message_id: res.messageId ?? null,
      });
      if (!rpcErr && done === true) {
        sent++;
      } else {
        // Provider send may have succeeded but the DB completion did not persist → the row stays
        // 'processing' and its lease will be recovered by a later claim. At-least-once, reported
        // honestly (the send is NOT counted, so no over-claim of delivery).
        if (rpcErr) log("error", "outbox complete rpc failed", { event: "outbox.complete_failed", id: row.id, error: rpcErr.message });
        else log("error", "outbox complete affected no owned row", { event: "outbox.lease_lost", id: row.id });
        errors++;
      }
      continue;
    }

    // failed / dead: record the outcome under the same lease fence (no document advance).
    const update: Record<string, unknown> = {
      status: patch.status,
      attempts: patch.attempts,
      next_retry_at: patch.next_retry_at,
      last_error: patch.last_error,
      locked_at: null,
      lock_owner: null,
      lease_expires_at: null,
    };
    if (patch.status === "dead") update.dead_at = new Date().toISOString();
    if (await fencedUpdate(update, row.id)) {
      if (patch.status === "dead") dead++;
      else failed++;
    } else {
      errors++;
    }
  }

  return { ok: errors === 0, considered: claimed.length, sent, failed, dead, errors };
}
