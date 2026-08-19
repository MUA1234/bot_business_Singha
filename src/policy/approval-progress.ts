/**
 * Approval progress + separation-of-duties gate (Architecture V2 change plan §7,
 * §6.3). Pure and deterministic. Complements src/policy/authority.ts (which decides
 * WHAT approval a financial event needs) by tracking whether the collected approvals
 * satisfy the requirement and whether a given person is ALLOWED to act.
 *
 * Interim SoD uses the app's profile model (admin/finance, not the submitter, one
 * action per person). The full role/permission SoD in authority.ts applies once the
 * membership model is cut over (see IDENTITY_UNIFICATION_PLAN.md).
 */
export interface ApprovalAction {
  actorUserId: string;
  action: "approve" | "reject";
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalProgress {
  status: ApprovalStatus;
  approvals: number;
  rejections: number;
  remaining: number;
}

/** Any rejection kills it; enough distinct approvals passes it; else still pending. */
export function computeApprovalProgress(actions: ApprovalAction[], approvalsRequired: number): ApprovalProgress {
  const req = Math.max(1, approvalsRequired);
  const approvers = new Set<string>();
  let rejections = 0;
  for (const a of actions) {
    if (a.action === "reject") rejections++;
    else approvers.add(a.actorUserId);
  }
  const approvals = approvers.size;
  if (rejections > 0) return { status: "rejected", approvals, rejections, remaining: 0 };
  if (approvals >= req) return { status: "approved", approvals, rejections, remaining: 0 };
  return { status: "pending", approvals, rejections, remaining: req - approvals };
}

export interface ActEligibility {
  /** Null when the system submitted the request — then no approver is the submitter. */
  submitterUserId: string | null;
  actorUserId: string;
  actorIsApprover: boolean; // admin or finance in the interim model
  alreadyActedUserIds: string[];
  status: ApprovalStatus;
}

/** Whether `actorUserId` may approve/reject this request right now. */
export function canActOnApproval(e: ActEligibility): { allowed: boolean; reason: string } {
  if (e.status !== "pending") return { allowed: false, reason: `request is already ${e.status}` };
  if (!e.actorIsApprover) return { allowed: false, reason: "actor is not an approver" };
  // A system-submitted request has no human submitter, so it excludes nobody. It also cannot be
  // created by a person: migration 0081 refuses `submitted_by_source = 'system'` to any non-service
  // caller, so this branch can never be reached by someone approving their own request.
  if (e.submitterUserId !== null && e.actorUserId === e.submitterUserId) {
    return { allowed: false, reason: "submitter cannot approve their own request" };
  }
  if (e.alreadyActedUserIds.includes(e.actorUserId)) return { allowed: false, reason: "actor has already acted" };
  return { allowed: true, reason: "eligible" };
}
