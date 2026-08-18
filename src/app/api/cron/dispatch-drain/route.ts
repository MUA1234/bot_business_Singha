/**
 * Scheduled inbound DISPATCH drain (remediation R1 §3, OF-001).
 *
 * The counterpart to `/api/cron/inbound-sweeper`: that one drives the CONSUMER lifecycle of a
 * captured event, this one drives the DISPATCH lifecycle — deciding what an inbound message is.
 * Until it existed, a failed dispatch was recovered only by the provider redelivering the message,
 * which is not a retry mechanism the system controls.
 *
 * Secured by CRON_SECRET, fail-closed: no secret configured means the route refuses to run rather
 * than running unauthenticated. The secret lives in the environment and is never committed, and
 * actual hosted scheduling stays an owner action.
 *
 * Returns COUNTS only — never a recipient, a message body, or another company's data — and reports
 * partial completion truthfully instead of a bare "ok".
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { drainInboundDispatch, type DrainableReceipt } from "@/events/dispatch-drain";
import { dispatchReceipt } from "@/lib/inbound/dispatch-receipt";
import { makeInboundDeps } from "@/lib/inbound/production-deps";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Bounded: the drain's own deadline sits well inside this. */
export const maxDuration = 60;

/** Identifies this run's leases. A restart takes a new identity; expired leases are recoverable. */
function workerId(): string {
  return `dispatch-drain:${process.env.VERCEL_DEPLOYMENT_ID ?? "local"}:${process.pid}:${Date.now().toString(36)}`;
}

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log("error", "CRON_SECRET not configured — dispatch drain refusing to run", { event: "cron.misconfigured" });
    return new NextResponse("cron not configured", { status: 500 });
  }
  const provided = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const db = supabaseAdmin();
  const owner = workerId();

  const result = await drainInboundDispatch(
    {
      async claim(limit, o, leaseSeconds) {
        const { data, error } = await db.rpc("claim_inbound_dispatch_batch", {
          p_limit: limit, p_owner: o, p_lease_seconds: leaseSeconds,
        });
        if (error) throw new Error(error.message);
        return (data ?? []) as DrainableReceipt[];
      },
      async dispatch(receipt, o) {
        // The SAME orchestration the webhook runs, on a receipt this run already leased. Async and
        // scheduled paths therefore cannot reach a different business outcome from the sync one.
        return dispatchReceipt(
          db,
          {
            event: {
              id: receipt.id,
              idempotency_key: receipt.id,
              correlation_id: receipt.correlation_id ?? receipt.id,
              status: "received",
            },
            created: false,
            identity: receipt.provider_message_id,
            dispatchState: "dispatching",
          },
          {
            channel: "whatsapp",
            from: String((receipt.raw_payload as { from?: string } | null)?.from ?? ""),
            text: String((receipt.raw_payload as { text?: string } | null)?.text ?? ""),
            providerMessageId: receipt.provider_message_id ?? "",
            rawPayload: receipt.raw_payload,
          },
          receipt.provider_account_id,
          makeInboundDeps,
          { owner: o, alreadyClaimed: true },
        );
      },
      async release(id, o) {
        const { error } = await db.rpc("release_inbound_dispatch", { p_event: id, p_owner: o });
        if (error) throw new Error(error.message);
      },
      now: () => Date.now(),
    },
    { owner, limit: 25, leaseSeconds: 120, deadlineMs: 45_000, concurrency: 4 },
  );

  if (result.partial) {
    log("warn", "dispatch drain completed with outstanding work", {
      event: "dispatch.drain_partial",
      claimed: result.claimed,
      released: result.released,
      errors: result.errors,
      outcomes: Object.keys(result.byOutcome).join(","),
    });
  }

  return NextResponse.json({
    ok: !result.partial,
    claimed: result.claimed,
    byOutcome: result.byOutcome,
    released: result.released,
    errors: result.errors,
    partial: result.partial,
    durationMs: result.durationMs,
  });
}
