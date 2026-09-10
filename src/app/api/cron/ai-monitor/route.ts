/**
 * Continuous Senior-AI-Manager monitoring (NEXT_PHASE_DEVELOPER_BRIEF §WP5.1 "does not
 * yet continuously monitor all approved business inputs"). A cron-triggered sweep that
 * analyses WhatsApp conversations with NEW inbound activity since their last analysis:
 * it observes the thread (through the AI gateway + cost ledger), captures low-risk
 * tasks, and persists a durable management case. Observe/propose only — it never
 * replies to a customer, moves money, or executes anything.
 *
 * Secured by CRON_SECRET (fail-closed). Degrades gracefully with no OPENAI_API_KEY.
 * Bounded per run so AI cost stays predictable.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { analyzeConversationThread } from "@/management/ai-manager/analyze-conversation";
import { writeAudit } from "@/lib/audit";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;

const BATCH = 15; // bound AI cost per run

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log("error", "CRON_SECRET not configured — ai-monitor refusing to run", { event: "cron.misconfigured" });
    return new NextResponse("cron not configured", { status: 500 });
  }
  const provided = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ ok: true, skipped: "ai_not_configured" });
  }

  const db = supabaseAdmin();
  // Conversations with inbound activity not yet reflected in an analysis.
  const { data: convos } = await db
    .from("wa_conversations")
    .select("id, company_id, last_inbound_at, ai_analyzed_at")
    .not("last_inbound_at", "is", null)
    // DESCENDING: most recently active threads first. Ascending order meant every new inbound
    // message pushed a thread towards the END of the window, so past 200 conversations the threads
    // with new customer activity were systematically excluded while this job reported success. It
    // also let a thread whose persistence keeps failing (which is deliberately left due, below) sit
    // at the head of the batch on every run and starve everything else.
    .order("last_inbound_at", { ascending: false })
    .limit(200);

  const due = (convos ?? [])
    .filter((c: any) => !c.ai_analyzed_at || new Date(c.last_inbound_at) > new Date(c.ai_analyzed_at))
    .slice(0, BATCH);

  let analyzed = 0,
    tasks = 0;
  for (const c of due) {
    try {
      const res = await analyzeConversationThread(db, { companyId: c.company_id, conversationId: c.id, actorId: c.company_id, actorType: "ai" });

      // Mark analysed so a persistently-empty thread isn't retried forever — but NOT when the
      // durable write itself failed. analyzeConversationThread documents persistence failure as a
      // hard failure ("never 'analysed' without a durable record"); stamping it here anyway broke
      // that contract, because the `due` filter would then skip the thread until a NEW customer
      // message arrived, silently and permanently losing the analysis. A transient RPC error must
      // leave the thread due so the next run retries it.
      const lostDurably = !res.ok && res.reason === "persist_failed";
      if (lostDurably) {
        log("error", "ai-monitor: analysis not durable — leaving thread due for retry", {
          event: "monitor.persist_failed",
          conversationId: c.id,
        });
      } else {
        await db.from("wa_conversations").update({ ai_analyzed_at: new Date().toISOString() }).eq("id", c.id).eq("company_id", c.company_id);
      }
      if (res.ok) {
        analyzed++;
        tasks += res.createdTasks ?? 0;
        await writeAudit({ companyId: c.company_id, actorId: c.company_id, actorType: "ai", action: "monitor.analyzed", entityType: "wa_conversation", entityId: c.id, payload: { createdTasks: res.createdTasks } });
      }
    } catch (e) {
      log("error", "ai-monitor analysis failed", { event: "monitor.failed", conversationId: c.id, error: (e as Error).message });
    }
  }

  return NextResponse.json({ ok: true, considered: due.length, analyzed, tasksCaptured: tasks });
}
