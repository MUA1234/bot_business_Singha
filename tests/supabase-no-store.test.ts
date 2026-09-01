/**
 * Regression test for a LIVE production defect found on 2026-09-01.
 *
 * Next.js patches the global `fetch` and stores GET responses in its Data Cache. Supabase
 * REST reads are GETs, so server-side queries were being served from that cache: after the
 * outbox row was durably delivered and the table held ZERO failed rows, `/api/health` kept
 * reporting `outboxFailed: 1` indefinitely (still wrong 90 seconds later, with cache-busted
 * URLs and a fresh `generatedAt` each call) and drove the overall level to `crit`.
 *
 * The same client sits under every dashboard read, so this was never health-only — it could
 * silently serve stale business data anywhere. The fix forces `no-store` on every request
 * both Supabase clients make; this test pins that behaviour.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { noStoreFetch } from "@/lib/supabase/server";

afterEach(() => vi.restoreAllMocks());

describe("supabase server clients — cache policy", () => {
  it("forces cache: no-store on every request", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await noStoreFetch("https://example.supabase.co/rest/v1/message_outbox?status=eq.failed");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
  });

  it("preserves caller-supplied headers and method while overriding cache", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await noStoreFetch("https://example.supabase.co/rest/v1/rpc/ledger_integrity_report", {
      method: "POST",
      headers: { apikey: "k" },
      // A caller asking for a cached read must still be overridden — business state is
      // never cacheable, and this is the exact mistake that produced the stale health read.
      cache: "force-cache",
    });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ apikey: "k" });
    expect(init.cache).toBe("no-store");
  });
});
