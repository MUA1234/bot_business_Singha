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
  /** HTTP status when the request completed; null for a timeout or network error. */
  status?: number | null;
  /** Meta's numeric error code when it supplied one. Drives permanent-vs-transient. */
  code?: number | null;
  /** True when no call was attempted because the credentials are absent. */
  notConfigured?: boolean;
}

/**
 * Hard ceiling on one provider call. Without it a hung connection holds the request until the
 * platform kills the whole function — the send is neither completed nor recorded as failed, and the
 * outbox row keeps its lease until it expires. A timeout is a TRANSIENT failure with no HTTP status.
 */
const SEND_TIMEOUT_MS = Number(process.env.WHATSAPP_TIMEOUT_MS ?? 15_000);

/**
 * One Graph API POST with a bounded deadline and defensive parsing.
 *
 * The response body is read as TEXT first: an edge/proxy error returns HTML, and parsing that as
 * JSON used to throw, so a plain 502 was reported as a JSON syntax error and classified as a
 * transport fault rather than as the retryable upstream failure it is.
 */
async function postToGraph(phoneId: string, token: string, body: unknown): Promise<SendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: { messages?: { id: string }[]; error?: { message?: string; code?: number } } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: json.error?.message ?? `http_${res.status}`,
        status: res.status,
        code: json.error?.code ?? null,
      };
    }
    return { ok: true, messageId: json.messages?.[0]?.id, status: res.status };
  } catch (e) {
    const aborted = (e as Error).name === "AbortError";
    return {
      ok: false,
      reason: aborted ? `timeout_after_${SEND_TIMEOUT_MS}ms` : (e as Error).message,
      status: null,
      code: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Send a plain text WhatsApp message to a customer number (E.164, no '+'). */
export async function sendWhatsAppText(to: string, body: string): Promise<SendResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    log("warn", "whatsapp send skipped — access token / phone id not set", { event: "wa.send_skipped" });
    return { ok: false, reason: "not_configured", notConfigured: true };
  }

  return postToGraph(phoneId, token, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to.replace(/^\+/, ""),
    type: "text",
    text: { preview_url: true, body },
  });
}

/**
 * Send an APPROVED template message (Meta Cloud API `type: "template"`). Templates
 * deliver outside the 24-hour customer-service window, which is required for staff
 * notifications (§WP4.7/4.8). `templateName` must be an approved template in the Meta
 * account; `params` fill its body `{{1}}, {{2}}, …` placeholders in order.
 */
export async function sendWhatsAppTemplate(to: string, templateName: string, params: string[] = [], lang = "en"): Promise<SendResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    log("warn", "whatsapp template send skipped — access token / phone id not set", { event: "wa.template_skipped" });
    return { ok: false, reason: "not_configured", notConfigured: true };
  }
  const components = params.length
    ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }]
    : undefined;

  return postToGraph(phoneId, token, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to.replace(/^\+/, ""),
    type: "template",
    template: { name: templateName, language: { code: lang }, ...(components ? { components } : {}) },
  });
}

/** Append the "please wait" footer unless the body already carries it. */
export function withPendingFooter(body: string): string {
  return body.includes(QUOTE_PENDING_FOOTER) ? body : `${body}\n\n${QUOTE_PENDING_FOOTER}`;
}
