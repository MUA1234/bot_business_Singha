import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_JOBS, jobSuppressed, partitionJobs, startScheduler, stopScheduler,
  type ScheduledJob,
} from "@/lib/scheduler";

/**
 * Model spend must be stoppable WITHOUT stopping message recovery.
 *
 * The problem this exists to solve is concrete. Production was found on 2026-09-10 running
 * `ai-monitor` hourly against a live `OPENAI_API_KEY`, incurring model spend nobody had
 * authorised. There was one switch — `IN_PROCESS_CRON` — and turning it off would also have
 * stopped `outbox`, the single recovery path for a failed customer message, plus both inbound
 * sweeps. Stopping unauthorised spend by silently dropping customer messages is not a fix, so
 * the honest answer at the time was "this needs an owner decision", which is a poor answer to a
 * problem that is really a missing control.
 *
 * The controls are deliberately fail-SAFE in one direction only: an unset or misspelled value
 * leaves a job RUNNING. Accidentally disabling recovery is worse than accidentally continuing to
 * spend — spend appears on a bill, whereas a message that was never retried appears to nobody.
 */

const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv => over as NodeJS.ProcessEnv;
const job = (name: string, kind?: "core" | "model"): ScheduledJob =>
  ({ job: name, everyMs: 60_000, ...(kind ? { kind } : {}) });

afterEach(() => stopScheduler());

describe("MODEL_JOBS=off stops model work and nothing else", () => {
  it("suppresses a model job", () => {
    expect(jobSuppressed(job("ai-monitor", "model"), env({ MODEL_JOBS: "off" }))).toBe("MODEL_JOBS=off");
  });

  it("leaves core jobs running — this is the whole point", () => {
    for (const name of ["outbox", "dispatch-drain", "inbound-sweeper", "follow-ups"]) {
      expect(jobSuppressed(job(name), env({ MODEL_JOBS: "off" })), `${name} must keep running`).toBeNull();
    }
  });

  it("applied to the REAL job table, stops ai-monitor and keeps recovery", () => {
    const { runnable, suppressed } = partitionJobs(DEFAULT_JOBS, env({ MODEL_JOBS: "off" }));
    expect(suppressed.map((s) => s.job)).toEqual(["ai-monitor"]);
    const names = runnable.map((j) => j.job);
    // The three that must never be collateral damage.
    expect(names).toContain("outbox");
    expect(names).toContain("dispatch-drain");
    expect(names).toContain("inbound-sweeper");
  });

  it("exactly one job in the real table is model-kind, so the control is precise", () => {
    const model = DEFAULT_JOBS.filter((j) => j.kind === "model").map((j) => j.job);
    expect(model).toEqual(["ai-monitor"]);
  });
});

describe("the controls fail SAFE — an unclear value keeps the job running", () => {
  it("does nothing when MODEL_JOBS is unset", () => {
    expect(partitionJobs(DEFAULT_JOBS, env({})).suppressed).toEqual([]);
  });

  it("does nothing for a value that is not exactly 'off'", () => {
    // "true", "0", "OFF", "disabled" all leave it running. A typo must not silently stop
    // recovery, and it must not silently stop spend either — either way the operator is told
    // nothing, so the safe default is the running one.
    for (const v of ["true", "0", "OFF", "disabled", "yes", ""]) {
      expect(partitionJobs(DEFAULT_JOBS, env({ MODEL_JOBS: v })).suppressed, `MODEL_JOBS=${v}`).toEqual([]);
    }
  });

  it("ignores an unknown job name in CRON_DISABLED_JOBS", () => {
    const { suppressed } = partitionJobs(DEFAULT_JOBS, env({ CRON_DISABLED_JOBS: "not-a-job,also-not" }));
    expect(suppressed).toEqual([]);
  });
});

describe("CRON_DISABLED_JOBS is surgical", () => {
  it("suppresses named jobs and only those", () => {
    const { runnable, suppressed } = partitionJobs(DEFAULT_JOBS, env({ CRON_DISABLED_JOBS: "daily-digest,ai-monitor" }));
    expect(suppressed.map((s) => s.job).sort()).toEqual(["ai-monitor", "daily-digest"]);
    expect(runnable.map((j) => j.job)).toContain("outbox");
  });

  it("tolerates whitespace and empty entries", () => {
    const { suppressed } = partitionJobs(DEFAULT_JOBS, env({ CRON_DISABLED_JOBS: " outbox , , follow-ups " }));
    expect(suppressed.map((s) => s.job).sort()).toEqual(["follow-ups", "outbox"]);
  });

  it("names WHICH control suppressed a job, so the log is actionable", () => {
    expect(jobSuppressed(job("outbox"), env({ CRON_DISABLED_JOBS: "outbox" }))).toBe("CRON_DISABLED_JOBS");
  });
});

describe("startScheduler reports only what it actually scheduled", () => {
  const base = { IN_PROCESS_CRON: "on", CRON_SECRET: "s3cret", PORT: "3000" };

  it("returns the runnable jobs, not the whole table", () => {
    const started = startScheduler(DEFAULT_JOBS, env({ ...base, MODEL_JOBS: "off" }));
    expect(started).not.toContain("ai-monitor");
    expect(started).toContain("outbox");
    // Returning the full list would tell the boot hook a suppressed job is running.
    expect(started.length).toBe(DEFAULT_JOBS.length - 1);
  });

  it("schedules everything when nothing is suppressed", () => {
    const started = startScheduler(DEFAULT_JOBS, env(base));
    expect(started.length).toBe(DEFAULT_JOBS.length);
  });

  it("still returns nothing when the scheduler itself is off", () => {
    expect(startScheduler(DEFAULT_JOBS, env({ CRON_SECRET: "s", PORT: "3000" }))).toEqual([]);
  });
});
