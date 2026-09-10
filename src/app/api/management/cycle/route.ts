/**
 * Authorised MANUAL invocation of the management cycle (R1 runtime).
 *
 * This route contains NO management logic. It establishes who is asking, decides whether
 * they may ask, and calls the one shared service. A second implementation here is exactly
 * the failure the kernel exists to prevent.
 *
 * Identity rules, all server-side:
 *   * the user comes from the authenticated SERVER SESSION, never from the request;
 *   * the company comes from that user's profile, resolved server-side — a client-supplied
 *     company identity is ignored entirely and refused loudly if one is sent;
 *   * the existing `operations.task.manage` capability is required;
 *   * the reply never contains another company's data, because the cycle only ever reads
 *     within the resolved company.
 */
import { NextResponse } from "next/server";
import { getProfile, resolveCapability } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { runManagementCycle, kernelGloballyEnabled } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;

/** The capability a manual sweep requires. Manager-and-above, reusing the existing matrix. */
const REQUIRED_CAPABILITY = "operations.task.manage";

/** Crude per-process rate limit: one manual cycle per company per window. */
const WINDOW_MS = 30_000;
const lastRun = new Map<string, number>();

export async function POST(req: Request): Promise<Response> {
  // A client-supplied company is never merely ignored — it is refused, so a caller cannot
  // believe it worked.
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if (body && typeof body === "object" && "companyId" in (body as Record<string, unknown>)) {
    return NextResponse.json(
      { ok: false, error: "company identity is resolved from the session and may not be supplied" },
      { status: 400 },
    );
  }

  const profile = await getProfile();
  if (!profile) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const capability = await resolveCapability(profile.userId, profile.companyId, REQUIRED_CAPABILITY);
  if (capability !== "granted") {
    return NextResponse.json(
      { ok: false, error: "forbidden", reason: capability },
      { status: 403 },
    );
  }

  // The global switch is reported honestly rather than as a silent no-op.
  if (!kernelGloballyEnabled()) {
    return NextResponse.json(
      { ok: true, status: "skipped_disabled", reason: "the management kernel is not enabled on this server" },
      { status: 200 },
    );
  }

  const now = Date.now();
  const previous = lastRun.get(profile.companyId) ?? 0;
  if (now - previous < WINDOW_MS) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", retryAfterMs: WINDOW_MS - (now - previous) },
      { status: 429 },
    );
  }
  lastRun.set(profile.companyId, now);

  const summary = await runManagementCycle(makeCycleDeps(supabaseAdmin()), {
    companyId: profile.companyId,
    actorId: profile.userId,
    trigger: "manual",
  });

  log("info", "management cycle (manual)", {
    event: "management_cycle.manual",
    status: summary.status,
    company: profile.companyId,
    correlationId: summary.correlationId,
  });

  // Partial failure is reported as partial — never as success.
  return NextResponse.json(
    {
      ok: summary.status !== "failed",
      status: summary.status,
      correlationId: summary.correlationId,
      sourcesRegistered: summary.sourcesRegistered,
      sourcesSucceeded: summary.sourcesSucceeded,
      sourcesFailed: summary.sourcesFailed,
      itemsCreated: summary.itemsCreated,
      itemsReused: summary.itemsReused,
      observationsSkipped: summary.observationsSkipped,
      observationsRejected: summary.observationsRejected,
      unobservedDepartments: summary.unobservedDepartments,
      truncatedSources: summary.truncatedSources,
      cursorCommitFailed: summary.cursorCommitFailed,
      cursorReset: summary.cursorReset,
      cursorResetReasons: summary.cursorResetReasons,
      reconcileReserve: summary.reconcileReserve,
      rescanReserve: summary.rescanReserve,
      reconciliationDelayed: summary.reconciliationDelayed,
      // R2S-P: a partial cycle says WHAT it read and WHERE it resumes, so a caller can never
      // mistake "I have more to read" for "nothing needs attention".
      recordsInspected: summary.recordsInspected,
      pagesProcessed: summary.pagesProcessed,
      continuation: summary.continuation,
      budgetExhausted: summary.budgetExhausted,
      resolutionPermitted: summary.resolutionPermitted,
      failureReason: summary.failureReason,
      durationMs: summary.durationMs,
    },
    { status: summary.status === "failed" ? 500 : 200 },
  );
}
