"use server";

import { revalidatePath } from "next/cache";
import { requireProfile, requireCapabilityStrict } from "@/lib/auth";
import { supabaseReadClient, supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { isV31FlagEnabled } from "@/config/flags";
import { createNotification } from "@/lib/notify";
import { uploadEvidenceFile } from "@/lib/documents";
import { assertTransition, type TaskState } from "@/modules/work/task-lifecycle";
import { authorizeTaskAction } from "@/lib/task-access";
import type { TaskAction } from "@/modules/identity/can-act-on-task";
import { applyWorkflowAction, type WorkflowAction } from "@/modules/work/task-progress";
import { enqueueOutbox } from "@/lib/outbox-enqueue";
import { InternalTemplates } from "@/lib/whatsapp-templates";
import { isOnLeave } from "@/modules/work/availability";
import { randomUUID } from "node:crypto";
import { createInternalTask } from "@/modules/work/create-internal-task";
import { directInsertTransport } from "@/kernel/execution/transports";
import type { CompanyId, UserId } from "@/kernel/ask-ai/identity";
import { log } from "@/lib/log";

/** Operations staff or an admin may manage tasks (create/assign/verify). */
async function requireOps() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "operations") throw new Error("Not allowed");
  return p;
}

/**
 * Authorise an action on an existing task for the signed-in user. Widen-only: an
 * Operations/admin manager keeps full access; additionally the ASSIGNEE (any
 * department) may perform their permitted actions on their own task (WP1/WP3).
 * Returns the caller's profile and the loaded task, or null if not allowed.
 */
async function authorizeOnTask(id: string, action: TaskAction) {
  const p = await requireProfile();
  const res = await authorizeTaskAction(p, id, action);
  if (!res.ok || !res.task) return null;
  return { p, task: res.task };
}

/**
 * The UI wrapper. It converts `FormData` into the typed command and does nothing else — the
 * business implementation lives in `createInternalTask` and is shared with the R2E executor
 * (R2E-F-002).
 *
 * The behaviour that changed: this used to contain
 *
 *     if (error) return;   // table missing (pre-migration) → no-op, no crash
 *
 * which returned normally when the insert failed, so a person saw the form clear and no task
 * appear, with nothing recorded anywhere. A failure is now reported through the command's
 * discriminated result and logged as an error. No audit event is written and the path is not
 * revalidated, because neither would be true.
 */
export async function createTask(formData: FormData): Promise<void> {
  const p = await requireOps();

  const result = await createInternalTask(directInsertTransport(supabaseWriteClient()), {
    companyId: p.companyId as CompanyId,
    // This transport cannot deduplicate — `tasks` has no idempotency column and altering a hosted
    // production table is outside this phase. The key is still required by the command, so the
    // shared contract stays one contract.
    idempotencyKey: randomUUID(),
    title: String(formData.get("title") ?? ""),
    description: String(formData.get("description") ?? "").trim() || null,
    requiresEvidence: formData.get("requires_evidence") === "on",
    createdBy: p.userId as UserId,
  });

  if (!result.ok) {
    // An empty title reaches here as `invalid_input`, which is the old silent `if (!title) return`
    // — still not an error worth logging loudly, but no longer indistinguishable from success.
    if (result.code !== "invalid_input") {
      log("error", "task creation failed", {
        event: "task.create_failed",
        code: result.code,
        error: result.message,
      });
    }
    return;
  }

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "task.created",
    entityType: "task",
    entityId: result.taskId,
    payload: { title: String(formData.get("title") ?? "").trim() },
  });
  revalidatePath("/app/operations/tasks");
}

/** Move a task to a new state — company-scoped and lifecycle-guarded. */
export async function setTaskStatus(formData: FormData): Promise<void> {
  const id = String(formData.get("task_id") ?? "");
  const to = String(formData.get("to") ?? "") as TaskState;
  if (!id || !to) return;

  // Widen-only auth: ops/admin manager OR the assignee (any dept) on their own task.
  const auth = await authorizeOnTask(id, "update_progress");
  if (!auth) return;
  const { p, task } = auth;

  // Deterministic lifecycle gate. Completing needs human-verified evidence (§10);
  // the UI never offers "completed" here, and this blocks it anyway if forced.
  const check = assertTransition(
    task.status as TaskState,
    to,
    to === "completed"
      ? { requiresEvidence: task.requires_evidence, hasEvidence: false, verifiedByHuman: true }
      : undefined,
  );
  if (!check.ok) return;

  await supabaseWriteClient()
    .from("tasks")
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", p.companyId);
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: `task.status.${to}`,
    entityType: "task",
    entityId: id,
  });
  revalidatePath("/app/operations/tasks");
  revalidatePath(`/app/operations/tasks/${id}`);
}

