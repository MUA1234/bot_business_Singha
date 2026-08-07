/**
 * Outbox drain worker (WP C). A cron-triggered sweep that ATOMICALLY CLAIMS a leased
 * batch (claim_outbox_batch — FOR UPDATE SKIP LOCKED, migration 0040), sends each row
 * through the official WhatsApp sender, and records the outcome (provider id, attempts,
 * next retry, dead-letter), releasing the lease. Two concurrent sweeps can never send the
 * same row; a crashed worker's lease is recovered on the next claim. Secured by
 * CRON_SECRET (fail-closed). No recipient/body is returned — counts only.
 *
 * The claim + send logic lives in the reusable `drainOutbox` worker so the Inngest
 * frequent sweep (src/inngest/functions.ts) shares exactly the same path.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { drainOutbox } from "@/events/outbox-drain";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log("error", "CRON_SECRET not configured — outbox drain refusing to run", { event: "cron.misconfigured" });
    return new NextResponse("cron not configured", { status: 500 });
  }
  const provided = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const result = await drainOutbox(supabaseAdmin());
  // Fail loud: a drain error returns 5xx so the scheduler/monitor sees it (not a false 200).
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
