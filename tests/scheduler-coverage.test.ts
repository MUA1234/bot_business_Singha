import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { DEFAULT_JOBS, UNSCHEDULED_CRON_ROUTES } from "@/lib/scheduler";

/**
 * Exactly one scheduler owns every recurring job (owner decisions 1 and 2).
 *
 * Two failures these tests exist to prevent, both of which had already happened:
 *
 *   1. A cron route with NOTHING driving it. `directive-escalation` shipped with no schedule on
 *      either host, and `inbound-sweeper` / `dispatch-drain` were declared only as Vercel crons
 *      while the Vercel origin served 402 — so on Railway the durable inbound pipeline was inert.
 *      A route that nobody calls looks identical to a route that runs and finds nothing to do.
 *
 *   2. The SAME job scheduled twice. `vercel.json` and `DEFAULT_JOBS` are separate files that
 *      cannot see each other, so a job present in both would double-run: two drains, two model
 *      sweeps, two digests.
 *
 * These are source-level checks, which is a real limit — they prove the declarations agree, not
 * that a tick fired. Scheduler startup behaviour is covered by the unit tests around
 * `schedulerStartupDecision`, and the live path by the staging runbook.
 */

const CRON_DIR = "src/app/api/cron";
const VERCEL_CONFIG = "vercel.json";

/** Every route directory under `src/app/api/cron` that actually has a handler. */
function cronRoutes(): string[] {
  return readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(`${CRON_DIR}/${name}/route.ts`))
    .sort();
}

const scheduled = new Set(DEFAULT_JOBS.map((j) => j.job));
const excluded = new Map(UNSCHEDULED_CRON_ROUTES.map((r) => [r.job, r.reason]));

describe("scheduler coverage — every cron route has exactly one owner", () => {
  it("every cron route is either scheduled or explicitly and reasonedly excluded", () => {
    const orphans = cronRoutes().filter((r) => !scheduled.has(r) && !excluded.has(r));
    expect(
      orphans,
      `these cron routes have nothing driving them: ${orphans.join(", ")}. Add them to ` +
        "DEFAULT_JOBS, or to UNSCHEDULED_CRON_ROUTES with the reason they must not run.",
    ).toEqual([]);
  });

  it("every scheduled job corresponds to a real route", () => {
    const routes = new Set(cronRoutes());
    const missing = [...scheduled].filter((j) => !routes.has(j));
    expect(missing, `scheduled jobs with no route: ${missing.join(", ")}`).toEqual([]);
  });

  it("no route is both scheduled and excluded", () => {
    const both = [...scheduled].filter((j) => excluded.has(j));
    expect(both).toEqual([]);
  });

  it("every exclusion states a reason, not just a name", () => {
    for (const [job, reason] of excluded) {
      expect(reason.length, `${job} is excluded without an explanation`).toBeGreaterThan(40);
    }
  });

  it("the four jobs heartbeat fans out to are all scheduled individually", () => {
    // heartbeat is excluded precisely because these are scheduled on their own. If one of them
    // were dropped from DEFAULT_JOBS, excluding heartbeat would silently stop it altogether.
    const src = readFileSync(`${CRON_DIR}/heartbeat/route.ts`, "utf8");
    const fannedOut = ["outbox", "follow-ups", "ai-monitor", "daily-digest"].filter((j) =>
      new RegExp(`"${j}"`).test(src),
    );
    expect(fannedOut.length, "heartbeat's fan-out list changed; re-check this test").toBe(4);
    for (const job of fannedOut) {
      expect(scheduled.has(job), `heartbeat fans out to ${job}, so ${job} must be scheduled itself`).toBe(true);
    }
  });
});

describe("Vercel declares no cron — Railway is the sole scheduler host", () => {
  const vercel = JSON.parse(readFileSync(VERCEL_CONFIG, "utf8")) as { crons?: { path: string }[] };

  it("vercel.json declares no cron schedules at all", () => {
    // Owner decision 2. Even one — heartbeat, historically — is a double-run waiting for the day
    // the Vercel origin is re-enabled, because heartbeat fans out to four jobs Railway already runs.
    expect(vercel.crons ?? []).toEqual([]);
  });

  it("no job could be driven by both hosts", () => {
    const vercelJobs = (vercel.crons ?? []).map((c) => c.path.replace(/^\/api\/cron\//, ""));
    const overlap = vercelJobs.filter((j) => scheduled.has(j));
    expect(overlap, `these jobs would run on BOTH hosts: ${overlap.join(", ")}`).toEqual([]);
  });
});

describe("cadences are deliberate", () => {
  it("no job runs more often than once a minute", () => {
    for (const j of DEFAULT_JOBS) {
      expect(j.everyMs, `${j.job} ticks faster than once a minute`).toBeGreaterThanOrEqual(60_000);
    }
  });

  it("the model-calling sweep is the least frequent of the recurring jobs", () => {
    // ai-monitor makes model calls; cost is a function of cadence. This pins the intent stated in
    // the scheduler's own comments so a later edit cannot quietly make spend hourly-or-worse.
    const aiMonitor = DEFAULT_JOBS.find((j) => j.job === "ai-monitor")!;
    const subMinuteWork = DEFAULT_JOBS.filter((j) => j.job !== "ai-monitor" && j.job !== "daily-digest");
    for (const j of subMinuteWork) {
      expect(aiMonitor.everyMs, `${j.job} must not run less often than ai-monitor`).toBeGreaterThanOrEqual(j.everyMs);
    }
  });
});