/** Assign a task to an employee and/or set its estimate (drives capacity). */
export async function assignTask(formData: FormData): Promise<void> {
  const p = await requireOps();
  const id = String(formData.get("task_id") ?? "");
  if (!id) return;
  const { data: task } = await supabaseReadClient().from("tasks").select("id").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!task) return;

  const patch: Record<string, unknown> = {};
  const assignee = String(formData.get("assigned_to") ?? "").trim();
  if (formData.has("assigned_to")) {
    if (assignee) {
      // Assignee must be an employee of the same company.
      const { data: emp } = await supabaseReadClient().from("profiles").select("id").eq("id", assignee).eq("company_id", p.companyId).maybeSingle();
      if (!emp) {
        patch.assigned_to = null;
      } else {
        // SCH-003: do not assign work to someone on approved leave.
        const today = new Date().toISOString().slice(0, 10);
        const { data: leave } = await supabaseReadClient()
          .from("leave_requests")
          .select("start_date, end_date")
          .eq("profile_id", assignee)
          .eq("status", "approved")
          .lte("start_date", today)
          .gte("end_date", today)
          .maybeSingle();
        if (leave && isOnLeave(today, [{ start: leave.start_date, end: leave.end_date }])) {
          await writeAudit({
            companyId: p.companyId,
            actorId: p.userId,
            action: "task.assignment_refused_leave",
            entityType: "task",
            entityId: id,
            payload: { assignee, start_date: leave.start_date, end_date: leave.end_date },
          });
          return;
        }
        patch.assigned_to = assignee;
      }
    } else {
      patch.assigned_to = null;
    }
  }
  const estRaw = String(formData.get("estimate_hours") ?? "").trim();
  if (estRaw !== "") patch.estimate_hours = Math.max(0, Number(estRaw) || 0);

  if (Object.keys(patch).length === 0) return;
  await supabaseWriteClient().from("tasks").update(patch).eq("id", id).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "task.assigned", entityType: "task", entityId: id, payload: patch });
  if (typeof patch.assigned_to === "string" && patch.assigned_to && patch.assigned_to !== p.userId) {
    await createNotification({ companyId: p.companyId, recipientId: patch.assigned_to, type: "task_assigned", title: "A task was assigned to you", link: `/app/operations/tasks/${id}` });
    // §WP4 durable outbound: enqueue an approved task-assignment template to the
    // assignee's WhatsApp (if a number is on file). The drain worker sends it; the
    // idempotency key makes a re-assignment of the same task a no-op.
    const { data: assigneeProfile } = await supabaseReadClient().from("profiles").select("phone, full_name, username").eq("id", patch.assigned_to).eq("company_id", p.companyId).maybeSingle();
    const { data: taskRow } = await supabaseReadClient().from("tasks").select("title, due_date").eq("id", id).eq("company_id", p.companyId).maybeSingle();
    const phone = (assigneeProfile?.phone ?? "").replace(/[^\d]/g, "");
    if (phone && taskRow) {
      const msg = InternalTemplates.taskAssignment(assigneeProfile?.full_name ?? assigneeProfile?.username ?? "there", {
        title: taskRow.title,
        dueDate: taskRow.due_date,
        taskUrl: undefined,
      });
      await enqueueOutbox({
        channel: "whatsapp",
        companyId: p.companyId,
        recipient: phone,
        body: msg.body,
        dedupeKey: `task_assign:${id}:${patch.assigned_to}`,
        templateName: msg.templateName,
        templateParams: [assigneeProfile?.full_name ?? assigneeProfile?.username ?? "there", taskRow.title],
      });
    }
  }
  revalidatePath(`/app/operations/tasks/${id}`);
  revalidatePath("/app/hr/capacity");
}

/** Confirm a task belongs to the caller's company; returns it or null. */
async function taskInCompany(id: string, companyId: string) {
  if (!id) return null;
  const { data } = await supabaseReadClient()
    .from("tasks")
    .select("id, status, requires_evidence")
    .eq("id", id)
    .eq("company_id", companyId)
    .maybeSingle();
  return data ?? null;
}

