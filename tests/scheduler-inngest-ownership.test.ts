import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_JOBS,
  INNGEST_SCHEDULER_VAR,
  inngestJobSuppressed,
  inngestSchedulingEnabled,
  jobSuppressed,
} from "@/lib/scheduler";

/**
 * A THIRD scheduler host existed and nobody had counted it.
 *
 * `tests/scheduler-coverage.test.ts` proves Railway's `DEFAULT_JOBS` and `vercel.json` cannot
 * both drive the same job. It compares exactly two declaration sites — and there were three.
 * `src/inngest/functions.ts` declares five cron-triggered functions of its own, four of which
 * name work Railway already owns:
 *
 *   | Inngest             | cadence   | Railway job    | cadence |
 *   |---------------------|-----------|----------------|---------|
 *   | `outbox-sweep`      | every 2m  | `outbox`       | 1 min   |
 *   | `task-follow-ups`   | every 15m | `follow-ups`   | 15 min  |
 *   | `ai-manager-monitor`| every 10m | `ai-monitor`   | 1 HOUR  |
 *   | `management-digest` | 07:00     | `daily-digest` | 24 hr   |
 *
 * The outbox duplication is wasteful — the drain leases rows, so the second drain finds nothing.
 * `ai-manager-monitor` is the dangerous one: it is the only job that SPENDS MONEY on a model,
 * Railway's copy honours `MODEL_JOBS=off`, and the Inngest copy honoured nothing and ran SIX
 * TIMES more often. Setting `MODEL_JOBS=off` would have read as "model spend stopped" while
 * spend continued every ten minutes on the other host.
 *
 * So these tests assert two things that must both hold:
 *
 *   1. Source-level — every cron-triggered Inngest function passes through `scheduledGuard`.
 *      This is a text check, which is a real limit: it proves the guard is in the call path, not
 *      that a tick was refused. (2) covers the decision itself.
 *   2. Behavioural — `inngestJobSuppressed` refuses under the shipped default, and under
 *      `MODEL_JOBS=off` refuses the model job WITHOUT refusing the outbox and recovery jobs.
 */

/** Same shape the other scheduler tests use: a partial env, typed as one. */
const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv => over as NodeJS.ProcessEnv;

const SRC = "src/inngest/functions.ts";
const source = readFileSync(SRC, "utf8");

/** Each `{ cron: ... }` declaration, with the function id above it and the body below it. */
function inngestCronFunctions(): { id: string; cron: string; body: string }[] {
  const lines = source.split(/\r?\n/);
  const at = (k: number): string => lines[k] ?? "";
  const out: { id: string; cron: string; body: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cron = /\{\s*cron:\s*"([^"]+)"\s*\}/.exec(at(i));
    if (!cron) continue;
    // The id is declared on a line just above; the body runs until the closing `);`.
    let id = "";
    for (let k = i - 1; k >= 0 && k > i - 6 && !id; k--) {
      const m = /\{\s*id:\s*"([^"]+)"/.exec(at(k));
      if (m) id = m[1] ?? "";
    }
    const body: string[] = [];
    for (let k = i + 1; k < lines.length && !/^\);/.test(at(k)); k++) body.push(at(k));
    out.push({ id, cron: cron[1] ?? "", body: body.join("\n") });
  }
  return out;
}

const cronFns = inngestCronFunctions();

describe("Inngest is a scheduler host and is counted as one", () => {
  it("finds the cron-triggered functions at all", () => {
    // If this drops to zero the rest of the file passes vacuously, which is how a source-level
    // check quietly stops checking.
    expect(cronFns.length, `no { cron: ... } declarations found in ${SRC}`).toBeGreaterThanOrEqual(5);
    for (const fn of cronFns) expect(fn.id, `a cron function in ${SRC} has no id`).not.toBe("");
  });

  it("every cron-triggered Inngest function passes through scheduledGuard", () => {
    const unguarded = cronFns.filter((fn) => !/scheduledGuard\(\s*"[^"]+"\s*\)/.test(fn.body));
    expect(
      unguarded.map((f) => f.id),
      "these Inngest cron functions run unconditionally, duplicating whatever Railway already " +
        "schedules: " + unguarded.map((f) => f.id).join(", "),
    ).toEqual([]);
  });

  it("each guard names a job, and a job that Railway also knows about is spelled its way", () => {
    const railway = new Set(DEFAULT_JOBS.map((j) => j.job));
    for (const fn of cronFns) {
      const named = /scheduledGuard\(\s*"([^"]+)"\s*\)/.exec(fn.body)?.[1];
      expect(named, `${fn.id} guards without naming a job`).toBeTruthy();
      // Not every Inngest cron has a Railway counterpart (health-check has none). The ones that
      // do must use the SAME name, or `MODEL_JOBS` / `CRON_DISABLED_JOBS` would miss them.
      if (fn.id.includes("outbox")) expect(railway.has(named!)).toBe(true);
      if (fn.id.includes("monitor")) expect(named).toBe("ai-monitor");
      if (fn.id.includes("digest")) expect(named).toBe("daily-digest");
      if (fn.id.includes("follow-ups")) expect(named).toBe("follow-ups");
    }
  });
});

