/**
 * In-process job scheduler for a LONG-LIVED server (Railway).
 *
 * Why this exists. The cron endpoints (`/api/cron/*`) were written for Vercel, whose Hobby
 * plan allows two schedules at daily granularity — so `vercel.json` scheduled ONE job
 * (`heartbeat`, once a day) and the outbox drain effectively never ran on its own. That is a
 * real hole, not a cosmetic one: `drainOutbox` is the ONLY recovery path for a message whose
 * provider send failed. Observed live on 2026-09-01, a customer reply sat in `message_outbox`
 * at `status=failed` and was delivered only because an operator triggered the drain by hand.
 *
 * Railway runs a persistent process, so the scheduler can simply live inside it — no extra
 * service, no extra cost, and no platform cron limits. It calls the SAME HTTP endpoints with
 * the same `CRON_SECRET`, so every job keeps its existing authorisation and logic; nothing is
 * duplicated or bypassed.
 *
 * Safety properties:
 *   - OFF by default (`IN_PROCESS_CRON=on` to enable), so Vercel, CI and tests are unaffected
 *     and the two deployments never double-run the same job.
 *   - One run of a job at a time. A slow drain does not stack up behind itself.
 *   - Failures are logged and swallowed — a scheduler that dies takes every job with it.
 *   - The work itself is already concurrency-safe: `claim_outbox_batch` leases rows with
 *     FOR UPDATE SKIP LOCKED, so even a second instance could not double-send.
 */
import { log } from "@/lib/log";

/** A scheduled job: which cron endpoint to call, and how often. */
/**
 * What a job COSTS to run, which is what decides whether it can be switched off on its own.
 *
 *   `core`  — bounded database work. Turning it off loses recovery: `outbox` is the only path
 *             that redelivers a failed customer message, and `dispatch-drain` /
 *             `inbound-sweeper` are the only paths that retry a failed inbound one.
 *   `model` — makes paid model calls. Spend is a function of cadence.
 */
export type JobKind = "core" | "model";

export interface ScheduledJob {
  readonly job: string;
  readonly everyMs: number;
  /** Defaults to `core`; only the model-calling jobs declare otherwise. */
  readonly kind?: JobKind;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/**
 * Cadences chosen by what each job costs and how quickly its absence hurts.
 *   - `outbox`      — the delivery-recovery sweep. Cheap (a bounded claim), and a stuck
 *                     customer reply is the most visible possible failure. Every minute.
 *   - `follow-ups`  — bounded DB work, no model calls. Every 15 minutes.
 *   - `ai-monitor`  — makes MODEL CALLS, so it is deliberately the least frequent of the
 *                     three; hourly keeps AI spend predictable (the route is batch-bounded too).
 *   - `daily-digest`— a once-a-day summary; running it more often would spam notifications.
 */
export const DEFAULT_JOBS: readonly ScheduledJob[] = [
  { job: "outbox", everyMs: 1 * MINUTE },
  { job: "follow-ups", everyMs: 15 * MINUTE },
  { job: "ai-monitor", everyMs: 1 * HOUR, kind: "model" },
  { job: "daily-digest", everyMs: 24 * HOUR },

  // ── Release 1: Railway is the SOLE scheduler host (owner decisions 1 and 2) ──────────
  //
  // These three routes existed with nothing driving them here. Two were declared only as
  // Vercel crons, and the Vercel origin has been serving 402 since at least 2026-09-01 — so
  // on Railway, with Vercel disabled, NOTHING swept inbound messages or drained dispatch.
  // The durable inbound processing that migration 0070 exists to provide was inert.
  //
  // `dispatch-drain` — decides what an inbound message IS. Until it runs, a failed dispatch
  //   is recovered only if the provider redelivers, and Meta stops retrying after a bounded
  //   period. Cheapest of the three and the closest to the customer: every 5 minutes, the
  //   cadence its Vercel declaration already used.
  { job: "dispatch-drain", everyMs: 5 * MINUTE },
  // `inbound-sweeper` — drives the CONSUMER lifecycle: bounded retry, backoff, dead-letter.
  //   Its own backoff decides when a row is eligible, so a tighter sweep would not retry
  //   anything sooner. Every 10 minutes, as declared for Vercel.
  { job: "inbound-sweeper", everyMs: 10 * MINUTE },
  // `directive-escalation` — a governance sweep over directives past their response window.
  //   NOTHING scheduled it on either host. Bounded DB work, no model calls, and the windows
  //   it enforces are measured in hours, so hourly is responsive without being noisy.
  { job: "directive-escalation", everyMs: 1 * HOUR },
  // `management-cycle` — the loop's own heartbeat. Without it an item sits in `observed`
  //   until a person presses a button on `/api/management/cycle`. Every 15 minutes: the
  //   cycle is row-budgeted per company and the signals it observes (overdue receivables,
  //   stalled tasks) change on the scale of hours, not seconds. It is a no-op that reports
  //   `disabled` unless the kernel is switched on, so this costs nothing until it is.
  { job: "management-cycle", everyMs: 15 * MINUTE },
];

/**
 * Cron routes that must NOT be scheduled here, and why.
 *
 * `scheduler-coverage.test.ts` requires every `src/app/api/cron/*` route to be either in
 * `DEFAULT_JOBS` or on this list, so a new route cannot be added and silently left with
 * nothing driving it — which is exactly how `directive-escalation` came to exist unscheduled.
 */
export const UNSCHEDULED_CRON_ROUTES: readonly { readonly job: string; readonly reason: string }[] = [
  {
    job: "heartbeat",
    reason:
      "A FAN-OUT SHIM for Vercel's Hobby cron limits: it calls outbox, follow-ups, ai-monitor " +
      "and daily-digest over internal HTTP. All four are scheduled individually above, so " +
      "scheduling heartbeat as well would run each of them TWICE per tick. It stays reachable " +
      "for a Vercel preview and for manual use, and is deliberately never scheduled here.",
  },
];

/** True only when an in-process scheduler is wanted (a persistent server). */
export function schedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IN_PROCESS_CRON === "on";
}

