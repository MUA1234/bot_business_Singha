/**
 * Inbound email webhook: signature verification + payload normalisation.
 *
 * Pure and provider-shaped, so the boundary route stays thin and every rule here is
 * unit-tested without a network or a database (same split as `whatsapp-signature.ts` +
 * `whatsapp-inbound.ts`).
 *
 * SIGNATURE. DECISIONS D-007 applies to every webhook, not just Meta's: an invalid signature
 * is a HARD REJECT, never a warning, and an UNCONFIGURED secret is also a reject (fail
 * closed) — an ingestion endpoint that accepts unauthenticated POSTs is an open door into the
 * event log. The scheme is the common denominator across inbound-parse providers: HMAC-SHA256
 * over the RAW body with a shared secret, hex-encoded, compared timing-safely. The header name
 * is configuration because providers disagree on it; the algorithm is not, because accepting
 * "whatever the provider sends" is how signature checks get bypassed.
 *
 * NORMALISATION. Providers disagree on field names too, so `normalizeInboundEmail` accepts the
 * handful of spellings the common ones use and requires the three fields ingestion genuinely
 * needs: a provider message id (the idempotency key — a redelivery must never ingest twice),
 * the recipient (the COMPANY ROUTING KEY, migration 0071) and something to hash as the body.
 * Anything it cannot understand is rejected rather than half-ingested.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Default header. Overridable via EMAIL_WEBHOOK_SIGNATURE_HEADER. */
export const DEFAULT_EMAIL_SIGNATURE_HEADER = "x-signature-256";

/**
 * Verify an inbound-email webhook signature against the raw body.
 *
 * Returns false — never throws, never "allows on error" — when the secret is missing/blank,
 * the header is absent, or the digest does not match. An optional `sha256=` prefix is
 * tolerated because several providers send one.
 */
export function verifyEmailSignature(rawBody: string | Buffer, header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.trim() === "") return false; // unconfigured → closed, not open
  if (!header) return false;
  const provided = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  if (!/^[0-9a-fA-F]+$/.test(provided)) return false; // Buffer.from would silently truncate
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided.toLowerCase(), "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface InboundEmail {
  /** Provider's unique id for this delivery — the idempotency key. */
  providerMessageId: string;
  /** Address the mail was delivered TO, lower-cased: the company routing key. */
  recipient: string;
  from: string | null;
  subject: string | null;
  /** Best available text content; used for the content hash. */
  text: string;
}

/**
 * Field spellings the common inbound-parse providers use. Kept in one place because BOTH
 * ingestion (which needs the routing key and the idempotency key) and extraction (which
 * needs the words a human wrote) read the same payload, and two divergent lists would mean
 * an email that routes correctly but reaches the AI as an unreadable provider envelope.
 */
const SUBJECT_KEYS = ["subject", "Subject"];
const TEXT_KEYS = ["text", "body-plain", "plain", "stripped-text", "html"];

/** First non-empty string among the given keys. */
function pick(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * Extract the one address mail was delivered to. A `To:` header may carry a display name
 * ("Sales <sales@x.com>") and may list several addresses; routing uses the FIRST address,
 * bare and lower-cased, because that is what a per-company inbound address looks like.
 */
export function parseRecipient(raw: string | null): string | null {
  if (!raw) return null;
  const first = raw.split(",")[0]?.trim() ?? "";
  const angled = first.match(/<([^>]+)>/);
  const addr = (angled?.[1] ?? first).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : null;
}

export type NormalizeResult =
  | { ok: true; email: InboundEmail }
  | { ok: false; reason: "not_an_object" | "no_message_id" | "no_recipient" };

/**
 * Normalise a provider payload. Field spellings cover the common inbound-parse shapes
 * (`message-id`/`messageId`/`id`, `to`/`recipient`/`To`, `text`/`body-plain`/`plain`).
 */
export function normalizeInboundEmail(payload: unknown): NormalizeResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "not_an_object" };
  const o = payload as Record<string, unknown>;

  const providerMessageId = pick(o, ["message-id", "messageId", "Message-Id", "message_id", "id"]);
  if (!providerMessageId) return { ok: false, reason: "no_message_id" };

  const recipient = parseRecipient(pick(o, ["recipient", "to", "To", "envelope_to"]));
  if (!recipient) return { ok: false, reason: "no_recipient" };

  return {
    ok: true,
    email: {
      providerMessageId,
      recipient,
      from: parseRecipient(pick(o, ["sender", "from", "From"])),
      subject: pick(o, SUBJECT_KEYS),
      // Empty text is legal (an attachment-only mail); the content hash just hashes "".
      text: pick(o, TEXT_KEYS) ?? "",
    },
  };
}

/**
 * The human-readable content of a stored inbound-email payload — what AI extraction should
 * read. Returns null when the payload carries neither a subject nor a body, so the caller
 * can fall back rather than hand the model an empty string.
 *
 * WHY THIS EXISTS. `source_events.raw_payload` stores the provider's envelope verbatim
 * (evidence is kept raw, never rewritten). The consumer previously had no email branch and
 * fell through to `JSON.stringify`, so the model was asked to read an invoice out of a blob
 * of MIME headers, routing keys and HTML — with the actual message buried in it. The subject
 * is prepended because on a real supplier mail it routinely carries the invoice number or
 * the amount, and dropping it loses extractable facts.
 */
export function emailContentText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const o = payload as Record<string, unknown>;
  const subject = pick(o, SUBJECT_KEYS);
  const text = pick(o, TEXT_KEYS);
  if (subject === null && text === null) return null;
  if (subject === null) return text ?? "";
  return text === null ? `Subject: ${subject}` : `Subject: ${subject}\n\n${text}`;
}
