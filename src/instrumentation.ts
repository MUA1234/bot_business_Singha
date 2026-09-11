/**
 * Next.js server boot hook (WP F / §11). Runs once when the server process starts.
 * In production it fails fast if a mandatory security setting is missing; in
 * development/build it is a no-op (nothing connects at build time).
 *
 * On a persistent host (Railway) it also starts the in-process job scheduler, which is
 * OFF unless `IN_PROCESS_CRON=on` — see src/lib/scheduler.ts for why the platform crons
 * were not sufficient.
 */
import { assertProductionConfig } from "@/config/env";

export async function register(): Promise<void> {
  assertProductionConfig();

  // Only in the Node.js server runtime — never during build, and never on the edge runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Isolation being OFF is a permitted, explicit choice while the cutover to `on` waits on the
  // staging proof (owner decision 5) — but it must never be a quiet one. Said at boot, at error
  // level, so it appears in the deployment log an operator actually reads.
  const { isolationDisabledDeliberately } = await import("@/config/env");
  if ((process.env.APP_ENV ?? "development") === "production" && isolationDisabledDeliberately()) {
    const { log } = await import("@/lib/log");
    log("error", "starting with DATABASE ISOLATION DISABLED — company separation rests on application code", {
      event: "config.isolation_disabled",
      rlsReads: process.env.RLS_READS ?? null,
      rlsWrites: process.env.RLS_WRITES ?? null,
    });
  }

  // ── Can this process produce business effects? ─────────────────────────────────────────
  //
  // The global execution boundary used to be `false as const`, so the answer was the same in
  // every deployment and there was nothing to report. It is now a server variable — that is what
  // let staging observe the loop's one authorised effect — and the price of a variable is that an
  // operator can no longer read the source to find out which way it is set.
  //
  // So the process says so at boot. ON is reported at ERROR level, not because it is a fault but
  // because a system that can act without a person saying so each time is a fact nobody should
  // have to go looking for. OFF is reported too, at info: silence would be indistinguishable from
  // a diagnostic that failed to run.
  //
  // Names and booleans only. No value from the environment is printed.
  {
    const { executionBoundaryDiagnostics } = await import("@/kernel/execution/boundary");
    const { log } = await import("@/lib/log");
    const boundary = executionBoundaryDiagnostics();
    log(
      boundary.enabled ? "error" : "info",
      boundary.enabled
        ? "EXECUTION IS ENABLED — this process may produce business effects without a person acting"
        : "execution is disabled at the global boundary",
      { event: "execution.boundary", ...boundary },
    );
    if (boundary.browserReachableFlags.length > 0) {
      // A `NEXT_PUBLIC_*` variable that mentions execution is inlined into the client bundle.
      // Nothing reads one, and this is here so that introducing one is loud rather than subtle.
      log("error", "a browser-reachable execution variable exists and must not", {
        event: "execution.boundary_browser_reachable",
        variables: boundary.browserReachableFlags,
      });
    }
  }

  const { startScheduler } = await import("@/lib/scheduler");
  startScheduler();
}
