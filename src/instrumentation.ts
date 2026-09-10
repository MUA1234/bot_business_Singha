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

  const { startScheduler } = await import("@/lib/scheduler");
  startScheduler();
}
