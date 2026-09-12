/**
 * Task follow-up loop (NEXT_PHASE_DEVELOPER_BRIEF §WP3.8 "the system follows up at
 * configurable intervals" + §WP4.7). A cron-triggered sweep that runs the pure
 * `evaluateFollowUp` engine over every active task and ENQUEUES the matching
 * approved template (estimate request / overdue reminder / verification request /
 * escalation) into the outbox. The drain worker (`/api/cron/outbox`) delivers them.
 *
 * UNOWNED WORK (fixed 2026-09-12). The sweep used to select only tasks with a non-null
 * `assigned_to`, and its non-escalation branch resolved the assignee's phone and silently
 * did nothing when there wasn't one. Unowned work therefore reached NOBODY: no reminder,
 * no escalation, no log — observed live, where every AI-captured task carries
 * `assigned_to = NULL`. A due task that nobody owns is a MANAGEMENT problem, so it now
 * escalates to the company's admins instead of being dropped. The same applies when the
 * assignee is missing or deactivated — active work held by an inactive account escalates
 * rather than vanishing. Nothing is ever dropped without a log line.
 *
 * Secured by CRON_SECRET (fail-closed). It ONLY enqueues approved internal reminders —
 * never a customer commitment, never an execution. The daily dedupe bucket in the
 * idempotency key caps each reminder to once per task per day (no spam).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { evaluateFollowUp, resolveFollowUpDelivery, type FollowUpAction } from "@/modules/work/follow-up";
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
    db.from("tasks").select("id, company_id, title, status, due_date, updated_at, assigned_to").not("status", "in", "(completed,cancelled)").limit(1000),
  ]);

  const byId = new Map((profiles ?? []).map((p: any) => [p.id, p]));
  const adminsByCompany = new Map<string, any[]>();
  for (const p of profiles ?? []) {
    if (p.is_admin) adminsByCompany.set(p.company_id, [...(adminsByCompany.get(p.company_id) ?? []), p]);
  }

  const day = today();
  let enqueued = 0;
  let unownedEscalated = 0;

  const buildFor = (action: FollowUpAction, name: string, task: { title: string; dueDate: string | null }, reason: string): BuiltMessage => {
    if (action === "estimate_request") return InternalTemplates.estimateRequest(name, task);
    if (action === "overdue_reminder") return InternalTemplates.overdueReminder(name, task);
    if (action === "verification_request") return InternalTemplates.verificationRequest(name, task);
    return InternalTemplates.escalation(name, task, reason);
  };
  const send = async (companyId: string, taskId: string, action: FollowUpAction, recipientId: string, phone: string, name: string, task: { title: string; dueDate: string | null }, reason: string) => {
    const msg = buildFor(action, name, task, reason);
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
    // `byId` holds ACTIVE profiles only, so an assignee that is missing or deactivated
    // resolves to undefined and the task counts as unowned.
    const assignee = t.assigned_to ? byId.get(t.assigned_to) : undefined;
    const audience = resolveFollowUpDelivery(decision, !!assignee);
    if (!audience) continue;
    const task = { title: t.title, dueDate: t.due_date };

    if (audience.to === "managers") {
      const admins = adminsByCompany.get(t.company_id) ?? [];
      if (admins.length === 0) {
        log("error", "follow-up escalation has no admin to notify", { event: "cron.followup_no_recipient", taskId: t.id, companyId: t.company_id, unowned: audience.unowned });
        continue;
      }
      if (audience.unowned) {
        log("info", "escalating unowned task to admins", { event: "cron.followup_unowned", taskId: t.id, companyId: t.company_id, assignedTo: t.assigned_to ?? null });
        unownedEscalated++;
      }
      for (const admin of admins) {
        const phone = cleanPhone(admin.phone);
        if (phone) await send(t.company_id, t.id, audience.action, admin.id, phone, admin.full_name ?? admin.username ?? "there", task, audience.reason);
        else log("error", "admin has no phone for a due escalation", { event: "cron.followup_no_phone", taskId: t.id, recipientId: admin.id });
      }
    } else {
      const phone = cleanPhone(assignee.phone);
      if (phone) await send(t.company_id, t.id, audience.action, assignee.id, phone, assignee.full_name ?? assignee.username ?? "there", task, audience.reason);
      else log("error", "assignee has no phone for a due follow-up", { event: "cron.followup_no_phone", taskId: t.id, recipientId: assignee.id });
    }
  }

  return NextResponse.json({ ok: true, tasks: (tasks ?? []).length, enqueued, unownedEscalated });
}
