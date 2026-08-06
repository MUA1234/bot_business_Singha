/**
 * WhatsApp Cloud API sender (OFFICIAL Meta API only — CLAUDE.md BAN-SAFETY).
 * Uses the global fetch (no SDK dependency). If the send credentials are not yet
 * configured, it degrades gracefully (logs + returns not-configured) so the rest
 * of the pipeline still runs — the message simply isn't delivered until the env
 * vars are set in Vercel.
 *
 * Required env: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID.
 */
import { log } from "@/lib/log";

const GRAPH_VERSION = "v20.0";

/** The exact footer appended while a quotation is being priced (owner rule, D-017). */
export const QUOTE_PENDING_FOOTER = "(Quotation is being generated. Please wait)";

export interface SendResult {
  ok: boolean;
  messageId?: string;
  reason?: string;
}

/** Send a plain text WhatsApp message to a customer number (E.164, no '+'). */
export async function sendWhatsAppText(to: string, body: string): Promise<SendResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    log("warn", "whatsapp send skipped — access token / phone id not set", { event: "wa.send_skipped" });
    return { ok: false, reason: "not_configured" };
  }

  const to_ = to.replace(/^\+/, "");
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to_,
        type: "text",
        text: { preview_url: true, body },
      }),
    });
    const json = (await res.json()) as { messages?: { id: string }[]; error?: { message: string } };
    if (!res.ok) return { ok: false, reason: json.error?.message ?? `http_${res.status}` };
    return { ok: true, messageId: json.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Append the "please wait" footer unless the body already carries it. */
export function withPendingFooter(body: string): string {
  return body.includes(QUOTE_PENDING_FOOTER) ? body : `${body}\n\n${QUOTE_PENDING_FOOTER}`;
}
