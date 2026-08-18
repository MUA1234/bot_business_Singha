/**
 * The WhatsApp Cloud API adapter (remediation R1 §6, OF-006).
 *
 * Turns Meta's batched webhook payload into the canonical inbound contract. Everything downstream —
 * the receipt, company resolution, identity resolution, dispatch — reads the canonical shape and
 * never Meta's.
 *
 * Two properties matter and are easy to lose:
 *   * `providerAccountId` is read PER CHANGE, not per payload: one delivery can carry messages for
 *     several of our numbers, and each message must keep the account that actually received it.
 *   * `raw` is the SINGLE message, never the batch. Storing the batch under one company's row would
 *     put another company's message text where that company's members can read it.
 *
 * Official Meta Cloud API only — never an unofficial library (CLAUDE.md BAN-SAFETY).
 */
import { CanonicalInboundMessage, type InboundAdapter } from "@/schemas/inbound-adapter";

interface MetaMessage {
  id?: string;
  from?: string;
  type?: string;
  timestamp?: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string };
  document?: { id?: string; mime_type?: string; filename?: string };
  audio?: { id?: string; mime_type?: string };
}

interface MetaPayload {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: MetaMessage[];
      };
    }[];
  }[];
}

/** Meta's `timestamp` is unix seconds as a string. Anything else is treated as absent. */
function receivedAt(ts: string | undefined): string | null {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function mediaOf(m: MetaMessage) {
  const refs: { providerMediaId: string; mimeType: string | null; bytes: null; filename: string | null }[] = [];
  if (m.image?.id) refs.push({ providerMediaId: m.image.id, mimeType: m.image.mime_type ?? null, bytes: null, filename: null });
  if (m.document?.id) refs.push({ providerMediaId: m.document.id, mimeType: m.document.mime_type ?? null, bytes: null, filename: m.document.filename ?? null });
  if (m.audio?.id) refs.push({ providerMediaId: m.audio.id, mimeType: m.audio.mime_type ?? null, bytes: null, filename: null });
  return refs;
}

export const whatsappAdapter: InboundAdapter = {
  provider: "meta_whatsapp_cloud",
  channel: "whatsapp",
  parse(payload, correlationId) {
    const out: CanonicalInboundMessage[] = [];
    const p = (payload ?? {}) as MetaPayload;
    for (const entry of p.entry ?? []) {
      for (const change of entry.changes ?? []) {
        // PER CHANGE: one delivery can carry messages for several of our numbers.
        const account = change.value?.metadata?.phone_number_id ?? null;
        for (const message of change.value?.messages ?? []) {
          if (!message.id || !message.from) continue; // a status or an event kind we do not handle
          const media = mediaOf(message);
          const text = message.type === "text" ? (message.text?.body ?? "") : "";
          // A message with neither text nor media carries nothing to act on.
          if (!text && media.length === 0) continue;

          const parsed = CanonicalInboundMessage.safeParse({
            provider: whatsappAdapter.provider,
            channel: "whatsapp",
            providerAccountId: account,
            providerMessageId: message.id,
            from: message.from,
            text,
            mediaRefs: media,
            receivedAt: receivedAt(message.timestamp),
            // Meta's Cloud API carries no per-message consent metadata; saying "unknown" is honest,
            // and inventing `true` would be a claim about a person's permission.
            consent: null,
            correlationId: correlationId(),
            raw: message,   // the SINGLE message, never the batch
          });
          if (parsed.success) out.push(parsed.data);
        }
      }
    }
    return out;
  },
};