/**
 * Which jobs are suppressed, and why they can be suppressed SEPARATELY.
 *
 * Until this existed there was one switch, `IN_PROCESS_CRON`, and it was all-or-nothing. That
 * made a real operational problem unanswerable: production was found on 2026-09-10 running
 * `ai-monitor` hourly against a live `OPENAI_API_KEY`, incurring model spend nobody had
 * authorised — and the only way to stop it was to turn the scheduler off, which would ALSO have
 * stopped `outbox` (the single recovery path for a failed customer message) and the two inbound
 * sweeps. Stopping unauthorised spend by silently dropping customer messages is not a fix.
 *
 * Two controls, both fail-SAFE in the sense that matters here — an unset or misspelled value
 * leaves the job running, because the failure mode of accidentally disabling recovery is worse
 * than the failure mode of accidentally continuing to spend. Spend is visible on a bill;
 * a message that was never retried is visible to nobody.
 *
 *   `MODEL_JOBS=off`           — suppresses every job declared `kind: "model"`.
 *   `CRON_DISABLED_JOBS=a,b`   — suppresses jobs by name, for surgical control.
 *
 * Neither can suppress a job that does not exist, and `suppressedJobs` reports what it did so
 * the boot log says which jobs are NOT running rather than leaving that to be inferred.
 */
export function jobSuppressed(job: ScheduledJob, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.MODEL_JOBS === "off" && job.kind === "model") {
    return "MODEL_JOBS=off";
  }
  const named = (env.CRON_DISABLED_JOBS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (named.includes(job.job)) return "CRON_DISABLED_JOBS";
  return null;
}

/**
 * Is the INNGEST scheduler allowed to run scheduled work?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────
 *
 * `src/inngest/functions.ts` declares five cron-triggered functions — outbox every 2 minutes,
 * follow-ups every 15, the AI monitor every 10, the digest daily, a health check every 30. The
 * in-process scheduler declares its own `outbox`, `follow-ups`, `ai-monitor` and `daily-digest`.
 * Four of them are the same job under two owners.
 *
 * With both live, each of those jobs runs twice on different cadences. Most of the duplication is
 * wasteful rather than dangerous — the outbox drain leases rows, so a second drain finds nothing.
 * `ai-monitor` is different: it is the one job that SPENDS MONEY on a model, the in-process
 * scheduler suppresses it with `MODEL_JOBS=off`, and the Inngest copy had no such control and a
 * SIX TIMES shorter period. Setting `MODEL_JOBS=off` would have looked like stopping model spend
 * while it continued every ten minutes.
 *
 * D-021 records the decision: Railway's in-process scheduler is the canonical one. So Inngest
 * schedules nothing unless somebody says so explicitly, and the honest default is off.
 *
 * This does NOT disable Inngest's event-driven functions. Inbound message handling is triggered by
 * an event, not a cron, and is unaffected.
 */
export const INNGEST_SCHEDULER_VAR = "INNGEST_SCHEDULER" as const;

export function inngestSchedulingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[INNGEST_SCHEDULER_VAR] === "on";
}

/**
 * Why an Inngest-scheduled job must not run, or null if it may.
 *
 * Two independent reasons, in order. Ownership first: if Inngest is not the scheduler, nothing it
 * schedules runs, whatever the job is. Then the SAME suppression the in-process scheduler applies,
 * so `MODEL_JOBS=off` means the same thing on both paths rather than only on one.
 */
