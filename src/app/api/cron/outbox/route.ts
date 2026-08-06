/**
 * Outbox drain worker (NEXT_PHASE_DEVELOPER_BRIEF §WP4). A cron-triggered sweep that
 * sends pending / retry-due outbound messages through the official WhatsApp sender and
 * records the outcome (provider id, attempts, next retry, dead-letter). Secured by
 * CRON_SECRET (fail-closed). It ONLY drains the transactional outbox — it never
 * composes new customer commitments. No recipient/body is returned in the response.
 *
 * Delivery decisions are the pure `outbox-delivery` engine; this route only does I/O.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { sendWhatsAppText, sendWhatsAppTemplate } from "@/lib/whatsapp";
import { selectDueForDelivery, planAfterAttempt, type OutboxRow } from "@/events/outbox-delivery";
import { log } from "@/lib/log";

export const runtime = "nodejs";

const BATCH = 50;

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log("error", "CRON_SECRET not configured — outbox drain refusing to run", { event: "cron.misconfigured" });
    return new NextResponse("cron not configured", { status: 500 });
  }
  const provided = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("message_outbox")
    .select("id, company_id, channel, recipient, body, template_name, template_params, template_lang, status, attempts, next_retry_at, last_error, created_at")
    .in("status", ["pending", "failed"])
    .order("created_at", { ascending: true })
    .limit(BATCH * 2);
  if (error) {
    log("error", "outbox drain read failed", { event: "outbox.drain_read_failed", error: error.message });
    return NextResponse.json({ ok: false }, { status: 200 });
  }

  const due = selectDueForDelivery((data ?? []) as OutboxRow[]).slice(0, BATCH);
  let sent = 0,
    failed = 0,
    dead = 0;

  for (const row of due) {
    // Only WhatsApp is wired; other channels stay pending until their sender exists.
    const r = row as unknown as { channel: string; recipient: string; body: string; template_name: string | null; template_params: string[] | null; template_lang: string | null };
    if (r.channel !== "whatsapp") continue;
    // Approved template delivers outside the 24h window; else plain text (in-session).
    const res = r.template_name
      ? await sendWhatsAppTemplate(r.recipient, r.template_name, r.template_params ?? [], r.template_lang ?? "en")
      : await sendWhatsAppText(r.recipient, r.body);
    const patch = planAfterAttempt({ attempts: row.attempts }, res.ok ? { ok: true } : { ok: false, error: res.reason ?? "send_failed" });
    const update: Record<string, unknown> = {
      status: patch.status,
      attempts: patch.attempts,
      next_retry_at: patch.next_retry_at,
      last_error: patch.last_error,
    };
    if (patch.status === "sent") {
      update.sent_at = new Date().toISOString();
      update.provider_message_id = res.messageId ?? null;
      sent++;
    } else if (patch.status === "dead") dead++;
    else failed++;
    await db.from("message_outbox").update(update).eq("id", row.id);
  }

  // No recipients/bodies in the response (§WP6.2-style hygiene) — counts only.
  return NextResponse.json({ ok: true, considered: due.length, sent, failed, dead });
}
