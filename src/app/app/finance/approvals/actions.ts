"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notify";
import { computeApprovalProgress, canActOnApproval } from "@/policy/approval-progress";
import { checkSeparationOfDuties } from "@/policy/authority";
import { role, type Role } from "@/schemas/approval-policy";
import { getApproverForUser } from "@/lib/access";

/** Approve or reject a pending approval request — company-scoped and SoD-gated. */
export async function actOnApproval(formData: FormData): Promise<void> {
  const p = await requireProfile();
  const requestId = String(formData.get("request_id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!requestId || (decision !== "approve" && decision !== "reject")) return;

  const db = supabaseWriteClient();

  // Load the request scoped to the caller's company (never act by bare id).
  const { data: req } = await db
    .from("approval_requests")
    .select("id, status, approvals_required, submitted_by, financial_event_id")
    .eq("id", requestId)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!req) return;

  const { data: actions } = await db
    .from("approval_actions")
    .select("actor_user_id, action")
    .eq("approval_request_id", requestId)
    .eq("company_id", p.companyId);
  const acted = (actions ?? []).map((a: any) => a.actor_user_id);

  // GOV-005 — use the deterministic separation-of-duties engine (src/policy/authority.ts)
  // instead of the interim profile-model string comparison. Load the actor's membership
  // roles/permissions and the policy-evaluation required roles (default finance_reviewer).
  const approver = await getApproverForUser(p.userId, p.companyId);
  if (!approver) return;
  const { data: evalRow } = await db
    .from("policy_evaluations")
    .select("required_approver_roles")
    .eq("financial_event_id", req.financial_event_id)
    .eq("company_id", p.companyId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const rawRoles = (evalRow?.required_approver_roles as string[] | null) ?? ["finance_reviewer"];
  const allowedRoles = new Set(role.options as readonly string[]);
  const requiredRoles: Role[] = rawRoles.filter((r): r is Role => allowedRoles.has(r));
  if (requiredRoles.length === 0) requiredRoles.push("finance_reviewer");
  const sod = checkSeparationOfDuties(approver, requiredRoles, {
    submitter_user_id: req.submitted_by,
    approver_is_beneficiary: false,
    action: null,
  });

  // Interim progress gate still guards status / already-acted (defence in depth).
  const interim = canActOnApproval({
    submitterUserId: req.submitted_by,
    actorUserId: p.userId,
    actorIsApprover: sod.allowed,
    alreadyActedUserIds: acted,
    status: req.status,
  });
  if (!sod.allowed || !interim.allowed) return;

  const { error } = await db.from("approval_actions").insert({
    approval_request_id: requestId,
    company_id: p.companyId,
    actor_user_id: p.userId,
    action: decision,
  });
  if (error) return; // unique constraint (one action per approver) or other → no-op

  // Recompute status from the full set of actions.
  const all = [...(actions ?? []).map((a: any) => ({ actorUserId: a.actor_user_id, action: a.action })), { actorUserId: p.userId, action: decision as "approve" | "reject" }];
  const progress = computeApprovalProgress(all, req.approvals_required);
  if (progress.status !== req.status) {
    await db.from("approval_requests").update({ status: progress.status }).eq("id", requestId).eq("company_id", p.companyId);
    if ((progress.status === "approved" || progress.status === "rejected") && req.submitted_by) {
      await createNotification({ companyId: p.companyId, recipientId: req.submitted_by, type: "approval_decided", title: `Your request was ${progress.status}`, link: "/app/finance/approvals" });
    }
  }

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: `approval.${decision}`,
    entityType: "approval_request",
    entityId: requestId,
    payload: { resulting_status: progress.status },
  });
  revalidatePath("/app/finance/approvals");
}
