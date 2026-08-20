/**
 * Sweeper orchestration — the logic that turns claim/complete/fail into a truthful sweep.
 * The DB-side guarantees (leases, backoff, dead-letter, fairness) are proven against live
 * PostgreSQL in tests/integration/durable-inbound-processing.test.ts; this file covers the loop.
 */
import { describe, it, expect, vi } from "vitest";
import { sweepInbound, type SweepDeps, type SweepableEvent } from "@/events/inbound-sweeper";

const ev = (id: string): SweepableEvent => ({ id, company_id: "co-1", source: "whatsapp", attempts: 1 });

interface Calls {
  complete: unknown[][];
  fail: unknown[][];
}

function deps(over: Partial<SweepDeps> = {}): SweepDeps & { calls: Calls } {
  const calls: Calls = { complete: [], fail: [] };
  return {
    calls,
    claim: async () => [],
    complete: async (...args) => void calls.complete.push(args),
    fail: async (...args) => {
      calls.fail.push(args);
      return "retry_wait";
    },
    process: async () => ({ ok: true }),
    ...over,
  } as SweepDeps & { calls: Calls };
}

describe("inbound sweeper", () => {
  it("completes successfully processed events and reports no partial failure", async () => {
    const d = deps({ claim: async () => [ev("a"), ev("b")] });
    const r = await sweepInbound(d, { owner: "w1" });
    expect(r).toMatchObject({ claimed: 2, completed: 2, retryScheduled: 0, deadLettered: 0, partialFailure: false });
    expect(d.calls.complete).toHaveLength(2);
  });

  it("a processor that THROWS is a failure, never a silent success", async () => {
    const d = deps({
      claim: async () => [ev("a")],
      process: async () => {
        throw new Error("kaboom");
      },
    });
    const r = await sweepInbound(d, { owner: "w1" });
    expect(r.completed).toBe(0);
    expect(r.retryScheduled).toBe(1);
    expect(r.partialFailure).toBe(true);
    expect(d.calls.fail[0]?.[2]).toBe("processor_threw");
  });

  it("a non-retryable failure exhausts attempts immediately instead of burning the schedule", async () => {
    const d = deps({
      claim: async () => [ev("a")],
      process: async () => ({ ok: false, code: "no_processor", message: "unwired", retryable: false }),
      fail: async () => "dead_letter",
    });
    const r = await sweepInbound(d, { owner: "w1", maxAttempts: 5 });
    expect(r.deadLettered).toBe(1);
    expect(r.partialFailure).toBe(true);
  });

  it("a failure to RECORD completion is reported, not swallowed", async () => {
    // The work succeeded but the write did not. The lease expires and the row is retried, so
    // processing must be idempotent — and the sweep must not claim a clean run.
    const d = deps({
      claim: async () => [ev("a")],
      complete: async () => {
        throw new Error("db down");
      },
    });
    const r = await sweepInbound(d, { owner: "w1" });
    expect(r.completed).toBe(0);
    expect(r.partialFailure).toBe(true);
  });

  it("one bad event does not stop the rest of the batch", async () => {
    const process = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: "e", message: "bad" })
      .mockResolvedValue({ ok: true });
    const d = deps({ claim: async () => [ev("a"), ev("b"), ev("c")], process });
    const r = await sweepInbound(d, { owner: "w1" });
    expect(r.completed).toBe(2);
    expect(r.retryScheduled).toBe(1);
    expect(r.partialFailure).toBe(true);
  });

  it("an empty claim is a clean, honest no-op", async () => {
    const r = await sweepInbound(deps(), { owner: "w1" });
    expect(r).toMatchObject({ claimed: 0, completed: 0, partialFailure: false });
  });

  it("the lease owner is passed through to every completion and failure", async () => {
    const d = deps({ claim: async () => [ev("a")], process: async () => ({ ok: false, code: "e", message: "m" }) });
    await sweepInbound(d, { owner: "worker-42" });
    expect(d.calls.fail[0]?.[1]).toBe("worker-42");
  });
});
