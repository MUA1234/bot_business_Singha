/**
 * WhatsApp Cloud API webhook — THE INTEGRATION BOUNDARY.
 *
 * Verifies Meta's subscription challenge (GET), hard-rejects an invalid signature
 * (POST — DECISIONS D-007), and handles each inbound customer message inline: the
 * order-intake engine collects details, prices from the catalog / routes a price
 * confirmation, and replies over WhatsApp — synchronously, no Inngest required
 * (owner instruction 2026-08-04). Idempotency is on the provider message id
 * (`handleCustomerMessage` dedups on wa_message_id), so a redelivered webhook is a
 * no-op. Requires the WhatsApp env vars (see docs/.../APP_LAYER_STATUS.md).
 *
 * Official Meta Cloud API only — never an unofficial library (CLAUDE.md BAN-SAFETY).
 */
import { NextResponse } from "next/server";
import { env } from "@/config/env";
import {
  verifyWebhookChallenge,
  verifyWhatsappSignature,
} from "@/lib/whatsapp-signature";
import { handleCustomerMessage } from "@/lib/order-intake";
import { supabaseAdmin } from "@/lib/supabase/server";
import { makeSupabaseSourceEventStore } from "@/db/source-event-store";
import { inboundEventKey } from "@/events/outbox";
import { sha256 } from "@/lib/ids";
import { newCorrelationId, log } from "@/lib/log";
import { inngest, WHATSAPP_INBOUND_EVENT } from "@/inngest/client";

/** §WP4: async, persist-first webhook. When on, the webhook only persists + enqueues +
 *  returns 200; a durable Inngest worker does the AI/order/reply. Requires INNGEST_*
 *  keys, so it is flag-gated (Constitution: feature-flag high-risk cutovers) and
 *  defaults to the synchronous reply until enabled + validated on staging. */
const ASYNC_MODE = process.env.WHATSAPP_ASYNC === "on";

export const runtime = "nodejs"; // needs node:crypto for signature verification
export const maxDuration = 60; // allow time for the AI turn + reply

/** GET — Meta subscription verification handshake. */
export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const result = verifyWebhookChallenge(params, env.whatsapp.verifyToken());
  if (result.ok) return new Response(result.challenge, { status: 200 });
  return new Response("forbidden", { status: 403 });
}

/** POST — inbound messages/statuses. Signature is verified on the RAW body. */
export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text(); // raw bytes required for HMAC
  const signature = req.headers.get("x-hub-signature-256");

  if (!verifyWhatsappSignature(rawBody, signature, env.whatsapp.appSecret())) {
    // Hard reject — never process an unauthenticated webhook (D-007).
    return new Response("invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const store = makeSupabaseSourceEventStore(supabaseAdmin());
  const messages = extractTextMessages(payload);
  // Statuses / non-text events: nothing to persist — acknowledge so Meta stops retrying.
  if (messages.length === 0) return NextResponse.json({ ok: true, processed: [] });

  // §WP-C PERSIST-FIRST. Store every raw event durably BEFORE any processing. If ANY
  // persist fails we return a RETRYABLE 503 and do NOT acknowledge — Meta redelivers,
  // and the provider-message unique key makes a re-persist idempotent, so nothing is
  // ever lost or duplicated. A 200 is only ever returned after durable acceptance.
  for (const msg of messages) {
    try {
      await store.upsert({
        source: "whatsapp",
        provider_message_id: msg.id,
        company_id: null,
        raw_payload: msg as unknown as Record<string, unknown>,
        content_hash: sha256(msg.text),
        idempotency_key: inboundEventKey("whatsapp", msg.id),
        correlation_id: newCorrelationId(),
      });
    } catch (e) {
      log("error", "whatsapp source event persist failed", { event: "wa.persist_failed", error: (e as Error).message });
      return new Response("persist failed — retry", { status: 503 });
    }
  }

  if (ASYNC_MODE) {
    // §WP-C: enqueue a durable worker; NO AI call or outbound send in the request. If the
    // enqueue fails we return 503 — the persisted event is recoverable and provider dedup
    // prevents a duplicate on redelivery. Idempotency (wa_message_id) is enforced downstream.
    for (const msg of messages) {
      try {
        await inngest.send({ name: WHATSAPP_INBOUND_EVENT, data: { from: msg.from, text: msg.text, wa_message_id: msg.id } });
      } catch (e) {
        log("error", "whatsapp enqueue failed", { event: "wa.enqueue_failed", error: (e as Error).message });
        return new Response("enqueue failed — retry", { status: 503 });
      }
    }
    return NextResponse.json({ ok: true, enqueued: messages.length });
  }

  // Synchronous mode (default): the event is already durably persisted, so a per-message
  // handler failure never loses it — reply is best-effort and resume-safe (handled_at),
  // and a Meta redelivery is a dedup no-op. Acknowledge 200 after durable persistence.
  const results: string[] = [];
  for (const msg of messages) {
    try {
      const res = await handleCustomerMessage({ from: msg.from, text: msg.text, waMessageId: msg.id });
      results.push(res.status);
    } catch (e) {
      log("error", "handleCustomerMessage failed", { event: "wa.handle_failed", error: (e as Error).message });
      results.push("error");
    }
  }
  return NextResponse.json({ ok: true, processed: results });
}

interface InboundText {
  id: string;
  from: string;
  text: string;
}

/** Pull inbound text messages (id, sender, body) from Meta's batched payload. */
function extractTextMessages(payload: unknown): InboundText[] {
  const out: InboundText[] = [];
  const p = payload as {
    entry?: {
      changes?: {
        value?: { messages?: { id?: string; from?: string; type?: string; text?: { body?: string } }[] };
      }[];
    }[];
  };
  for (const entry of p.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (message.id && message.from && message.type === "text" && message.text?.body) {
          out.push({ id: message.id, from: message.from, text: message.text.body });
        }
      }
    }
  }
  return out;
}
