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
 * DELIVERY CHANNELS (fixed 2026-09-12). This was the ONLY notification path in the app
 * that was WhatsApp-ONLY — every other one (task assignment, approvals, leave, expenses,
 * the digest) writes an in-app notification first and treats WhatsApp as an extra. Live,
 * ALL EIGHT staff profiles have `phone = null`, so the sweep could not deliver a single
 * message to anyone no matter what it decided. It now follows the same rule as the rest:
 * the in-app notification ALWAYS goes out (it needs no configuration), and WhatsApp is
 * sent in addition when a number is on file. Both are capped to once per task, per
 * recipient, per action, per day.
 *
 * Secured by CRON_SECRET (fail-closed). It ONLY raises approved internal reminders —
 * never a customer commitment, never an execution.
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import {
  evaluateFollowUp,
  resolveFollowUpDelivery,
  followUpNotification,
  followUpDedupeKey,
  type FollowUpAction,
} from "@/modules/work/follow-up";
import { InternalTemplates, type BuiltMessage } from "@/lib/whatsapp-templates";
import { enqueueOutbox } from "@/lib/outbox-enqueue";
import { createNotification } from "@/lib/notify";
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

  const day = today();
  const db = supabaseAdmin();
  const [{ data: profiles }, { data: tasks }] = await Promise.all([
    db.from("profiles").select("id, company_id, phone, full_name, username, is_admin").eq("is_active", true),
    db.from("tasks").select("id, company_id, title, status, due_date, updated_at, assigned_to").not("status", "in", "(completed,cancelled)").limit(1000),
  ]);

  // The in-app channel has no idempotency key of its own (see `notifications`, migration
  // 0022), and this sweep runs every 15 minutes — so without a guard one due task would
  // raise a notification 96 times a day. Today's follow-up notifications are read once and
  // used as a natural dedupe set: recipient + type + link identifies task × action × person.
  const dayStart = `${day}T00:00:00Z`;
  const { data: todaysNotifs } = await db
    .from("notifications")
    .select("recipient_id, type, link")
    .like("type", "task\\_%")
    .gte("created_at", dayStart);
  const alreadyNotified = new Set((todaysNotifs ?? []).map((n: any) => `${n.recipient_id}|${n.type}|${n.link}`));

  const byId = new Map((profiles ?? []).map((p: any) => [p.id, p]));
  const adminsByCompany = new Map<string, any[]>();
  for (const p of profiles ?? []) {
    if (p.is_admin) adminsByCompany.set(p.company_id, [...(adminsByCompany.get(p.company_id) ?? []), p]);
  }

  let enqueued = 0;
  let notified = 0;
  let unownedEscalated = 0;

  const buildFor = (action: FollowUpAction, name: string, task: { title: string; dueDate: string | null }, reason: string): BuiltMessage => {
    if (action === "estimate_request") return InternalTemplates.estimateRequest(name, task);
    if (action === "overdue_reminder") return InternalTemplates.overdueReminder(name, task);
    if (action === "verification_request") return InternalTemplates.verificationRequest(name, task);
    return InternalTemplates.escalation(name, task, reason);
  };
  /**
   * Deliver one follow-up to one person. The in-app notification ALWAYS goes out — it needs
   * no phone number and no provider — and WhatsApp is enqueued in addition when a number is
   * on file. A recipient with neither is still reached, which was the whole live failure.
   */
  const deliver = async (
    companyId: string,
    taskId: string,
    action: FollowUpAction,
    recipient: { id: string; phone?: string | null; full_name?: string | null; username?: string | null },
    task: { title: string; dueDate: string | null },
    reason: string,
  ) => {
    const name = recipient.full_name ?? recipient.username ?? "there";
    const n = followUpNotification(action, taskId, task.title, reason);
    const dedupe = followUpDedupeKey(recipient.id, n);
    if (!alreadyNotified.has(dedupe)) {
      await createNotification({ companyId, recipientId: recipient.id, type: n.type, title: n.title, body: n.body, link: n.link });
      alreadyNotified.add(dedupe); // same task, two admins in one pass → still one each
      notified++;
    }

    const phone = cleanPhone(recipient.phone);
    if (!phone) {
      log("info", "no phone on file — in-app notification only", { event: "cron.followup_no_phone", taskId, recipientId: recipient.id });
      return;
    }
    const msg = buildFor(action, name, task, reason);
    const res = await enqueueOutbox({
      channel: "whatsapp",
      companyId,
      recipient: phone,
      body: msg.body,
      dedupeKey: `followup:${taskId}:${action}:${recipient.id}:${day}`,
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

    const recipients = audience.to === "managers" ? (adminsByCompany.get(t.company_id) ?? []) : [assignee];
    if (recipients.length === 0) {
      // Nobody can be told. Loudly, because the work is now invisible to every channel.
      log("error", "follow-up has no recipient at all", { event: "cron.followup_no_recipient", taskId: t.id, companyId: t.company_id, to: audience.to });
      continue;
    }
    if (audience.to === "managers" && audience.unowned) {
      log("info", "escalating unowned task to admins", { event: "cron.followup_unowned", taskId: t.id, companyId: t.company_id, assignedTo: t.assigned_to ?? null });
      unownedEscalated++;
    }
    for (const r of recipients) await deliver(t.company_id, t.id, audience.action, r, task, audience.reason);
  }

  return NextResponse.json({ ok: true, tasks: (tasks ?? []).length, notified, enqueued, unownedEscalated });
}
