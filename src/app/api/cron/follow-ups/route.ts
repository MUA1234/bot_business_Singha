/**
 * Task follow-up loop (NEXT_PHASE_DEVELOPER_BRIEF §WP3.8 "the system follows up at
 * configurable intervals" + §WP4.7). A cron-triggered sweep that runs the pure
 * `evaluateFollowUp` engine over every active assigned task and ENQUEUES the matching
 * approved template (estimate request / overdue reminder / verification request /
 * escalation) into the outbox. The drain worker (`/api/cron/outbox`) delivers them.
 *
 * SCH-003: the loop is leave and workload-aware. Assignees on approved leave are
 * skipped, and when several assignees are reachable the least-loaded available
 * person is reminded first. Escalation targets on leave are skipped and the chain
 * advances to the next available person.
 *
 * Secured by CRON_SECRET (fail-closed). It ONLY enqueues approved internal reminders —
 * never a customer commitment, never an execution. The daily dedupe bucket in the
 * idempotency key caps each reminder to once per task per assignee per day (no spam).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { evaluateFollowUp, selectEscalationTarget, type FollowUpAction } from "@/modules/work/follow-up";
import {
  evaluateAvailability,
  rankAvailableCandidates,
  selectBestAvailable,
  type AvailabilityResult,
} from "@/modules/work/availability";
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
  last_reminder_at: string | null;
  escalation_chain: string[] | null;
  escalation_level: number;
  escalated_to: string | null;
}

interface Membership {
  id: string;
  user_id: string;
}

interface TaskAssignment {
  task_id: string;
  membership_id: string;
}

interface LeaveRow {
  profile_id: string;
  start_date: string;
  end_date: string;
}

function parseChain(chain: unknown): string[] {
  if (Array.isArray(chain)) return chain.filter((c): c is string => typeof c === "string");
  return [];
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
      .select(
        "id, company_id, title, status, due_date, updated_at, last_reminder_at, escalation_chain, escalation_level, escalated_to",
      )
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
  const userIds = new Set<string>((profiles ?? []).map((p: Profile) => p.id));

  const [
    { data: assignments, error: assignmentsError },
    { data: memberships, error: membershipsError },
    { data: leaveRows, error: leaveError },
    { data: openTaskHours, error: workloadError },
    { data: allAssignments, error: allAssignmentsError },
  ] = await Promise.all([
    db.from("task_assignments").select("task_id, membership_id").in("task_id", taskIds),
    db.from("memberships").select("id, user_id").eq("status", "active"),
    db
      .from("leave_requests")
      .select("profile_id, start_date, end_date")
      .eq("status", "approved")
      .lte("start_date", today())
      .gte("end_date", today()),
    // Workload used to be read by EMBEDDING memberships and tasks inside a
    // task_assignments select, filtered on the embedded tables' columns. That embed
    // cannot be answered in this schema: task_assignments holds three foreign keys into
    // tasks and two into memberships, so PostgREST refuses the join as ambiguous
    // (PGRST201) and returns an error — which made `workloadError` truthy and this cron
    // return 500 on EVERY run. Two plain reads, joined below, cannot become ambiguous.
    // See src/lib/embeds.ts.
    db.from("tasks").select("id, estimate_hours").not("status", "in", "(completed,cancelled)").limit(5000),
    db.from("task_assignments").select("task_id, membership_id").limit(20000),
  ]);

  if (assignmentsError || membershipsError || leaveError || workloadError || allAssignmentsError) {
    log("error", "follow-ups assignment/availability read failed", {
      event: "follow_up.assignment_read_failed",
      assignmentsError: assignmentsError?.message,
      membershipsError: membershipsError?.message,
      leaveError: leaveError?.message,
      workloadError: workloadError?.message,
      allAssignmentsError: allAssignmentsError?.message,
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

  // Approved leave ranges by user.
  const leaveByUser = new Map<string, { start: string; end: string }[]>();
  for (const r of (leaveRows ?? []) as LeaveRow[]) {
    if (!userIds.has(r.profile_id)) continue;
    const list = leaveByUser.get(r.profile_id) ?? [];
    list.push({ start: r.start_date, end: r.end_date });
    leaveByUser.set(r.profile_id, list);
  }

  // Workload (active assigned estimated hours) by user, joined here rather than by an
  // embed. `membershipById` already holds ONLY active memberships (the query filters on
  // status), so an assignment whose membership is missing from it is an inactive member
  // and is skipped — exactly what the former `memberships!inner … status=active` did.
  const hoursByTask = new Map<string, number>(
    ((openTaskHours ?? []) as { id: string; estimate_hours: number | null }[]).map((t) => [
      t.id,
      Number(t.estimate_hours) || 0,
    ]),
  );
  const workloadByUser = new Map<string, number>();
  for (const a of (allAssignments ?? []) as { task_id: string; membership_id: string }[]) {
    const m = membershipById.get(a.membership_id);
    if (!m) continue; // inactive or unknown membership
    if (!hoursByTask.has(a.task_id)) continue; // task is completed/cancelled
    workloadByUser.set(m.user_id, (workloadByUser.get(m.user_id) ?? 0) + hoursByTask.get(a.task_id)!);
  }

  const day = today();
  const now = new Date().toISOString();
  let enqueued = 0;
  let remindedTasks = 0;
  let escalatedTasks = 0;
  let skippedLeave = 0;

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

  const availabilityFor = (userId: string): AvailabilityResult => {
    const capacity = {
      totalHours: 40,
      netCapacityHours: 40,
      allocatedHours: workloadByUser.get(userId) ?? 0,
      availableHours: 40 - (workloadByUser.get(userId) ?? 0),
      utilizationPct: 0,
      status: "healthy" as const,
    };
    return evaluateAvailability({ profileId: userId, approvedLeave: leaveByUser.get(userId) ?? [], capacity }, day);
  };

  const updates: { id: string; patch: Record<string, unknown> }[] = [];

  for (const t of tasks ?? []) {
    const decision = evaluateFollowUp({
      status: t.status,
      dueDate: t.due_date,
      lastActivityAt: t.updated_at,
      lastReminderAt: t.last_reminder_at,
    });
    if (!decision.due || !decision.action) continue;

    const task = { title: t.title, dueDate: t.due_date };
    const chain = parseChain(t.escalation_chain);

    if (decision.action === "escalation") {
      escalatedTasks++;
      // Advance past any on-leave chain members without persisting intermediate levels.
      let level = t.escalation_level ?? 0;
      let targetId: string | null = null;
      let nextLevel = level;
      let reason = "chain_exhausted";
      const safeChain = chain.filter((c) => typeof c === "string" && c.length > 0);
      while (level < safeChain.length) {
        const candidate = safeChain[level];
        if (!candidate) break;
        const avail = availabilityFor(candidate);
        if (avail.available) {
          targetId = candidate;
          nextLevel = level + 1;
          reason = `escalation_step_${nextLevel}`;
          break;
        }
        skippedLeave++;
        level++;
      }

      const targetProfile = targetId ? profileById.get(targetId) : null;

      if (targetProfile) {
        const phone = cleanPhone(targetProfile.phone);
        if (phone) {
          await send(t.company_id, t.id, "escalation", targetProfile.id, phone, targetProfile.full_name ?? targetProfile.username ?? "there", task);
        }
      } else {
        // Chain exhausted, or every chain member on leave. Fall back to ONE suitable
        // administrator OF THIS COMPANY — never to all of them, and never to somebody who
        // cannot act on it.
        //
        // DEFECT R1-F-001, corrected here. This previously iterated
        // `rankAvailableCandidates(...)` and notified every entry. That helper only SORTS
        // ("most available first"); it does not filter, so administrators on APPROVED LEAVE
        // were notified — the precise opposite of the SCH-003 invariant, and invisible
        // because the covering test asserted on source text rather than behaviour. Its
        // sibling, the ordinary reminder path below, had the guard all along.
        //
        // `selectBestAvailable` is the EXISTING helper that filters to available candidates
        // and returns the best one. Using it fixes three things at once: nobody on leave is
        // contacted, the notification is batched to a single recipient instead of being
        // broadcast to every administrator in the company, and the choice remains
        // workload-ranked. No new staff-selection mechanism is introduced.
        //
        // Company scope, active status and authority are already enforced upstream:
        // `adminsByCompany` is keyed by company, the profiles query filters `is_active`,
        // and only `is_admin` profiles are collected into it.
        const fallback = selectBestAvailable(
          (adminsByCompany.get(t.company_id) ?? []).map((a) => availabilityFor(a.id)),
        );
        const fallbackProfile = fallback ? profileById.get(fallback.profileId) : null;
        if (fallbackProfile) {
          const phone = cleanPhone(fallbackProfile.phone);
          if (phone) {
            await send(t.company_id, t.id, "escalation", fallbackProfile.id, phone, fallbackProfile.full_name ?? fallbackProfile.username ?? "there", task);
            targetId = fallbackProfile.id;
            reason = "fallback_available_admin";
          }
        }

        if (!targetId) {
          // NOBODY suitable is available. Record that truthfully and escalate to no one: a
          // task that claims an escalation which never happened is worse than one that
          // openly says it is waiting for a person. The next sweep re-evaluates.
          reason = "no_available_authorised_target";
        }
      }

      updates.push({
        id: t.id,
        patch: {
          status: "escalated",
          escalation_level: nextLevel,
          escalated_to: targetId,
          escalated_at: now,
          escalation_reason: reason,
          last_reminder_at: now,
        },
      });
    } else {
      remindedTasks++;
      const userIds = assigneesByTask.get(t.id) ?? [];
      const candidates = rankAvailableCandidates(userIds.map((id) => availabilityFor(id)));
      for (const avail of candidates) {
        if (!avail.available) {
          skippedLeave++;
          continue;
        }
        const profile = profileById.get(avail.profileId);
        if (!profile) continue;
        const phone = cleanPhone(profile.phone);
        if (phone) {
          await send(t.company_id, t.id, decision.action, profile.id, phone, profile.full_name ?? profile.username ?? "there", task);
        }
      }
      // If the task is currently escalated but a non-escalation reminder is due,
      // keep it escalated and notify the current escalated owner as well (recovery),
      // provided they are not on leave.
      if (t.status === "escalated" && t.escalated_to) {
        const escalatedAvail = availabilityFor(t.escalated_to);
        if (escalatedAvail.available) {
          const escalatedProfile = profileById.get(t.escalated_to);
          if (escalatedProfile) {
            const phone = cleanPhone(escalatedProfile.phone);
            if (phone) {
              await send(t.company_id, t.id, decision.action, escalatedProfile.id, phone, escalatedProfile.full_name ?? escalatedProfile.username ?? "there", task);
            }
          }
        } else {
          skippedLeave++;
        }
      }
      updates.push({ id: t.id, patch: { last_reminder_at: now } });
    }
  }

  // Persist reminder/escalation state so the next sweep can advance the chain.
  for (const u of updates) {
    const { error } = await db.from("tasks").update(u.patch).eq("id", u.id);
    if (error) {
      log("error", "follow-ups task update failed", { event: "follow_up.update_failed", taskId: u.id, error: error.message });
    }
  }

  if (enqueued > 0 || skippedLeave > 0) {
    const action = escalatedTasks > 0 && remindedTasks === 0 ? "follow_up.escalated" : "follow_up.enqueued";
    await writeAudit({
      companyId: null,
      actorId: "system",
      actorType: "system",
      action,
      entityType: "task",
      payload: { tasks: (tasks ?? []).length, enqueued, remindedTasks, escalatedTasks, skippedLeave, date: day },
    });
  }

  return NextResponse.json({ ok: true, tasks: (tasks ?? []).length, enqueued, skippedLeave });
}
