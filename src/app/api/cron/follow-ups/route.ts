/**
 * Task follow-up loop (NEXT_PHASE_DEVELOPER_BRIEF §WP3.8 "the system follows up at
 * configurable intervals" + §WP4.7). A cron-triggered sweep that runs the pure
 * `evaluateFollowUp` engine over every active assigned task and ENQUEUES the matching
 * approved template (estimate request / overdue reminder / verification request /
 * escalation) into the outbox. The drain worker (`/api/cron/outbox`) delivers them.
 *
 * Secured by CRON_SECRET (fail-closed). It ONLY enqueues approved internal reminders —
 * never a customer commitment, never an execution. The daily dedupe bucket in the
 * idempotency key caps each reminder to once per task per assignee per day (no spam).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { evaluateFollowUp, type FollowUpAction } from "@/modules/work/follow-up";
import { InternalTemplates, type BuiltMessage } from "@/lib/whatsapp-templates";
import { enqueueOutbox } from "@/lib/outbox-enqueue";
import { writeAudit } from "@/lib/audit";
import { log } from "@/lib/log";

export const runtime = "nodejs";

const cleanPhone = (p?: string | null) => (p ?? "").replace(/[^\d]/g, "");
const today = () => new Date().toISOString().slice(0, 10);

interface Profile {
  id: string;
  company_id: string;
  phone: string | null;
  full_name: string | null;
  username: string | null;
  is_admin: boolean;
}

interface Task {
  id: string;
  company_id: string;
  title: string;
  status: string;
  due_date: string | null;
  updated_at: string;
}

interface Membership {
  id: string;
  user_id: string;
}

interface TaskAssignment {
  task_id: string;
  membership_id: string;
}

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

  const [{ data: profiles, error: profilesError }, { data: tasks, error: tasksError }] = await Promise.all([
    db.from("profiles").select("id, company_id, phone, full_name, username, is_admin").eq("is_active", true),
    db
      .from("tasks")
      .select("id, company_id, title, status, due_date, updated_at")
      .not("status", "in", "(completed,cancelled)")
      .limit(1000),
  ]);

  if (profilesError || tasksError) {
    log("error", "follow-ups read failed", {
      event: "follow_up.read_failed",
      profilesError: profilesError?.message,
      tasksError: tasksError?.message,
    });
    return NextResponse.json({ ok: false, error: "read failed" }, { status: 500 });
  }

  if ((tasks ?? []).length === 0) {
    return NextResponse.json({ ok: true, tasks: 0, enqueued: 0 });
  }

  const taskIds = (tasks ?? []).map((t: Task) => t.id);

  const [{ data: assignments, error: assignmentsError }, { data: memberships, error: membershipsError }] = await Promise.all([
    db.from("task_assignments").select("task_id, membership_id").in("task_id", taskIds),
    db.from("memberships").select("id, user_id").eq("status", "active"),
  ]);

  if (assignmentsError || membershipsError) {
    log("error", "follow-ups assignment read failed", {
      event: "follow_up.assignment_read_failed",
      assignmentsError: assignmentsError?.message,
      membershipsError: membershipsError?.message,
    });
    return NextResponse.json({ ok: false, error: "assignment read failed" }, { status: 500 });
  }

  const profileById = new Map<string, Profile>((profiles ?? []).map((p: Profile) => [p.id, p]));
  const adminsByCompany = new Map<string, Profile[]>();
  for (const p of profiles ?? []) {
    if (p.is_admin) adminsByCompany.set(p.company_id, [...(adminsByCompany.get(p.company_id) ?? []), p]);
  }

  const membershipById = new Map<string, Membership>((memberships ?? []).map((m: Membership) => [m.id, m]));
  const assigneesByTask = new Map<string, string[]>();
  for (const a of assignments ?? []) {
    const m = membershipById.get(a.membership_id);
    if (!m) continue;
    const list = assigneesByTask.get(a.task_id) ?? [];
    list.push(m.user_id);
    assigneesByTask.set(a.task_id, list);
  }

  const day = today();
  let enqueued = 0;
  let remindedTasks = 0;
  let escalatedTasks = 0;

  const buildFor = (action: FollowUpAction, name: string, task: { title: string; dueDate: string | null }): BuiltMessage => {
    if (action === "estimate_request") return InternalTemplates.estimateRequest(name, task);
    if (action === "overdue_reminder") return InternalTemplates.overdueReminder(name, task);
    if (action === "verification_request") return InternalTemplates.verificationRequest(name, task);
    return InternalTemplates.escalation(name, task, "needs attention");
  };

  const send = async (
    companyId: string,
    taskId: string,
    action: FollowUpAction,
    recipientId: string,
    phone: string,
    name: string,
    task: { title: string; dueDate: string | null },
  ) => {
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
    const decision = evaluateFollowUp({
      status: t.status,
      dueDate: t.due_date,
      lastActivityAt: t.updated_at,
      lastReminderAt: null,
    });
    if (!decision.due || !decision.action) continue;

    const task = { title: t.title, dueDate: t.due_date };

    if (decision.action === "escalation") {
      escalatedTasks++;
      for (const admin of adminsByCompany.get(t.company_id) ?? []) {
        const phone = cleanPhone(admin.phone);
        if (phone) {
          await send(t.company_id, t.id, "escalation", admin.id, phone, admin.full_name ?? admin.username ?? "there", task);
        }
      }
    } else {
      remindedTasks++;
      const userIds = assigneesByTask.get(t.id) ?? [];
      for (const userId of userIds) {
        const profile = profileById.get(userId);
        if (!profile) continue;
        const phone = cleanPhone(profile.phone);
        if (phone) {
          await send(t.company_id, t.id, decision.action, profile.id, phone, profile.full_name ?? profile.username ?? "there", task);
        }
      }
    }
  }

  if (enqueued > 0) {
    const action = escalatedTasks > 0 && remindedTasks === 0 ? "follow_up.escalated" : "follow_up.enqueued";
    await writeAudit({
      companyId: null,
      actorId: "system",
      actorType: "system",
      action,
      entityType: "task",
      payload: { tasks: (tasks ?? []).length, enqueued, remindedTasks, escalatedTasks, date: day },
    });
  }

  return NextResponse.json({ ok: true, tasks: (tasks ?? []).length, enqueued });
}
