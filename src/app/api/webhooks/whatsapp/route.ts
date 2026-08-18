/**
 * WhatsApp Cloud API webhook — THE INTEGRATION BOUNDARY.
 *
 * Verifies Meta's subscription challenge (GET), hard-rejects an invalid signature
 * (POST — DECISIONS D-007), persists every inbound message durably, resolves the
 * COMPANY from the receiving account, and hands each message to the inbound
 * dispatcher — which decides from trusted identity whether it is a customer order, a
 * staff finance capture, or work for a person. Idempotency is on the provider message
 * id, so a redelivered webhook is a no-op. Requires the WhatsApp env vars (see
 * docs/.../APP_LAYER_STATUS.md).
 *
 * Official Meta Cloud API only — never an unofficial library (CLAUDE.md BAN-SAFETY).
 */
import { NextResponse } from "next/server";
import { env } from "@/config/env";
import {
  verifyWebhookChallenge,
  verifyWhatsappSignature,
} from "@/lib/whatsapp-signature";
import { supabaseAdmin } from "@/lib/supabase/server";
import { sha256 } from "@/lib/ids";
import { newCorrelationId, log } from "@/lib/log";
import { inngest, WHATSAPP_INBOUND_EVENT } from "@/inngest/client";
import { type InboundMessage } from "@/lib/inbound/dispatch";
import { makeInboundDeps } from "@/lib/inbound/production-deps";
import { recordInboundReceipt, type InboundReceipt } from "@/lib/inbound/receipt";
import { dispatchReceipt } from "@/lib/inbound/dispatch-receipt";

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

  const db = supabaseAdmin();
  const messages = extractTextMessages(payload);
  // Statuses / non-text events: nothing to persist — acknowledge so Meta stops retrying.
  if (messages.length === 0) return NextResponse.json({ ok: true, processed: [] });

  // §WP-C PERSIST-FIRST, now through the CANONICAL receipt (migration 0076): one provider message
  // is one row, identified by channel + receiving account + provider message id. If ANY persist
  // fails we return a RETRYABLE 503 and do NOT acknowledge — Meta redelivers, and the canonical
  // identity makes the re-persist a no-op, so nothing is ever lost or duplicated.
  const received: { msg: InboundText; receipt: InboundReceipt }[] = [];
  for (const msg of messages) {
    try {
      const receipt = await recordInboundReceipt(db, {
        source: "whatsapp",
        providerAccountId: msg.receivedBy,
        providerMessageId: msg.id,
        // The SINGLE message, never the batched delivery. One Meta delivery can carry messages for
        // several of our numbers, and storing the whole batch under one company's row would put
        // another company's message text inside a row that company's members can read.
        rawPayload: msg as unknown as Record<string, unknown>,
        contentHash: sha256(msg.text),
        correlationId: newCorrelationId(),
      });
      received.push({ msg, receipt });
    } catch (e) {
      log("error", "whatsapp source event persist failed", { event: "wa.persist_failed", error: (e as Error).message });
      return new Response("persist failed — retry", { status: 503 });
    }
  }

  if (ASYNC_MODE) {
    // §WP-C: enqueue a durable worker; NO AI call or outbound send in the request. The receipt is
    // already durable, so a failed enqueue loses nothing — the dispatch sweeper claims it from the
    // database. The worker runs the SAME dispatcher on the SAME receipt id, which is what makes the
    // async and sync paths produce identical business outcomes.
    let enqueued = 0;
    for (const { msg, receipt } of received) {
      try {
        await inngest.send({
          name: WHATSAPP_INBOUND_EVENT,
          data: {
            from: msg.from,
            text: msg.text,
            wa_message_id: msg.id,
            received_by: msg.receivedBy,
            source_event_id: receipt.event.id,
          },
        });
        enqueued += 1;
      } catch (e) {
        log("error", "whatsapp enqueue failed", { event: "wa.enqueue_failed", error: (e as Error).message });
        return new Response("enqueue failed — retry", { status: 503 });
      }
    }
    return NextResponse.json({ ok: true, enqueued });
  }

  // Synchronous mode (default): the receipt is already durably persisted, so a per-message handler
  // failure never loses it. Deciding what the message IS happens under a LEASE, so two concurrent
  // deliveries of the same message produce at most one business dispatch.
  const results: string[] = [];
  for (const { msg, receipt } of received) {
    const inbound: Omit<InboundMessage, "companyId" | "receipt"> = {
      channel: "whatsapp",
      from: msg.from,
      text: msg.text,
      providerMessageId: msg.id,
      // The single message, not the batch — see the receipt loop above.
      rawPayload: msg,
    };
    results.push(await dispatchReceipt(db, receipt, inbound, msg.receivedBy, makeInboundDeps));
  }

  // A message we could not decide — including one whose review row could not be queued, and one
  // still waiting out a backoff — must NOT be acknowledged as handled. A 503 makes Meta redeliver,
  // and redelivery is now SAFE: the canonical receipt already exists and the dispatch lease refuses
  // a second decision, so the messages that did succeed are no-ops on the retry while the
  // outstanding one gets another chance.
  if (results.includes("error") || results.includes("retry_pending")) {
    log("error", "acknowledging failure so the provider redelivers", {
      event: "wa.dispatch_incomplete",
      outcomes: results.join(","),
    });
    return new Response("dispatch failed — retry", { status: 503 });
  }
  return NextResponse.json({ ok: true, processed: results });
}

interface InboundText {
  id: string;
  from: string;
  text: string;
  /** OUR account that received it — Meta's value.metadata.phone_number_id. Decides the company. */
  receivedBy: string | null;
}

/** Pull inbound text messages (id, sender, body) from Meta's batched payload. */
function extractTextMessages(payload: unknown): InboundText[] {
  const out: InboundText[] = [];
  const p = payload as {
    entry?: {
      changes?: {
        value?: {
          metadata?: { phone_number_id?: string };
          messages?: { id?: string; from?: string; type?: string; text?: { body?: string } }[];
        };
      }[];
    }[];
  };
  for (const entry of p.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // Per CHANGE, not per payload: one webhook delivery can carry messages for several of our
      // numbers, and each message must keep the account that actually received it.
      const receivedBy = change.value?.metadata?.phone_number_id ?? null;
      for (const message of change.value?.messages ?? []) {
        if (message.id && message.from && message.type === "text" && message.text?.body) {
          out.push({ id: message.id, from: message.from, text: message.text.body, receivedBy });
        }
      }
    }
  }
  return out;
}
