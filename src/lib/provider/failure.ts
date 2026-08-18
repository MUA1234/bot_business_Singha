/**
 * Provider failure classification (FOUND-003 — provider-adapter failure handling).
 *
 * Every send failure was treated identically: count an attempt, back off, and dead-letter once the
 * retry budget ran out. Three different things were being conflated, and each was handled wrongly
 * as a result:
 *
 *   1. NOT CONFIGURED — the access token or phone number id is absent. This is not a property of
 *      the message. Counting attempts against it means that by the time an owner sets the
 *      credentials, the queued messages are already dead-lettered and nobody is told why.
 *   2. PERMANENT — the recipient number is invalid, the template is not approved, the 24-hour
 *      customer-service window is closed, the token is rejected. Retrying eight times cannot change
 *      any of these; it only delays the moment a person finds out.
 *   3. TRANSIENT — a 5xx, a rate limit, a timeout, a dropped connection. This is what backoff and
 *      retry are FOR.
 *
 * Classification is pure and lives here so it can be tested exhaustively without a provider.
 */
export type FailureClass = "not_configured" | "permanent" | "transient";

/**
 * Meta Cloud API error codes that cannot succeed on retry.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
const PERMANENT_META_CODES = new Set([
  131026, // message undeliverable (recipient not on WhatsApp / cannot receive)
  131047, // re-engagement required — the 24h customer-service window is closed
  131051, // unsupported message type
  132000, // template param count mismatch
  132001, // template does not exist / not approved in this language
  132005, // template hydrated text too long
  132007, // template format character policy violated
  132012, // template parameter format mismatch
  133010, // phone number not registered
  190,    // access token expired/invalid
]);

/** HTTP statuses that are retryable regardless of the body. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface ProviderFailure {
  /** Provider or transport reason, as reported. */
  reason: string;
  /** HTTP status when the request completed; null for a network error or timeout. */
  status?: number | null;
  /** Provider-specific numeric error code when supplied. */
  code?: number | null;
  /** True when the adapter never attempted a call because credentials are absent. */
  notConfigured?: boolean;
}

export function classifyProviderFailure(f: ProviderFailure): FailureClass {
  if (f.notConfigured || f.reason === "not_configured") return "not_configured";
  if (f.code != null && PERMANENT_META_CODES.has(f.code)) return "permanent";
  if (f.status != null) {
    if (TRANSIENT_STATUS.has(f.status)) return "transient";
    // Any other 4xx is a request the provider rejected on its merits. Sending it again unchanged
    // produces the same rejection.
    if (f.status >= 400 && f.status < 500) return "permanent";
    return "transient";
  }
  // No status at all: a timeout, DNS failure or dropped connection. Those are worth retrying.
  return "transient";
}

/**
 * Should this attempt count against the message's retry budget?
 *
 * A missing credential is the operator's to fix and says nothing about the message, so it must not
 * consume the budget — otherwise the queue quietly dies while someone is still setting up.
 */
export function consumesRetryBudget(c: FailureClass): boolean {
  return c !== "not_configured";
}
