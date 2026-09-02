/**
 * Management cycle — feature flags, concurrency, idempotency and partial failure.
 *
 * Behavioural tests against the REAL `runManagementCycle`, with injected dependencies so
 * every branch is reachable deterministically and nothing touches a network or a database.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  runManagementCycle, kernelGloballyEnabled, REGISTERED_SOURCE_COUNT,
  type CycleDeps, type CycleSummary,
} from "@/kernel/cycle";
import { WORKER_ENABLED, runWorkerSweep, WorkerDisabledError } from "@/kernel/worker-boundary";

const CO_A = "11111111-1111-1111-1111-111111111111";
const CO_B = "22222222-2222-2222-2222-222222222222";
const NOW = new Date("2026-09-02T09:00:00.000Z");

interface Recorded { summaries: CycleSummary[]; persisted: string[]; locks: string[] }

function makeDeps(over: Partial<CycleDeps> = {}, rec: Recorded = { summaries: [], persisted: [], locks: [] }): CycleDeps {
  const held = new Set<string>();
  return {
    now: () => NOW,
    async isCompanyEnabled() { return true; },
    async tryLock(c) { if (held.has(c)) return false; held.add(c); rec.locks.push(`lock:${c}`); return true; },
    async releaseLock(c) { held.delete(c); rec.locks.push(`unlock:${c}`); },
    async authorityFor(companyId) {
      return { companyId, actorMembershipId: null, rules: [], policyPresent: true };
    },
    async findByIdentity() { return null; },
    async persist(o) { rec.persisted.push(o.identityKey); return `item-${rec.persisted.length}`; },
    async recordRun(s) { rec.summaries.push(s); },
    async loadFor(source) {
      if (source === "finance.receivable_overdue") {
        return [{ id: "inv-1", due_date: "2026-05-01", outstanding: "480000", currency: "LKR",
                  updated_at: "2026-09-01T00:00:00.000Z", status: "open" }];
      }
      if (source === "workforce.capacity_exception") {
        return [{ snapshotId: "s1", membershipId: "m1", utilizationPct: 135, status: "overloaded",
                  capturedAt: "2026-09-01T00:00:00.000Z" }];
      }
      if (source === "operations.task_exception") {
        return [{ id: "task-1", title: "t", status: "in_progress", dueDate: "2026-08-01",
                  lastCheckInAt: "2026-09-01T00:00:00.000Z", estimateHours: 4,
                  updatedAt: "2026-09-01T00:00:00.000Z" }];
      }
      if (source === "crm.followup_due") {
        return [{ id: "conv-1", last_inbound_at: "2026-09-01T09:00:00.000Z", last_outbound_at: null, status: "open" }];
      }
      // The seven R2A domains are list-shaped and are given an empty list here: this fixture
      // exercises the CYCLE, not those detectors, and handing them the system-health object
      // below would make them throw for a reason unrelated to what is under test.
      if (source !== "system.health_degraded") return [];
      return {
        oldestPendingOutboxMinutes: 240, failedOutboxCount: 3,
        ledger: { imbalancedJournals: 1, headerLineMismatch: 0, orphanedLines: 0, lockedPeriodPostings: 0 },
        providerFailures: 4, missingConfigKeys: ["OPENAI_API_KEY"],
        sampledAt: "2026-09-02T08:55:00.000Z",
      };
    },
    ...over,
  };
}

let savedFlag: string | undefined;
beforeEach(() => { savedFlag = process.env.MANAGEMENT_KERNEL; process.env.MANAGEMENT_KERNEL = "on"; });
afterEach(() => {
  if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
  else process.env.MANAGEMENT_KERNEL = savedFlag;
});

const run = (deps: CycleDeps, companyId = CO_A, trigger: "manual" | "test" = "test") =>
  runManagementCycle(deps, { companyId, actorId: null, trigger });

describe("the global flag is server-side and defaults OFF", () => {
  it("is OFF when the variable is absent", () => {
    expect(kernelGloballyEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("is OFF for any value other than exactly 'on'", () => {
    for (const v of ["", "off", "true", "1", "ON", "yes"]) {
      expect(kernelGloballyEnabled({ MANAGEMENT_KERNEL: v } as unknown as NodeJS.ProcessEnv), v).toBe(false);
    }
  });

  it("is ON only for exactly 'on'", () => {
    expect(kernelGloballyEnabled({ MANAGEMENT_KERNEL: "on" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("is NOT a browser-controlled flag — the name carries no NEXT_PUBLIC_ prefix", () => {
    // A NEXT_PUBLIC_ variable is inlined into the client bundle and can be set by whoever
    // builds it; this switch must be server-only.
    expect(kernelGloballyEnabled({ NEXT_PUBLIC_MANAGEMENT_KERNEL: "on" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("both switches are required", () => {
  it("GLOBAL FLAG ABSENT → disabled, and nothing is scanned or persisted", async () => {
    delete process.env.MANAGEMENT_KERNEL;
    const rec: Recorded = { summaries: [], persisted: [], locks: [] };
    const s = await run(makeDeps({}, rec));
    expect(s.status).toBe("skipped_disabled");
    expect(rec.persisted).toEqual([]);
    expect(rec.locks).toEqual([]); // no lock is even taken
  });

  it("GLOBAL FLAG FALSE → disabled", async () => {
    process.env.MANAGEMENT_KERNEL = "off";
    expect((await run(makeDeps())).status).toBe("skipped_disabled");
  });

  it("COMPANY FLAG ABSENT/FALSE → disabled, and no detector work happens", async () => {
    const rec: Recorded = { summaries: [], persisted: [], locks: [] };
    let loaded = 0;
    const s = await run(makeDeps({
      async isCompanyEnabled() { return false; },
      async loadFor() { loaded++; return []; },
    }, rec));
    expect(s.status).toBe("skipped_disabled");
    expect(s.failureReason).toMatch(/company enablement/i);
    expect(loaded).toBe(0);
    expect(rec.persisted).toEqual([]);
  });

  it("DISABLED writes NOTHING — not even a run record", async () => {
    // CORRECTED. This previously asserted that a disabled cycle still recorded a run. The
    // owner's instruction is that disabled means zero database writes: recording a run row
    // would be a write performed by a cycle that never ran, and would let a reader believe
    // the business had been observed.
    delete process.env.MANAGEMENT_KERNEL;
    const rec: Recorded = { summaries: [], persisted: [], locks: [] };
    const s = await run(makeDeps({}, rec));
    expect(s.status).toBe("skipped_disabled");
    expect(rec.summaries).toEqual([]);   // recordRun was never called
    expect(rec.persisted).toEqual([]);
    expect(rec.locks).toEqual([]);
  });

  it("the DISTINCTION survives in the returned status, not in a database write", async () => {
    // "kernel disabled" and "nothing needed attention" must stay tellable apart.
    delete process.env.MANAGEMENT_KERNEL;
    const globalOff = await run(makeDeps());
    expect(globalOff.status).toBe("skipped_disabled");
    expect(globalOff.failureReason).toMatch(/global flag/i);

    process.env.MANAGEMENT_KERNEL = "on";
    const companyOff = await run(makeDeps({ async isCompanyEnabled() { return false; } }));
    expect(companyOff.status).toBe("skipped_disabled");
    expect(companyOff.failureReason).toMatch(/company enablement/i);

    // "Observed everything, found nothing": empty lists for the four list-shaped sources and
    // a HEALTHY system signal (the system adapter takes a shaped object, not a list — handing
    // it an array starves it and the cycle goes partial for the wrong reason).
    const ran = await run(makeDeps({
      async loadFor(source) {
        if (source === "system.health_degraded") {
          return {
            oldestPendingOutboxMinutes: 0, failedOutboxCount: 0,
            ledger: { imbalancedJournals: 0, headerLineMismatch: 0, orphanedLines: 0, lockedPeriodPostings: 0 },
            providerFailures: 0, missingConfigKeys: [], sampledAt: "2026-09-02T08:55:00.000Z",
          };
        }
        return [];
      },
    }));
    expect(ran.status).toBe("completed");   // observed everything, found nothing
    expect(ran.itemsCreated).toBe(0);

    // Three different, distinguishable outcomes.
    expect(new Set([globalOff.failureReason, companyOff.failureReason, ran.failureReason]).size).toBe(3);
  });

  it("ONE COMPANY ENABLED, ANOTHER DISABLED → correctly isolated", async () => {
    const rec: Recorded = { summaries: [], persisted: [], locks: [] };
    const deps = makeDeps({ async isCompanyEnabled(c) { return c === CO_A; } }, rec);
    const a = await run(deps, CO_A);
    const b = await run(deps, CO_B);
    expect(a.status).toBe("completed");
    expect(b.status).toBe("skipped_disabled");
    expect(rec.persisted.every((k) => k.startsWith(CO_A))).toBe(true);
  });

  it("DISABLING between cycles prevents the NEXT cycle", async () => {
    let enabled = true;
    const deps = makeDeps({ async isCompanyEnabled() { return enabled; } });
    expect((await run(deps)).status).toBe("completed");
    enabled = false;
    expect((await run(deps)).status).toBe("skipped_disabled");
  });
});

describe("a complete cycle", () => {
  it("observes every registered source and creates one item per observation", async () => {
    const rec: Recorded = { summaries: [], persisted: [], locks: [] };
    const s = await run(makeDeps({}, rec));
    expect(s.status).toBe("completed");
    expect(s.sourcesRegistered).toBe(REGISTERED_SOURCE_COUNT);
    expect(s.sourcesSucceeded).toBe(REGISTERED_SOURCE_COUNT);
    expect(s.sourcesFailed).toBe(0);
    expect(s.itemsCreated).toBeGreaterThanOrEqual(5);
    expect(s.unobservedDepartments).toEqual([]);
  });

  it("carries ONE correlation id for the whole cycle", async () => {
    const s = await run(makeDeps());
    expect(s.correlationId).toMatch(/[0-9a-f-]{36}/);
  });

  it("ALWAYS releases the lock, including after a failure", async () => {
    const rec: Recorded = { summaries: [], persisted: [], locks: [] };
    await run(makeDeps({ async authorityFor() { throw new Error("boom"); } }, rec));
    expect(rec.locks.filter((l) => l.startsWith("unlock:"))).toHaveLength(1);
  });
});

describe("concurrency and idempotency", () => {
  it("TWO SIMULTANEOUS CYCLES for ONE company: the second is skipped_locked", async () => {
    const rec: Recorded = { summaries: [], persisted: [], locks: [] };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Hold the FIRST cycle open inside finance, but let every other source load normally —
    // otherwise the fixture starves the system adapter and the cycle goes partial for a
    // reason unrelated to locking.
    const base = makeDeps();
    const deps = makeDeps({
      async loadFor(source, companyId) {
        if (source === "finance.receivable_overdue") await gate;
        return base.loadFor(source, companyId);
      },
    }, rec);

    const first = run(deps, CO_A);
    await new Promise((r) => setTimeout(r, 10));
    const second = await run(deps, CO_A);
    expect(second.status).toBe("skipped_locked");
    release();
    expect((await first).status).toBe("completed");
  });

  it("CYCLES FOR TWO DIFFERENT COMPANIES do not block each other", async () => {
    const deps = makeDeps();
    const [a, b] = await Promise.all([run(deps, CO_A), run(deps, CO_B)]);
    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");
  });

  it("DUPLICATE observations reuse rather than create on a REPEATED cycle", async () => {
    const rec: Recorded = { summaries: [], persisted: [], locks: [] };
    const seen = new Map<string, { id: string; state: string }>();
    const deps = makeDeps({
      async findByIdentity(_c, key) { return seen.get(key) ?? null; },
      async persist(o) { seen.set(o.identityKey, { id: `i-${seen.size}`, state: "observed" }); rec.persisted.push(o.identityKey); return `i-${seen.size}`; },
    }, rec);

    const first = await run(deps);
    const created = first.itemsCreated;
    expect(created).toBeGreaterThan(0);

    const second = await run(deps);
    expect(second.itemsCreated).toBe(0);
    expect(second.itemsReused + second.observationsSkipped).toBeGreaterThanOrEqual(created);
    expect(rec.persisted).toHaveLength(created); // REPEATED INVOCATION persists nothing new
  });

  it("RETRY AFTER ROLLBACK does not double-create", async () => {
    const rec: Recorded = { summaries: [], persisted: [], locks: [] };
    let fail = true;
    const seen = new Map<string, { id: string; state: string }>();
    const deps = makeDeps({
      async findByIdentity(_c, key) { return seen.get(key) ?? null; },
      async persist(o) {
        if (fail) throw new Error("rolled back");
        seen.set(o.identityKey, { id: "i", state: "observed" });
        rec.persisted.push(o.identityKey);
        return "i";
      },
    }, rec);

    const failed = await run(deps);
    expect(failed.status).toBe("partial");   // persistence failures are never a clean sweep
    expect(rec.persisted).toEqual([]);

    fail = false;
    const retried = await run(deps);
    expect(retried.itemsCreated).toBeGreaterThan(0);
    expect(new Set(rec.persisted).size).toBe(rec.persisted.length); // no duplicates
  });
});

describe("partial failure is never a silent success", () => {
  it("ONE FAILING ADAPTER makes the cycle PARTIAL and names the department", async () => {
    const s = await run(makeDeps({
      async loadFor(source, c) {
        if (source === "finance.receivable_overdue") throw new Error("connection refused");
        return makeDeps().loadFor(source, c);
      },
    }));
    expect(s.status).toBe("partial");
    expect(s.sourcesFailed).toBe(1);
    expect(s.unobservedDepartments).toContain("finance");
    expect(s.failureReason).toMatch(/unobserved: finance/);
  });

  it("the OTHER four departments still complete", async () => {
    const s = await run(makeDeps({
      async loadFor(source, c) {
        if (source === "finance.receivable_overdue") throw new Error("down");
        return makeDeps().loadFor(source, c);
      },
    }));
    expect(s.sourcesSucceeded).toBe(REGISTERED_SOURCE_COUNT - 1);
    expect(s.itemsCreated).toBeGreaterThan(0);
  });

  it("an ADAPTER TIMEOUT is a failure, not an empty result", async () => {
    const s = await run(makeDeps({
      async loadFor(source) {
        if (source === "crm.followup_due") throw new Error("timeout after 5000ms");
        return [];
      },
    }));
    expect(s.status).toBe("partial");
    expect(s.unobservedDepartments).toContain("crm");
  });

  it("MALFORMED adapter output (not an array) is a failure, not an empty result", async () => {
    const s = await run(makeDeps({
      async loadFor(source) { return source === "operations.task_exception" ? ("nope" as never) : []; },
    }));
    // The operations detector receives a non-array and throws inside the adapter.
    expect(s.status).toBe("partial");
    expect(s.unobservedDepartments).toContain("operations");
  });

  it("STALE source data is skipped, not queued", async () => {
    const s = await run(makeDeps({
      async loadFor(source) {
        if (source !== "finance.receivable_overdue") return [];
        // Evidence far in the past ⇒ freshness `stale`.
        return [{ id: "inv-old", due_date: "2020-01-01", outstanding: "1000", currency: "LKR",
                  updated_at: "2020-01-02T00:00:00.000Z", status: "open" }];
      },
    }));
    expect(s.observationsSkipped).toBeGreaterThan(0);
    expect(s.itemsCreated).toBe(0);
  });

  it("a wholly failing cycle reports FAILED, never completed", async () => {
    const s = await run(makeDeps({ async authorityFor() { throw new Error("no policy service"); } }));
    expect(s.status).toBe("failed");
    expect(s.failureReason).toMatch(/no policy service/);
  });

  it("an enablement-check failure is FAILED, not silently disabled", async () => {
    const s = await run(makeDeps({ async isCompanyEnabled() { throw new Error("db down"); } }));
    expect(s.status).toBe("failed");
    expect(s.failureReason).toMatch(/enablement check failed/);
  });

  it("a recordRun failure does not mask the cycle's own outcome", async () => {
    const s = await run(makeDeps({ async recordRun() { throw new Error("ledger unavailable"); } }));
    expect(s.status).toBe("completed");
  });
});

describe("the future worker boundary is defined but disabled", () => {
  it("is hard-coded off — no environment variable can enable it", () => {
    expect(WORKER_ENABLED).toBe(false);
  });

  it("REFUSES to run", async () => {
    await expect(
      runWorkerSweep({ ...makeDeps(), async enumerateEnabledCompanies() { return [CO_A]; } }),
    ).rejects.toThrow(WorkerDisabledError);
  });

  it("takes no company-id parameter, so it cannot be aimed at an unenabled company", () => {
    // The signature accepts deps only; scope comes from the server's own enablement table.
    expect(runWorkerSweep.length).toBe(1);
  });
});