export async function addCheckIn(formData: FormData): Promise<void> {
  const id = String(formData.get("task_id") ?? "");
  const auth = await authorizeOnTask(id, "update_progress");
  if (!auth) return;
  const { p } = auth;
  const note = String(formData.get("note") ?? "").trim() || null;
  const pctRaw = String(formData.get("progress_pct") ?? "").trim();
  const progress_pct = pctRaw === "" ? null : Math.min(100, Math.max(0, Number(pctRaw) || 0));
  await supabaseWriteClient()
    .from("task_check_ins")
    .insert({ task_id: id, company_id: p.companyId, note, progress_pct, created_by: p.userId });
  revalidatePath(`/app/operations/tasks/${id}`);
}

export async function addEvidence(formData: FormData): Promise<void> {
  const id = String(formData.get("task_id") ?? "");
  const auth = await authorizeOnTask(id, "add_evidence");
  if (!auth) return;
  const { p } = auth;
  const kind = String(formData.get("kind") ?? "message");
  const reference = String(formData.get("reference") ?? "").trim() || null;
  await supabaseWriteClient()
    .from("task_evidence")
    .insert({ task_id: id, company_id: p.companyId, kind, reference, verified_by: p.userId });
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "task.evidence_added",
    entityType: "task",
    entityId: id,
    payload: { kind },
  });
  revalidatePath(`/app/operations/tasks/${id}`);
}

/** Set or replace the ordered escalation chain for a task (SCH-004). */
export async function setTaskEscalationChain(formData: FormData): Promise<void> {
  const p = await requireOps();
  const id = String(formData.get("task_id") ?? "");
  if (!id) return;
  const task = await taskInCompany(id, p.companyId);
  if (!task) return;

  const raw = String(formData.get("escalation_chain") ?? "").trim();
  const chain: string[] = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // Validate every user id belongs to the same company and is active.
  if (chain.length > 0) {
    const { data: validProfiles } = await supabaseReadClient()
      .from("profiles")
      .select("id")
      .in("id", chain)
      .eq("company_id", p.companyId)
      .eq("is_active", true);
    const valid = new Set((validProfiles ?? []).map((r) => r.id));
    const filtered = chain.filter((id) => valid.has(id));
    if (filtered.length !== chain.length) return; // reject silently on tampered input
  }

  await supabaseWriteClient()
    .from("tasks")
    .update({ escalation_chain: chain, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", p.companyId);
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "task.escalation_chain_set",
    entityType: "task",
    entityId: id,
    payload: { chain },
  });
  revalidatePath(`/app/operations/tasks/${id}`);
}

/** Upload a file as document evidence for a task. */
export async function uploadTaskEvidence(formData: FormData): Promise<void> {
  const id = String(formData.get("task_id") ?? "");
  const auth = await authorizeOnTask(id, "add_evidence");
  if (!auth) return;
  const { p } = auth;
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return;

  const up = await uploadEvidenceFile(p.companyId, file, p.userId);
  if (!up.ok || !up.documentId) return; // storage not configured or failed → no-op
  await supabaseWriteClient().from("task_evidence").insert({
    task_id: id, company_id: p.companyId, kind: "document", reference: file.name, document_id: up.documentId, verified_by: p.userId,
  });
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "task.evidence_uploaded", entityType: "task", entityId: id, payload: { documentId: up.documentId } });
  revalidatePath(`/app/operations/tasks/${id}`);
}

/**
 * Generic WP3 workflow runner: authorise → compute legal state+patch (pure) →
 * persist company-scoped → audit. `authAction` decides WHO may act (assignee vs
 * manager); the pure workflow decides WHAT the action does. Graceful: requires
 * migration 0025 columns; a missing-column error simply no-ops.
 */
async function runWorkflow(
  formData: FormData,
  workflow: WorkflowAction,
  authAction: TaskAction,
): Promise<void> {
  const id = String(formData.get("task_id") ?? "");
  const auth = await authorizeOnTask(id, authAction);
  if (!auth) return;
  const { p, task } = auth;

  const result = applyWorkflowAction(
    { status: task.status as any, requiresEvidence: task.requires_evidence, hasEvidence: false },
    {
      action: workflow,
      hours: (String(formData.get("hours") ?? "").trim() || undefined),
      reason: (String(formData.get("reason") ?? "").trim() || undefined),
      expectedCompletion: (String(formData.get("expected_completion") ?? "").trim() || undefined),
      byHuman: true,
    },
  );
  if (!result.ok || !result.toState) return;

  const patch: Record<string, unknown> = { ...result.patch, status: result.toState, updated_at: new Date().toISOString() };
  const { error } = await supabaseWriteClient().from("tasks").update(patch).eq("id", id).eq("company_id", p.companyId);
  if (error) return; // pre-migration or invalid → no-op
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: `task.workflow.${workflow}`,
    entityType: "task",
    entityId: id,
    payload: { to: result.toState },
  });
  revalidatePath(`/app/operations/tasks/${id}`);
  revalidatePath("/app/operations/tasks");
  revalidatePath("/app/me");
}

