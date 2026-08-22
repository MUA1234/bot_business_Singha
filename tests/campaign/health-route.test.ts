/**
 * OPS-005 — /api/health reports the V3.1 feature-flag snapshot.
 *
 * The health endpoint is CRON_SECRET-gated and aggregates operational signals. This test proves
 * that a valid request receives a response carrying the default-OFF V3.1 flag snapshot, so an
 * operator can see which capability flags are enabled without exposing sensitive values.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const makeDb = () => {
  const result = { count: 0, error: null };
  const chain: any = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    is: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    then: (onFulfilled: any) => Promise.resolve(result).then(onFulfilled),
  };
  return chain;
};

vi.mock("@/lib/supabase/server", () => ({ supabaseAdmin: () => makeDb() }));

const req = (auth?: string) =>
  new Request("http://localhost/api/health", { headers: auth ? { authorization: auth } : {} });

let saved: string | undefined;
beforeEach(() => { saved = process.env.CRON_SECRET; });
afterEach(() => { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; });

describe("/api/health flag snapshot (OPS-005)", () => {
  it("rejects an unauthenticated request", async () => {
    process.env.CRON_SECRET = "health-secret";
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("includes the V3.1 flag snapshot in the response body", async () => {
    process.env.CRON_SECRET = "health-secret";
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(req("Bearer health-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.flags).toBeDefined();
    expect(typeof body.flags).toBe("object");
    // Every registered V3.1 flag appears in the snapshot with a boolean value.
    const { V3_1_FLAG_SPECS } = await import("@/config/flags");
    for (const spec of V3_1_FLAG_SPECS) {
      expect(typeof body.flags[spec.key]).toBe("boolean");
    }
    // Default environment: all flags are OFF.
    expect(Object.values(body.flags).some((v) => v === true)).toBe(false);
  });

  it("reflects a flag that is explicitly ON", async () => {
    process.env.CRON_SECRET = "health-secret";
    process.env.V3_1_TASK_DETECTION = "on";
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(req("Bearer health-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags.taskDetection).toBe(true);
    delete process.env.V3_1_TASK_DETECTION;
  });
});
