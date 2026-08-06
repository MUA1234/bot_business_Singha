import { describe, it, expect } from "vitest";
import { deriveIdempotencyKey, resolveIdempotencyKey } from "@/lib/idempotency";

describe("deriveIdempotencyKey", () => {
  it("is stable for the same parts (retry → same key)", () => {
    const a = deriveIdempotencyKey(["settle", "inv1", "100.00", "2026-08-15"]);
    const b = deriveIdempotencyKey(["settle", "inv1", "100.00", "2026-08-15"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^idem_/);
  });

  it("differs when any part differs (partial payments allowed)", () => {
    const a = deriveIdempotencyKey(["settle", "inv1", "100.00", "2026-08-15"]);
    const b = deriveIdempotencyKey(["settle", "inv1", "50.00", "2026-08-15"]);
    expect(a).not.toBe(b);
  });

  it("treats null/undefined parts stably", () => {
    expect(deriveIdempotencyKey(["x", null, undefined])).toBe(deriveIdempotencyKey(["x", null, undefined]));
  });
});

describe("resolveIdempotencyKey", () => {
  it("prefers a non-empty client token (blocks one form's double-submit)", () => {
    const withToken = resolveIdempotencyKey("tok-123", ["settle", "inv1", "100"]);
    const sameToken = resolveIdempotencyKey("tok-123", ["settle", "inv1", "999"]); // different params
    expect(withToken).toBe(sameToken); // token wins → same key regardless of params
  });

  it("falls back to the derived key when no token is given", () => {
    const derived = resolveIdempotencyKey("", ["settle", "inv1", "100"]);
    const same = deriveIdempotencyKey(["settle", "inv1", "100"]);
    expect(derived).toBe(same);
  });

  it("different tokens → different keys", () => {
    expect(resolveIdempotencyKey("a", ["x"])).not.toBe(resolveIdempotencyKey("b", ["x"]));
  });
});
