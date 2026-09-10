/**
 * Scheduled management cycle — the loop's own heartbeat (Release 1, owner decision 1).
 *
 * `/api/management/cycle` already runs the cycle, but it is a MANUAL route: it resolves the
 * caller from the server session and requires `operations.task.manage`. A scheduler has no
 * session, so that route can never be the scheduled path, and until this route existed the
 * management loop only advanced when a person pressed a button. An item therefore sat in
 * `observed` until someone happened to look — which is the same class of failure as the outbox
 * drain that ran only when an operator triggered it by hand.
 *
 * This route contains NO management logic. Like the manual one it establishes authority and then
 * calls the one shared service; a second implementation here is exactly what the kernel exists to
 * prevent. The differences from the manual route are only these:
 *
 *   * authority is the shared `CRON_SECRET`, compared in constant time, not a user session;
 *   * there is no actor, so the cycle runs with `actorId: null` and `trigger: "scheduled"` —
 *     the lifecycle sweep's writes are already recorded as `actor_type='system'`, and no human
 *     identity is borrowed to stand in for the scheduler;
 *   * it sweeps EVERY enabled company rather than the caller's own, because a scheduler has no
 *     company either. Each company's cycle reads only within that company, so the isolation
 *     property is unchanged.
 *
 * DISABLED IS AN HONEST RESULT. When the kernel is globally off, this returns 200 with
 * `status: "disabled"` and a reason, rather than a silent success or an error. A monitor that
 * cannot tell "off" from "ran and did nothing" is how a stopped loop goes unnoticed.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { runManagementCycle, kernelGloballyEnabled } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Bounded: one cycle per company, each already row-budgeted by the kernel. */
export const maxDuration = 60;

/** How many companies one scheduled tick will sweep. Keeps a tick bounded on a busy account. */
const COMPANY_BUDGET = 25;

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log("error", "CRON_SECRET not configured — management cycle refusing to run", {
      event: "cron.misconfigured",
      job: "management-cycle",
    });
    return new NextResponse("cron not configured", { status: 500 });
  }
  const provided = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  if (!kernelGloballyEnabled()) {
    // Say so. This is the honest disabled result, not a no-op success.
    log("info", "management cycle is globally disabled — nothing swept", {
      event: "cron.disabled",
      job: "management-cycle",
    });
    return NextResponse.json({
      status: "disabled",
      reason: "the management kernel is globally disabled (MANAGEMENT_KERNEL is not 'on')",
      companiesSwept: 0,
    });
  }

  const db = supabaseAdmin();

  // Only companies that have switched the kernel on. A company that never opted in is not swept,
  // and the absence of a row is a decision, not a gap to fill with a default.
  const { data: enabledRows, error } = await db
    .from("management_kernel_enablement")
    .select("company_id")
    .eq("enabled", true)
    .limit(COMPANY_BUDGET);

  if (error) {
    log("error", "could not read management kernel enablement", {
      event: "cron.tick_failed",
      job: "management-cycle",
      error: error.message,
    });
    return new NextResponse("enablement lookup failed", { status: 503 });
  }

  const companies = (enabledRows ?? []).map((r) => String((r as { company_id: string }).company_id));
  const results: { companyId: string; status: string; itemsCreated?: number; error?: string }[] = [];

  for (const companyId of companies) {
    try {
      const summary = await runManagementCycle(makeCycleDeps(db), {
        companyId,
        actorId: null,
        trigger: "scheduled",
      });
      results.push({
        companyId,
        status: summary.status,
        itemsCreated: summary.itemsCreated,
      });
    } catch (e) {
      // One company's failure must not stop the others: a single bad tenant would otherwise
      // silently stop the loop for everybody behind it in the list.
      log("error", "management cycle threw for a company", {
        event: "cron.tick_threw",
        job: "management-cycle",
        companyId,
        error: (e as Error).message,
      });
      results.push({ companyId, status: "error", error: (e as Error).message });
    }
  }

  const failed = results.filter((r) => r.status === "error").length;
  log("info", "scheduled management cycle finished", {
    event: "cron.tick_done",
    job: "management-cycle",
    companiesSwept: results.length,
    failed,
  });

  return NextResponse.json({
    status: failed === 0 ? "completed" : "partial",
    companiesSwept: results.length,
    failed,
    results,
  });
}
