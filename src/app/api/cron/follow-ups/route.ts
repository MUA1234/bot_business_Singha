/**
 * Task follow-up loop (NEXT_PHASE_DEVELOPER_BRIEF §WP3.8 "the system follows up at
 * configurable intervals" + §WP4.7). A cron-triggered sweep that runs the pure
 * `evaluateFollowUp` engine over every active assigned task and ENQUEUES the matching
 * approved template (estimate request / overdue reminder / verification request /
 * escalation) into the outbox. The drain worker (`/api/cron/outbox`) delivers them.
 *
 * Secured by CRON_SECRET (fail-closed). It ONLY enqueues approved internal reminders —
 * never a customer commitment, never an execution. The daily dedupe bucket in the
 * idempotency key caps each reminder to once per task per day (no spam).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { evaluateFollowUp, type FollowUpAction } from "@/modules/work/follow-up";
import { InternalTemplates, type BuiltMessage } from "@/lib/whatsapp-templates";
import { enqueueOutbox } from "@/lib/outbox-enqueue";
import { log } from "@/lib/log";

export const runtime = "nodejs";

const cleanPhone = (p?: string | null) => (p ?? "").replace(/[^\d]/g, "");
const today = () => new Date().toISOString().slice(0, 10);

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log("error", "CRON_SECRET not configured — follow-ups refusing to run", { event: "cron.misconfigured" });
    return new NextResponse("cron not configured", { status: 500 });
  }
  const provided = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const db = supabaseAdmin();
  const [{ data: profiles }, { data: tasks }] = await Promise.all([
    db.from("profiles").select("id, company_id, phone, full_name, username, is_admin").eq("is_active", true),
    db.from("tasks").select("id, company_id, title, status, due_date, updated_at, assigned_to").not("status", "in", "(completed,cancelled)").not("assigned_to", "is", null).limit(1000),
  ]);

  const byId = new Map((profiles ?? []).map((p: any) => [p.id, p]));
  const adminsByCompany = new Map<string, any[]>();
  for (const p of profiles ?? []) {
    if (p.is_admin) adminsByCompany.set(p.company_id, [...(adminsByCompany.get(p.company_id) ?? []), p]);
  }

  const day = today();
  let enqueued = 0;

  const buildFor = (action: FollowUpAction, name: string, task: { title: string; dueDate: string | null }): BuiltMessage => {
    if (action === "estimate_request") return InternalTemplates.estimateRequest(name, task);
    if (action === "overdue_reminder") return InternalTemplates.overdueReminder(name, task);
    if (action === "verification_request") return InternalTemplates.verificationRequest(name, task);
    return InternalTemplates.escalation(name, task, "needs attention");
  };
  const send = async (companyId: string, taskId: string, action: FollowUpAction, recipientId: string, phone: string, name: string, task: { title: string; dueDate: string | null }) => {
    const msg = buildFor(action, name, task);
    const res = await enqueueOutbox({
      channel: "whatsapp",
      companyId,
      recipient: phone,
      body: msg.body,
      dedupeKey: `followup:${taskId}:${action}:${recipientId}:${day}`,
      templateName: msg.templateName,
      templateParams: [name, task.title],
    });
    if (res === "enqueued") enqueued++;
  };

  for (const t of tasks ?? []) {
    const decision = evaluateFollowUp({ status: t.status, dueDate: t.due_date, lastActivityAt: t.updated_at, lastReminderAt: null });
    if (!decision.due || !decision.action) continue;
    const task = { title: t.title, dueDate: t.due_date };

    if (decision.action === "escalation") {
      for (const admin of adminsByCompany.get(t.company_id) ?? []) {
        const phone = cleanPhone(admin.phone);
        if (phone) await send(t.company_id, t.id, "escalation", admin.id, phone, admin.full_name ?? admin.username ?? "there", task);
      }
    } else {
      const a = byId.get(t.assigned_to);
      const phone = cleanPhone(a?.phone);
      if (phone) await send(t.company_id, t.id, decision.action, a.id, phone, a.full_name ?? a.username ?? "there", task);
    }
  }

  return NextResponse.json({ ok: true, tasks: (tasks ?? []).length, enqueued });
}
