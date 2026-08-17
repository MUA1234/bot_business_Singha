/**
 * Scheduled inbound sweeper — the production-reachable path that actually retries failed inbound
 * processing (migration 0069 + src/events/inbound-sweeper.ts).
 *
 * Until this route existed, "the message is retried" was a claim with nothing behind it: the
 * WhatsApp webhook acknowledges 200 whatever happens, and nothing re-drove an unprocessed row.
 *
 * Secured by CRON_SECRET, fail-closed (a missing secret refuses to run). Returns counts only —
 * never a recipient, a body, or another company's data. The response reports partial failure and
 * remaining backlog truthfully rather than a bare "ok".
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { sweepInbound, type SweepableEvent, type ProcessOutcome } from "@/events/inbound-sweeper";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Identifies this worker's lease. A restart takes a new identity; expired leases are recoverable. */
function workerId(): string {
  return `inbound-sweeper:${process.env.VERCEL_DEPLOYMENT_ID ?? "local"}:${process.pid}`;
}

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log("error", "CRON_SECRET not configured — inbound sweeper refusing to run", { event: "cron.misconfigured" });
    return new NextResponse("cron not configured", { status: 500 });
  }
  const provided = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const db = supabaseAdmin();
  const owner = workerId();

  const result = await sweepInbound(
    {
      async claim(limit, o, leaseSeconds) {
        const { data, error } = await db.rpc("claim_source_events", {
          p_limit: limit,
          p_owner: o,
          p_lease_seconds: leaseSeconds,
        });
        if (error) throw new Error(error.message);
        return (data ?? []) as SweepableEvent[];
      },
      async complete(id, o) {
        const { error } = await db.rpc("complete_source_event", { p_id: id, p_owner: o });
        if (error) throw new Error(error.message);
      },
      async fail(id, o, code, message, maxAttempts) {
        const { data, error } = await db.rpc("fail_source_event", {
          p_id: id,
          p_owner: o,
          p_error_code: code,
          p_error: message,
          p_max_attempts: maxAttempts,
        });
        if (error) throw new Error(error.message);
        return String(data ?? "retry_wait");
      },
      async process(event): Promise<ProcessOutcome> {
        // Processing itself is section 5 of the follow-up program (staff/finance intake) and is NOT
        // implemented. Until it is, an unclassifiable event is reported as a non-retryable failure
        // so it dead-letters visibly instead of cycling forever — and so nothing here can pretend an
        // event was handled. This is deliberately honest, not a placeholder success.
        return {
          ok: false,
          code: "no_processor",
          message: `no inbound processor is wired for source "${event.source ?? "unknown"}"`,
          retryable: false,
        };
      },
    },
    { owner, limit: 25, leaseSeconds: 120, maxAttempts: 5 },
  );

  if (result.partialFailure) {
    log("warn", "inbound sweep completed with failures", {
      event: "inbound.sweep_partial",
      claimed: result.claimed,
      completed: result.completed,
      deadLettered: result.deadLettered,
    });
  }

  return NextResponse.json({
    ok: !result.partialFailure,
    claimed: result.claimed,
    completed: result.completed,
    retryScheduled: result.retryScheduled,
    deadLettered: result.deadLettered,
    partialFailure: result.partialFailure,
  });
}
