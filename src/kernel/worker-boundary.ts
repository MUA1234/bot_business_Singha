/**
 * FUTURE worker entrypoint — DEFINED, UNREGISTERED AND DISABLED.
 *
 * This file exists so the shape of a scheduled sweep is reviewable before anything runs it.
 * Nothing imports it into a route, a cron registration or the in-process scheduler, and the
 * owner has not authorised registering one.
 *
 * Two guards make accidental activation loud rather than silent:
 *   * `WORKER_ENABLED` is a hard-coded `false`, not an environment variable, so no
 *     deployment configuration can turn it on;
 *   * `enumerateEnabledCompanies` reads the server-side enablement table and NOTHING else —
 *     it cannot be handed a list of company ids, so a caller cannot aim it at a company the
 *     owner never enabled.
 */
import { runManagementCycle, type CycleDeps, type CycleSummary } from "./cycle";

/** Hard-coded. Deliberately NOT configurable: registering a worker is an owner decision. */
export const WORKER_ENABLED = false as const;

export interface WorkerDeps extends CycleDeps {
  /** Server-controlled. Returns ONLY companies with an explicit enablement row. */
  enumerateEnabledCompanies(): Promise<string[]>;
}

export class WorkerDisabledError extends Error {
  constructor() {
    super("the management worker is defined but not registered or enabled");
    this.name = "WorkerDisabledError";
  }
}

/**
 * What a scheduled sweep WOULD do. Refuses to run while `WORKER_ENABLED` is false.
 *
 * There is no company-id parameter by design: the worker's scope is whatever the server
 * says is enabled, never what a caller asks for.
 */
export async function runWorkerSweep(deps: WorkerDeps): Promise<CycleSummary[]> {
  if (!WORKER_ENABLED) throw new WorkerDisabledError();

  const companies = await deps.enumerateEnabledCompanies();
  const summaries: CycleSummary[] = [];
  for (const companyId of companies) {
    // One cycle per company, sequential: the advisory lock already prevents two cycles for
    // ONE company, and running every company at once would be an unbounded fan-out.
    summaries.push(await runManagementCycle(deps, { companyId, actorId: null, trigger: "scheduled" }));
  }
  return summaries;
}
