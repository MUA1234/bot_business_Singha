/**
 * Self-test for the outbound-network guard (R2B).
 *
 * A guard nobody checks is a guard that silently stops working. This asserts the guard is
 * ACTIVE when the suite runs under vitest.no-network.config.ts, and is skipped otherwise so the
 * ordinary `npm test` run stays unaffected.
 */
import { describe, it, expect } from "vitest";

const guarded = (globalThis as Record<string, unknown>).__NO_OUTBOUND_NETWORK__ === true;

describe.skipIf(!guarded)("the outbound-network guard is real", () => {
  it("refuses fetch", () => {
    expect(() => globalThis.fetch("https://example.invalid")).toThrow(/OUTBOUND NETWORK REFUSED/);
  });

  it("refuses raw http and https requests", async () => {
    const http = await import("node:http");
    const https = await import("node:https");
    expect(() => http.request("http://example.invalid")).toThrow(/OUTBOUND NETWORK REFUSED/);
    expect(() => https.get("https://example.invalid")).toThrow(/OUTBOUND NETWORK REFUSED/);
  });
});
