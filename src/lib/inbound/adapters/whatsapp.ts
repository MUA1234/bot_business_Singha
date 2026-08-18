/**
 * The WhatsApp Cloud API adapter (remediation R1 §6, OF-006; corrected in review loop 1).
 *
 * Turns Meta's batched webhook payload into the canonical inbound contract. Everything downstream —
 * the receipt, company resolution, identity resolution, dispatch — reads the canonical shape and
 * never Meta's.
 *
 * FOUR properties matter, and three of them were lost or nearly lost once already:
 *
 *   * `providerAccountId` is read PER CHANGE, not per payload: one delivery can carry messages for
 *     several of our numbers, and each message must keep the account that actually received it.
 *   * `raw` is the SINGLE message, never the batch. Storing the batch under one company's row would
 *     put another company's message text where that company's members can read it.
 *   * `parse` is TOTAL. A provider is free to send a shape we did not anticipate, and a webhook must
 *     still acknowledge the delivery. Every container is checked for being an array before it is
 *     iterated — `for (const x of notAnArray)` throws, and an unhandled throw in the webhook loses
 *     the WHOLE delivery, including the well-formed messages beside the malformed one.
 *   * `fromStored` is the ONLY way to re-read a message we stored. The scheduled drain used to
 *     rebuild it from an ad-hoc `{from, text}` guess; when this adapter changed `raw` to Meta's own
 *     message — where `text` is `{ body }` — every message the drain retried was re-dispatched with
 *     its body replaced by the string "[object Object]", and the drain reported success. One reader
 *     is how that cannot recur.
 *
 * Official Meta Cloud API only — never an unofficial library (CLAUDE.md BAN-SAFETY).
 */
import { CanonicalInboundMessage, type InboundAdapter } from "@/schemas/inbound-adapter";

interface MetaMedia { id?: string; mime_type?: string; filename?: string; caption?: string }
interface MetaMessage {
  id?: string;
  from?: string;
  type?: string;
  timestamp?: string;
  text?: { body?: string };
  image?: MetaMedia;
  document?: MetaMedia;
  audio?: MetaMedia;
  video?: MetaMedia;
}

/** Iterate a value only if it really is a list. Anything else contributes nothing and throws nothing. */
const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Meta's `timestamp` is unix seconds as a string. Anything else is treated as absent. */
function receivedAt(ts: string | undefined): string | null {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function mediaOf(m: MetaMessage) {
  const refs: { providerMediaId: string; mimeType: string | null; bytes: null; filename: string | null }[] = [];
  const add = (x: MetaMedia | undefined) => {
    if (x?.id) refs.push({ providerMediaId: x.id, mimeType: x.mime_type ?? null, bytes: null, filename: x.filename ?? null });
  };
  add(m.image); add(m.document); add(m.audio); add(m.video);
  return refs;
}

/**
 * The message's readable content.
 *
 * A photo of a receipt captioned "paid LKR 90,000 to Acme" carries its words in `image.caption`,
 * not in `text.body`. Reading only `text.body` gave every media message an EMPTY body, which then
 * went through identity resolution, classification and the finance gate with nothing to read — and
 * gave every one of them the same content hash.
 */
function contentOf(m: MetaMessage): string {
  if (m.type === "text") return m.text?.body ?? "";
  return m.image?.caption ?? m.document?.caption ?? m.video?.caption ?? m.audio?.caption ?? "";
}

/** One Meta message → the canonical shape, or null when it carries nothing to act on. */
function normalize(
  message: MetaMessage | null | undefined,
  account: string | null,
  correlationId: string,
): CanonicalInboundMessage | null {
  if (!message || typeof message !== "object") return null;
  if (!message.id || !message.from) return null; // a status, a read receipt, an event kind we do not handle
  const media = mediaOf(message);
  const text = contentOf(message);
  // Neither words nor an attachment: there is nothing here for anything downstream to decide on.
  if (!text && media.length === 0) return null;

  const parsed = CanonicalInboundMessage.safeParse({
    provider: whatsappAdapter.provider,
    channel: "whatsapp",
    providerAccountId: account,
    providerMessageId: message.id,
    from: message.from,
    text,
    mediaRefs: media,
    receivedAt: receivedAt(message.timestamp),
    // Meta's Cloud API carries no per-message consent metadata; saying "unknown" is honest, and
    // inventing `true` would be a claim about a person's permission.
    consent: null,
    correlationId,
    raw: message,   // the SINGLE message, never the batch
  });
  return parsed.success ? parsed.data : null;
}

export const whatsappAdapter: InboundAdapter = {
  provider: "meta_whatsapp_cloud",
  channel: "whatsapp",

  parse(payload, correlationId) {
    const out: CanonicalInboundMessage[] = [];
    const p = (payload ?? {}) as MetaPayloadish;
    for (const entry of list<{ changes?: unknown }>(p?.entry)) {
      for (const change of list<{ value?: MetaValue }>(entry?.changes)) {
        // PER CHANGE: one delivery can carry messages for several of our numbers.
        const account = change?.value?.metadata?.phone_number_id ?? null;
        for (const message of list<MetaMessage>(change?.value?.messages)) {
          const m = normalize(message, account, correlationId());
          if (m) out.push(m);
        }
      }
    }
    return out;
  },

  /**
   * Re-read a message THIS adapter stored. The scheduled drain and any future recovery path go
   * through here rather than reaching into the stored payload themselves.
   */
  fromStored(raw, providerAccountId, correlationId) {
    return normalize(raw as MetaMessage | null, providerAccountId, correlationId);
  },
};

interface MetaValue { metadata?: { phone_number_id?: string }; messages?: unknown }
interface MetaPayloadish { entry?: unknown }
