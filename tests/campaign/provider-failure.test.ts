/**
 * FOUND-003 — provider-adapter failure handling.
 *
 * Before this, every send failure was the same failure: count an attempt, back off, dead-letter
 * after the budget ran out. That produced two distinct wrong behaviours — messages dead-lettered
 * while the credentials were merely absent (they were never offered to the provider at all), and
 * eight pointless retries of a rejection that could never succeed.
 */
import { describe, it, expect } from "vitest";
import { classifyProviderFailure, consumesRetryBudget } from "@/lib/provider/failure";
import { planAfterAttempt } from "@/events/outbox-delivery";

const NOW = new Date("2026-08-18T10:00:00.000Z");

describe("provider failure classification", () => {
  it("absent credentials are NOT a property of the message", () => {
    expect(classifyProviderFailure({ reason: "not_configured", notConfigured: true })).toBe("not_configured");
    expect(classifyProviderFailure({ reason: "not_configured" })).toBe("not_configured");
    expect(consumesRetryBudget("not_configured")).toBe(false);
  });

  it("Meta codes that cannot succeed on retry are permanent", () => {
    for (const code of [131026, 131047, 132001, 133010]) {
      expect(classifyProviderFailure({ reason: "x", status: 400, code }), String(code)).toBe("permanent");
    }
  });

  it("a CREDENTIAL problem is the operator's, not the message's — the queue must survive it", () => {
    // Classifying an expired token as permanent dead-lettered the entire queue on the first
    // attempt, contradicting the reason the not-configured class exists.
    for (const code of [190, 10]) {
      expect(classifyProviderFailure({ reason: "token expired", status: 401, code }), String(code)).toBe("not_configured");
    }
    for (const status of [401, 403]) {
      expect(classifyProviderFailure({ reason: "unauthorised", status }), String(status)).toBe("not_configured");
    }
    expect(consumesRetryBudget("not_configured")).toBe(false);
  });

  it("rate limiting and server errors are transient", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifyProviderFailure({ reason: "x", status }), String(status)).toBe("transient");
    }
  });

  it("any other 4xx is permanent — the same request produces the same rejection", () => {
    for (const status of [400, 404, 422]) {
      expect(classifyProviderFailure({ reason: "x", status }), String(status)).toBe("permanent");
    }
  });

  it("a timeout or dropped connection has no status and is transient", () => {
    expect(classifyProviderFailure({ reason: "timeout_after_15000ms", status: null })).toBe("transient");
    expect(classifyProviderFailure({ reason: "fetch failed" })).toBe("transient");
  });

  it("a transient HTTP status wins over a permanent-looking code", () => {
    // 429 with an incidental code is still rate limiting.
    expect(classifyProviderFailure({ reason: "x", status: 429, code: 4 })).toBe("transient");
  });
});

describe("delivery planning honours the classification", () => {
  it("a missing credential does NOT consume an attempt", () => {
    const p = planAfterAttempt({ attempts: 3 }, { ok: false, error: "not_configured", failure: "not_configured" }, NOW);
    expect(p.attempts).toBe(3); // unchanged — the message was never offered to the provider
    expect(p.status).toBe("failed"); // still retryable
    expect(p.next_retry_at).not.toBeNull();
  });

  it("a missing credential still schedules a retry at the LAST attempt of the budget", () => {
    // The budget-exhaustion path returns no retry time; a config problem must not inherit that and
    // silently strand the message with nothing to wake it up.
    const p = planAfterAttempt({ attempts: 99 }, { ok: false, error: "not_configured", failure: "not_configured" }, NOW);
    expect(p.status).toBe("failed");
    expect(p.next_retry_at).not.toBeNull();
  });

  it("a permanent failure dead-letters immediately rather than after eight identical rejections", () => {
    const p = planAfterAttempt({ attempts: 0 }, { ok: false, error: "invalid recipient", failure: "permanent" }, NOW);
    expect(p.status).toBe("dead");
    expect(p.attempts).toBe(1);
    expect(p.next_retry_at).toBeNull();
    expect(p.last_error).toBe("invalid recipient");
  });

  it("a transient failure keeps the existing budgeted backoff", () => {
    const p = planAfterAttempt({ attempts: 1 }, { ok: false, error: "http_503", failure: "transient" }, NOW);
    expect(p.status).toBe("failed");
    expect(p.attempts).toBe(2);
    expect(p.next_retry_at).not.toBeNull();
  });

  it("an unclassified failure behaves exactly as before — transient", () => {
    const withOut = planAfterAttempt({ attempts: 1 }, { ok: false, error: "boom" }, NOW);
    const withIn = planAfterAttempt({ attempts: 1 }, { ok: false, error: "boom", failure: "transient" }, NOW);
    expect(withOut).toEqual(withIn);
  });

  it("success is unchanged", () => {
    expect(planAfterAttempt({ attempts: 2 }, { ok: true }, NOW)).toEqual({
      status: "sent", attempts: 3, next_retry_at: null, last_error: null,
    });
  });
});
