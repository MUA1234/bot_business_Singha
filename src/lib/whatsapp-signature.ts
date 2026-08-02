/**
 * Meta WhatsApp webhook signature verification. DECISIONS D-007: a signature
 * mismatch is a HARD REJECT, never a warning. Guide §13: signed & authenticated
 * webhooks. Uses a timing-safe comparison.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify the `X-Hub-Signature-256` header against the raw request body.
 * @param rawBody the exact bytes Meta sent (verify BEFORE JSON parsing).
 * @param header  value of `X-Hub-Signature-256`, e.g. "sha256=abc...".
 * @param appSecret Meta app secret.
 */
export function verifyWhatsappSignature(rawBody: string | Buffer, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const provided = header.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Webhook verification handshake (GET). Meta sends hub.mode/verify_token/challenge;
 * we echo the challenge only when the token matches the one we configured.
 */
export function verifyWebhookChallenge(
  params: URLSearchParams,
  expectedVerifyToken: string,
): { ok: true; challenge: string } | { ok: false } {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (mode === "subscribe" && token === expectedVerifyToken && challenge) {
    return { ok: true, challenge };
  }
  return { ok: false };
}
