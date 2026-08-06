/**
 * WP1/WP3 task authorisation glue (widen-only, safe for the live pilot).
 *
 * Purpose: let an assignee in ANY department act on their OWN task without gaining
 * Operations access, while keeping manager-only actions manager-only. This layers the
 * pure `canActOnTask` rules on top of the existing company-scoped service-role reads —
 * it does NOT flip the app onto the RLS client (that is a later, staged slice) and it
 * only ever WIDENS access, so no current Operations/admin capability is removed.
 *
 * "Manager" here is the app's current manager notion (admin or Operations). Once the
 * capability cutover lands, manager = holds the `approve` capability (migration 0023).
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type { SessionProfile } from "@/lib/auth";
import { canActOnTask, type TaskAction } from "@/modules/identity/can-act-on-task";

export interface LoadedTask {
  id: string;
  status: string;
  requires_evidence: boolean;
  company_id: string;
  assigned_to: string | null;
}

async function loadTask(id: string, companyId: string): Promise<LoadedTask | null> {
  if (!id) return null;
  const { data } = await supabaseAdmin()
    .from("tasks")
    .select("id, status, requires_evidence, company_id, assigned_to")
    .eq("id", id)
    .eq("company_id", companyId)
    .maybeSingle();
  return (data as LoadedTask) ?? null;
}

/** Membership ids for this user in this company (forward-compat assignment path). */
async function membershipIds(userId: string, companyId: string): Promise<string[]> {
  const { data } = await supabaseAdmin()
    .from("memberships")
    .select("id")
    .eq("user_id", userId)
    .eq("company_id", companyId)
    .eq("status", "active");
  return (data as { id: string }[] | null)?.map((r) => r.id) ?? [];
}

async function assigneeMembershipIds(taskId: string, companyId: string): Promise<string[]> {
  const { data } = await supabaseAdmin()
    .from("task_assignments")
    .select("membership_id")
    .eq("task_id", taskId)
    .eq("company_id", companyId);
  return (data as { membership_id: string | null }[] | null)
    ?.map((r) => r.membership_id)
    .filter((x): x is string => !!x) ?? [];
}

/**
 * Authorise `action` on task `id` for the given profile. Loads the task once and
 * returns it so the caller can act without re-fetching. `null` task ⇒ not allowed.
 */
export async function authorizeTaskAction(
  profile: SessionProfile,
  id: string,
  action: TaskAction,
): Promise<{ ok: boolean; task: LoadedTask | null; reason: string }> {
  const task = await loadTask(id, profile.companyId);
  if (!task) return { ok: false, task: null, reason: "not found in company" };

  const myMemberships = await membershipIds(profile.userId, profile.companyId);
  const assignee = await assigneeMembershipIds(task.id, task.company_id);

  const decision = canActOnTask(
    {
      companyId: profile.companyId,
      membershipId: myMemberships[0] ?? "",
      userId: profile.userId,
      isAdmin: profile.isAdmin,
      // Current manager notion: admin or Operations. Widen-only.
      isManager: profile.isAdmin || profile.department === "operations",
    },
    {
      companyId: task.company_id,
      assignedToUserId: task.assigned_to,
      assigneeMembershipIds: assignee,
    },
    action,
  );
  return { ok: decision.allowed, task, reason: decision.reason };
}

/** May this profile view the task detail page? Ops/admin or the assignee. */
export async function canViewTask(profile: SessionProfile, id: string): Promise<boolean> {
  const { ok } = await authorizeTaskAction(profile, id, "view");
  return ok;
}
