"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notify";
import { uploadEvidenceFile } from "@/lib/documents";
import { assertTransition, type TaskState } from "@/modules/work/task-lifecycle";
import { authorizeTaskAction } from "@/lib/task-access";
import type { TaskAction } from "@/modules/identity/can-act-on-task";
import { applyWorkflowAction, type WorkflowAction } from "@/modules/work/task-progress";

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

export async function createTask(formData: FormData): Promise<void> {
  const p = await requireOps();
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return;
  const description = String(formData.get("description") ?? "").trim() || null;
  const requires_evidence = formData.get("requires_evidence") === "on";

  const { data, error } = await supabaseAdmin()
    .from("tasks")
    .insert({
      company_id: p.companyId,
      title,
      description,
      status: "captured",
      requires_evidence,
      created_by: p.userId,
    })
    .select("id")
    .maybeSingle();
  if (error) return; // table missing (pre-migration) → no-op, no crash

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "task.created",
    entityType: "task",
    entityId: data?.id ?? null,
    payload: { title },
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

  await supabaseAdmin()
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
  const { data: task } = await supabaseAdmin().from("tasks").select("id").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!task) return;

  const patch: Record<string, unknown> = {};
  const assignee = String(formData.get("assigned_to") ?? "").trim();
  if (formData.has("assigned_to")) {
    if (assignee) {
      // Assignee must be an employee of the same company.
      const { data: emp } = await supabaseAdmin().from("profiles").select("id").eq("id", assignee).eq("company_id", p.companyId).maybeSingle();
      patch.assigned_to = emp ? assignee : null;
    } else {
      patch.assigned_to = null;
    }
  }
  const estRaw = String(formData.get("estimate_hours") ?? "").trim();
  if (estRaw !== "") patch.estimate_hours = Math.max(0, Number(estRaw) || 0);

  if (Object.keys(patch).length === 0) return;
  await supabaseAdmin().from("tasks").update(patch).eq("id", id).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "task.assigned", entityType: "task", entityId: id, payload: patch });
  if (typeof patch.assigned_to === "string" && patch.assigned_to && patch.assigned_to !== p.userId) {
    await createNotification({ companyId: p.companyId, recipientId: patch.assigned_to, type: "task_assigned", title: "A task was assigned to you", link: `/app/operations/tasks/${id}` });
  }
  revalidatePath(`/app/operations/tasks/${id}`);
  revalidatePath("/app/hr/capacity");
}

/** Confirm a task belongs to the caller's company; returns it or null. */
async function taskInCompany(id: string, companyId: string) {
  if (!id) return null;
  const { data } = await supabaseAdmin()
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
  await supabaseAdmin()
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
  await supabaseAdmin()
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
  await supabaseAdmin().from("task_evidence").insert({
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
  const { error } = await supabaseAdmin().from("tasks").update(patch).eq("id", id).eq("company_id", p.companyId);
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

  const { count } = await supabaseAdmin()
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

  await supabaseAdmin()
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
