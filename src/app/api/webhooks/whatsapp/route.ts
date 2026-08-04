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
import { inngest } from "@/inngest/client";

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

  const results: string[] = [];

  // Each inbound customer text message → the durable order-intake pipeline.
  // Idempotency is on wa_message_id inside the Inngest function, so enqueuing a
  // redelivered message is safe.
  for (const msg of extractTextMessages(payload)) {
    await inngest.send({
      name: "whatsapp/customer_message.received",
      data: { from: msg.from, text: msg.text, wa_message_id: msg.id },
    });
    results.push("enqueued");
  }

  // Always 200 so Meta doesn't retry a delivery we've already enqueued.
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
