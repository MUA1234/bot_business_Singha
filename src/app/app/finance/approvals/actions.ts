"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notify";
import { computeApprovalProgress, canActOnApproval } from "@/policy/approval-progress";

/** Approve or reject a pending approval request — company-scoped and SoD-gated. */
export async function actOnApproval(formData: FormData): Promise<void> {
  const p = await requireProfile();
  const requestId = String(formData.get("request_id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!requestId || (decision !== "approve" && decision !== "reject")) return;

  const db = supabaseAdmin();

  // Load the request scoped to the caller's company (never act by bare id).
  const { data: req } = await db
    .from("approval_requests")
    .select("id, status, approvals_required, submitted_by")
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

  // Separation of duties (interim profile model): finance/admin, not the submitter,
  // not already acted, request still pending.
  const gate = canActOnApproval({
    submitterUserId: req.submitted_by,
    actorUserId: p.userId,
    actorIsApprover: p.isAdmin || p.department === "finance",
    alreadyActedUserIds: acted,
    status: req.status,
  });
  if (!gate.allowed) return;

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
