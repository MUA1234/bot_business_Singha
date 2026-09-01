/**
 * In-process job scheduler (src/lib/scheduler.ts).
 *
 * Context: on Vercel's Hobby plan only ONE daily cron was scheduled, so the outbox drain —
 * the only recovery path for a failed provider send — effectively never ran. A real customer
 * reply sat at `status=failed` on 2026-09-01 until an operator drained it by hand. Railway
 * runs a persistent process, so the scheduler lives in it.
 *
 * These tests pin the SAFETY properties, because a scheduler that misbehaves is worse than
 * none: it must stay off by default, refuse to start without a secret, never double-schedule,
 * and never stack a slow job on top of itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  schedulerEnabled,
  schedulerStartupDecision,
  startScheduler,
  stopScheduler,
  DEFAULT_JOBS,
  MINUTE,
  HOUR,
} from "@/lib/scheduler";

const ON = { IN_PROCESS_CRON: "on", CRON_SECRET: "s3cret", PORT: "8080" } as unknown as NodeJS.ProcessEnv;

afterEach(() => {
  stopScheduler();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("scheduler — activation", () => {
  it("is OFF unless explicitly enabled", () => {
    expect(schedulerEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(schedulerEnabled({ IN_PROCESS_CRON: "true" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(schedulerEnabled({ IN_PROCESS_CRON: "on" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("refuses to start without a CRON_SECRET rather than looping on 401s", () => {
    const d = schedulerStartupDecision({ IN_PROCESS_CRON: "on" } as unknown as NodeJS.ProcessEnv);
    expect(d).toEqual({ start: false, reason: "no_cron_secret" });
  });

  it("calls itself on loopback, so it never depends on the public domain", () => {
    const d = schedulerStartupDecision(ON);
    expect(d).toEqual({ start: true, baseUrl: "http://127.0.0.1:8080" });
  });

  it("defaults the port and rejects a malformed one", () => {
    expect(schedulerStartupDecision({ IN_PROCESS_CRON: "on", CRON_SECRET: "s" } as unknown as NodeJS.ProcessEnv))
      .toEqual({ start: true, baseUrl: "http://127.0.0.1:3000" });
    expect(schedulerStartupDecision({ ...ON, PORT: "nope" } as unknown as NodeJS.ProcessEnv))
      .toEqual({ start: false, reason: "bad_port" });
  });

  it("schedules nothing when disabled — Vercel and CI are unaffected", () => {
    expect(startScheduler(DEFAULT_JOBS, {} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("never double-schedules across repeated boots", () => {
    expect(startScheduler(DEFAULT_JOBS, ON).length).toBe(DEFAULT_JOBS.length);
    expect(startScheduler(DEFAULT_JOBS, ON)).toEqual([]); // second boot is a no-op
  });
});

describe("scheduler — cadence policy", () => {
  it("drains the outbox every minute — it is the only delivery-recovery path", () => {
    expect(DEFAULT_JOBS.find((j) => j.job === "outbox")?.everyMs).toBe(MINUTE);
  });

  it("runs the model-calling job least often of the recurring three (AI cost control)", () => {
    const ai = DEFAULT_JOBS.find((j) => j.job === "ai-monitor")!.everyMs;
    const followUps = DEFAULT_JOBS.find((j) => j.job === "follow-ups")!.everyMs;
    const outbox = DEFAULT_JOBS.find((j) => j.job === "outbox")!.everyMs;
    expect(ai).toBeGreaterThan(followUps);
    expect(followUps).toBeGreaterThan(outbox);
    expect(ai).toBe(HOUR);
  });

  it("keeps the digest daily so it cannot spam notifications", () => {
    expect(DEFAULT_JOBS.find((j) => j.job === "daily-digest")?.everyMs).toBe(24 * HOUR);
  });
});

describe("scheduler — runtime behaviour", () => {
  beforeEach(() => vi.useFakeTimers());

  it("calls the job endpoint with the cron secret", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    startScheduler([{ job: "outbox", everyMs: 1000 }], ON);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/api/cron/outbox",
      expect.objectContaining({ headers: { authorization: "Bearer s3cret" } }),
    );
  });

  it("does not stack a slow job on top of itself", async () => {
    let resolveIt: (r: Response) => void = () => {};
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise<Response>((r) => { resolveIt = r; }));
    startScheduler([{ job: "outbox", everyMs: 1000 }], ON);

    await vi.advanceTimersByTimeAsync(1000); // tick 1 — starts, never settles
    await vi.advanceTimersByTimeAsync(3000); // ticks 2-4 — must all be skipped
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveIt(new Response("{}", { status: 200 }));
    await vi.advanceTimersByTimeAsync(1000); // now free again
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("survives a throwing job — one bad tick must not kill the loop", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(new Response("{}", { status: 200 }));
    startScheduler([{ job: "outbox", everyMs: 1000 }], ON);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