// Worker (assignee) actions — any department, own task only.
export const submitEstimate = (fd: FormData) => runWorkflow(fd, "submit_estimate", "submit_estimate");
export const declineTask = (fd: FormData) => runWorkflow(fd, "decline", "accept");
export const startTask = (fd: FormData) => runWorkflow(fd, "start", "update_progress");
export const logProgress = (fd: FormData) => runWorkflow(fd, "log_progress", "update_progress");
export const reportBlocker = (fd: FormData) => runWorkflow(fd, "report_blocker", "update_progress");
export const unblockTask = (fd: FormData) => runWorkflow(fd, "unblock", "update_progress");
export const submitForEvidence = (fd: FormData) => runWorkflow(fd, "submit_for_evidence", "update_progress");
export const requestVerification = (fd: FormData) => runWorkflow(fd, "request_verification", "request_verification");
// Manager actions — within scope.
export const acceptEstimate = (fd: FormData) => runWorkflow(fd, "accept_estimate", "edit_plan");
export const returnForCorrection = (fd: FormData) => runWorkflow(fd, "return_for_correction", "verify");

/** Complete a task — only from `verification`, and only WITH evidence when required. */
export async function completeTask(formData: FormData): Promise<void> {
  const p = await requireOps();
  const id = String(formData.get("task_id") ?? "");
  const task = await taskInCompany(id, p.companyId);
  if (!task) return;

  const { count } = await supabaseReadClient()
    .from("task_evidence")
    .select("id", { count: "exact", head: true })
    .eq("task_id", id)
    .eq("company_id", p.companyId);
  const hasEvidence = (count ?? 0) > 0;

  const check = assertTransition(task.status as TaskState, "completed", {
    requiresEvidence: task.requires_evidence,
    hasEvidence,
    verifiedByHuman: true,
  });
  if (!check.ok) return; // blocked: not in verification, or evidence required but missing

  await supabaseWriteClient()
    .from("tasks")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", p.companyId);
  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "task.completed",
    entityType: "task",
    entityId: id,
    payload: { hasEvidence },
  });
  revalidatePath("/app/operations/tasks");
  revalidatePath(`/app/operations/tasks/${id}`);
}

/**
 * AIM-007 — add a persistent AI Guide message to a task.
 * Gated to the `ai.guide.manage` capability and disabled unless the V3_1_AI_GUIDE
 * flag is enabled (default OFF). Proposed next actions are stored as JSON but are
 * proposals only; any execution flows through the normal authority/audit pipeline.
 */
export async function createAiGuideMessage(formData: FormData): Promise<void> {
  if (!isV31FlagEnabled("aiGuide")) return;
  const p = await requireCapabilityStrict("ai.guide.manage");

  const task_id = String(formData.get("task_id") ?? "").trim();
  const kind = String(formData.get("kind") ?? "next_action").trim();
  const body = String(formData.get("body") ?? "").trim();
  const visibility = String(formData.get("visibility") ?? "task_team").trim();
  const audienceRefsRaw = String(formData.get("audience_refs") ?? "").trim();
  const audience_refs = audienceRefsRaw
    ? audienceRefsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const confidenceRaw = String(formData.get("confidence") ?? "0.8").trim();
  const confidence = Math.min(1, Math.max(0, Number(confidenceRaw) || 0));
  const prompt_version = String(formData.get("prompt_version") ?? "1.0").trim();
  const schema_version = String(formData.get("schema_version") ?? "1.0").trim();

  const proposedRaw = String(formData.get("proposed_next_action") ?? "").trim() || null;
  let proposed_next_action: Record<string, unknown> | null = null;
  if (proposedRaw) {
    try {
      proposed_next_action = JSON.parse(proposedRaw) as Record<string, unknown>;
    } catch {
      proposed_next_action = null;
    }
  }

  if (!task_id || !body) return;

  const { data, error } = await supabaseWriteClient()
    .from("ai_guide_messages")
    .insert({
      company_id: p.companyId,
      task_id,
      kind,
      body,
      visibility,
      audience_refs,
      confidence,
      prompt_version,
      schema_version,
      proposed_next_action,
      created_by: p.userId,
    })
    .select("id")
    .maybeSingle();
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "ai_guide_message.created",
    entityType: "ai_guide_message",
    entityId: data?.id ?? null,
    payload: { task_id, kind, visibility },
  });
  revalidatePath(`/app/operations/tasks/${task_id}`);
}