describe("exactly one owner per job, decided at runtime and not only in the source", () => {
  const railwayOn = env({ IN_PROCESS_CRON: "on" });

  it("Inngest schedules nothing under the shipped default", () => {
    expect(inngestSchedulingEnabled(env({}))).toBe(false);
    for (const fn of cronFns) {
      const job = /scheduledGuard\(\s*"([^"]+)"\s*\)/.exec(fn.body)?.[1] ?? "";
      expect(job, `${fn.id} guards without naming a job`).not.toBe("");
      expect(inngestJobSuppressed(job, env({}))).toBeTruthy();
    }
  });

  it("with Railway scheduling, every duplicated job has exactly one live owner", () => {
    // The count that matters: for each job, how many hosts would actually fire it.
    for (const job of ["outbox", "follow-ups", "ai-monitor", "daily-digest"]) {
      const declared = DEFAULT_JOBS.find((j) => j.job === job)!;
      const owners =
        (jobSuppressed(declared, railwayOn) === null ? 1 : 0) +
        (inngestJobSuppressed(job, railwayOn) === null ? 1 : 0);
      expect(owners, `${job} has ${owners} live schedulers, not 1`).toBe(1);
    }
  });

  it("turning Inngest on is an explicit, deliberate act", () => {
    expect(inngestSchedulingEnabled(env({ [INNGEST_SCHEDULER_VAR]: "true" }))).toBe(false);
    expect(inngestSchedulingEnabled(env({ [INNGEST_SCHEDULER_VAR]: "ON" }))).toBe(false);
    expect(inngestSchedulingEnabled(env({ [INNGEST_SCHEDULER_VAR]: "on" }))).toBe(true);
  });
});

describe("MODEL_JOBS=off stops model spend on BOTH hosts, and stops nothing else", () => {
  const bothOn = env({ IN_PROCESS_CRON: "on", [INNGEST_SCHEDULER_VAR]: "on", MODEL_JOBS: "off" });

  it("the model job is refused on the Inngest path too", () => {
    // The defect this whole file exists for: before the guard, this returned null and the
    // */10-minute model sweep kept spending with MODEL_JOBS=off set.
    expect(inngestJobSuppressed("ai-monitor", bothOn)).toBe("MODEL_JOBS=off");
    expect(jobSuppressed(DEFAULT_JOBS.find((j) => j.job === "ai-monitor")!, bothOn)).toBe("MODEL_JOBS=off");
  });

  it("the outbox and the recovery jobs keep running", () => {
    // Disabling model spend must not disable delivery or inbound recovery — otherwise the only
    // way to stop spend is to stop the product.
    for (const job of ["outbox", "dispatch-drain", "inbound-sweeper", "directive-escalation", "management-cycle"]) {
      const declared = DEFAULT_JOBS.find((j) => j.job === job);
      expect(declared, `${job} is no longer a declared job; re-check this test`).toBeTruthy();
      expect(jobSuppressed(declared!, bothOn), `${job} was suppressed by MODEL_JOBS=off`).toBeNull();
    }
    expect(inngestJobSuppressed("outbox", bothOn)).toBeNull();
  });

  it("exactly one job in the whole schedule is declared as model spend", () => {
    const model = DEFAULT_JOBS.filter((j) => j.kind === "model").map((j) => j.job);
    expect(model).toEqual(["ai-monitor"]);
  });
});