export function inngestJobSuppressed(
  job: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!inngestSchedulingEnabled(env)) return `${INNGEST_SCHEDULER_VAR} is not "on"`;
  const known = DEFAULT_JOBS.find((j) => j.job === job);
  return known ? jobSuppressed(known, env) : null;
}

/** The jobs that will actually be scheduled, and the ones that will not, with reasons. */
export function partitionJobs(
  jobs: readonly ScheduledJob[] = DEFAULT_JOBS,
  env: NodeJS.ProcessEnv = process.env,
): { runnable: ScheduledJob[]; suppressed: { job: string; reason: string }[] } {
  const runnable: ScheduledJob[] = [];
  const suppressed: { job: string; reason: string }[] = [];
  for (const j of jobs) {
    const reason = jobSuppressed(j, env);
    if (reason) suppressed.push({ job: j.job, reason });
    else runnable.push(j);
  }
  return { runnable, suppressed };
}

/**
 * Preconditions for actually starting. Separated from the side-effecting starter so the
 * decision is unit-testable: a missing CRON_SECRET must DISABLE the scheduler rather than
 * start it into a loop of 500s.
 */
export function schedulerStartupDecision(env: NodeJS.ProcessEnv = process.env):
  | { start: true; baseUrl: string }
  | { start: false; reason: string } {
  if (!schedulerEnabled(env)) return { start: false, reason: "disabled" };
  if (!env.CRON_SECRET) return { start: false, reason: "no_cron_secret" };
  const port = env.PORT ?? "3000";
  if (!/^\d+$/.test(port)) return { start: false, reason: "bad_port" };
  // Loopback: the server calls itself, so this never leaves the container and does not
  // depend on the public domain being reachable.
  return { start: true, baseUrl: `http://127.0.0.1:${port}` };
}

let started = false;
const timers: NodeJS.Timeout[] = [];

/** Stop everything (tests / graceful shutdown). */
export function stopScheduler(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  started = false;
}

/**
 * Start the scheduler once per process. Returns the jobs actually scheduled (empty when
 * disabled), so the boot hook can log what is running.
 */
export function startScheduler(
  jobs: readonly ScheduledJob[] = DEFAULT_JOBS,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  if (started) return []; // hot reload / repeated boot hook must not double-schedule
  const decision = schedulerStartupDecision(env);
  if (!decision.start) {
    if (decision.reason !== "disabled") {
      log("error", "in-process scheduler not started", { event: "cron.scheduler_disabled", reason: decision.reason });
    }
    return [];
  }
  started = true;
  const secret = env.CRON_SECRET as string;

  // Which jobs are suppressed is said OUT LOUD at boot, at error level. A job that silently
  // stops running looks exactly like a job that runs and finds nothing to do, and the whole
  // reason these controls exist is that someone needs to stop model spend WITHOUT stopping
  // message recovery — so which half is off has to be legible in the deployment log.
  const { runnable, suppressed } = partitionJobs(jobs, env);
  for (const s of suppressed) {
    log("error", "scheduled job SUPPRESSED by configuration", {
      event: "cron.job_suppressed",
      job: s.job,
      reason: s.reason,
    });
  }

  for (const { job, everyMs } of runnable) {
    let running = false;
    const tick = async () => {
      if (running) {
        // Previous run still in flight — skip rather than pile up.
        log("info", "scheduled job still running, skipping tick", { event: "cron.tick_skipped", job });
        return;
      }
      running = true;
      try {
        const res = await fetch(`${decision.baseUrl}/api/cron/${job}`, {
          headers: { authorization: `Bearer ${secret}` },
          cache: "no-store",
        });
        if (!res.ok) {
          log("error", "scheduled job returned an error", { event: "cron.tick_failed", job, status: res.status });
        }
      } catch (e) {
        log("error", "scheduled job threw", { event: "cron.tick_threw", job, error: (e as Error).message });
      } finally {
        running = false;
      }
    };
    const timer = setInterval(tick, everyMs);
    // Never hold the process open just for a timer.
    if (typeof timer.unref === "function") timer.unref();
    timers.push(timer);
  }

  log("info", "in-process scheduler started", {
    event: "cron.scheduler_started",
    jobs: runnable.map((j) => `${j.job}@${Math.round(j.everyMs / 1000)}s`),
    suppressed: suppressed.map((s) => `${s.job}(${s.reason})`),
  });
  // Only the jobs actually scheduled. Returning the full list would tell the boot hook that a
  // suppressed job is running.
  return runnable.map((j) => j.job);
}
