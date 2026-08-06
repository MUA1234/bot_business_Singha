/**
 * Cron heartbeat — a single scheduled entrypoint that fans out to the individual cron
 * jobs (digest, outbox drain, follow-ups, AI monitor). Vercel's free (Hobby) plan
 * limits cron schedules to once per day and a small count, so we schedule ONE cron here
 * (see vercel.json) and it triggers the others over internal HTTP with the same
 * CRON_SECRET. On a paid plan each job can instead be scheduled at its own frequency.
 *
 * Secured by CRON_SECRET (fail-closed). No business logic here — it only forwards.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;

const JOBS = ["daily-digest", "outbox", "follow-ups", "ai-monitor"] as const;

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log("error", "CRON_SECRET not configured — heartbeat refusing to run", { event: "cron.misconfigured" });
    return new NextResponse("cron not configured", { status: 500 });
  }
  const provided = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const origin = new URL(req.url).origin;
  const results: Record<string, number | string> = {};
  for (const job of JOBS) {
    try {
      const r = await fetch(`${origin}/api/cron/${job}`, { headers: { authorization: `Bearer ${secret}` } });
      results[job] = r.status;
    } catch (e) {
      results[job] = "error";
      log("error", "heartbeat job failed", { event: "cron.heartbeat_job_failed", job, error: (e as Error).message });
    }
  }
  return NextResponse.json({ ok: true, results });
}
