/**
 * WhatsApp Cloud API webhook — THE INTEGRATION BOUNDARY.
 *
 * This handler is complete: it verifies Meta's subscription challenge (GET),
 * hard-rejects an invalid signature (POST — DECISIONS D-007), and persists-then-
 * enqueues every inbound message idempotently (guide invariant #9). It does NOT
 * become live until you configure the WhatsApp env vars and register this URL in
 * the Meta dashboard — see docs/interim-accounting/CONFIGURATION_GUIDE.md.
 *
 * Official Meta Cloud API only — never an unofficial library (CLAUDE.md BAN-SAFETY).
 */
import { NextResponse } from "next/server";
import { env } from "@/config/env";
import {
  verifyWebhookChallenge,
  verifyWhatsappSignature,
} from "@/lib/whatsapp-signature";
import { ingestSourceEvent } from "@/events/source-event";
import { makeSupabaseSourceEventStore } from "@/db/source-event-store";
import { serviceClient } from "@/db/client";
import { inngestQueue } from "@/inngest/client";

export const runtime = "nodejs"; // needs node:crypto for signature verification

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

  const store = makeSupabaseSourceEventStore(serviceClient());
  const results: string[] = [];

  // Meta batches messages under entry[].changes[].value.messages[].
  for (const msg of extractMessages(payload)) {
    const res = await ingestSourceEvent(
      {
        source: "whatsapp",
        providerMessageId: msg.id,
        rawPayload: msg.raw,
        body: JSON.stringify(msg.raw),
      },
      store,
      inngestQueue,
    );
    results.push(res.status);
  }

  // Always 200 so Meta doesn't retry a delivery we've already stored.
  return NextResponse.json({ ok: true, processed: results });
}

interface InboundMessage {
  id: string;
  raw: unknown;
}

function extractMessages(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const p = payload as {
    entry?: { changes?: { value?: { messages?: { id?: string }[] } }[] }[];
  };
  for (const entry of p.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (message.id) out.push({ id: message.id, raw: message });
      }
    }
  }
  return out;
}
