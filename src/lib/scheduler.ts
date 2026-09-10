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
export interface ScheduledJob {
  readonly job: string;
  readonly everyMs: number;
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
  { job: "ai-monitor", everyMs: 1 * HOUR },
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

  for (const { job, everyMs } of jobs) {
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
    jobs: jobs.map((j) => `${j.job}@${Math.round(j.everyMs / 1000)}s`),
  });
  return jobs.map((j) => j.job);
}
