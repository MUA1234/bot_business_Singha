/**
 * R1 §3 — the scheduled routes are not public.
 *
 * These import and invoke the REAL route handlers. A scheduled worker that anyone can trigger is a
 * denial-of-service and a data-exposure surface, and "it's an internal path" is not a control. The
 * secret lives in the environment and is never committed; hosted scheduling stays an owner action.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ROUTES = [
  ["dispatch drain", () => import("@/app/api/cron/dispatch-drain/route")],
  ["inbound sweeper", () => import("@/app/api/cron/inbound-sweeper/route")],
] as const;

const req = (auth?: string) =>
  new Request("http://localhost/api/cron/x", { headers: auth ? { authorization: auth } : {} });

let saved: string | undefined;
beforeEach(() => { saved = process.env.CRON_SECRET; });
afterEach(() => { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; });

describe.each(ROUTES)("%s cron route authentication", (_name, load) => {
  it("refuses to run at all when no secret is configured — fail closed, not fail open", async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await load();
    const res = await GET(req("Bearer anything"));
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/not configured/i);
  });

  it("refuses an absent, empty, wrong or truncated bearer token", async () => {
    process.env.CRON_SECRET = "the-real-cron-secret-value";
    const { GET } = await load();
    for (const auth of [undefined, "", "Bearer ", "Bearer wrong", "Bearer the-real-cron-secret-valu", "the-real-cron-secret-value"]) {
      const res = await GET(req(auth));
      expect(res.status, JSON.stringify(auth)).toBe(401);
    }
  });

  it("a CORRECT token gets past authentication (it then fails on configuration, not on auth)", async () => {
    process.env.CRON_SECRET = "the-real-cron-secret-value";
    const { GET } = await load();
    // No Supabase is configured in a unit run, so the handler proceeds and then fails downstream.
    // What matters here is that it is NOT refused as unauthorised.
    let status: number | null = null;
    try {
      status = (await GET(req("Bearer the-real-cron-secret-value"))).status;
    } catch {
      status = null; // threw downstream of the auth check — also proof it got past it
    }
    expect(status).not.toBe(401);
    expect(status).not.toBe(500);
  });
});
