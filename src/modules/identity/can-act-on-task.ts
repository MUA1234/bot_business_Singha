/**
 * Pure task-action authorisation (NEXT_PHASE_DEVELOPER_BRIEF §WP1.2 `canActOnTask`,
 * enforcing the §WP3 permission rules). No I/O — the caller resolves membership,
 * capabilities and the task row, then asks this whether an action is allowed. Kept
 * pure so it is exhaustively unit-testable without a database.
 *
 *  - An assignee may update only permitted fields on their OWN assigned task.
 *  - An assignee may NOT reassign, approve completion, or verify their own task.
 *  - A manager (holds the `approve` capability) may manage tasks in their company.
 *  - An administrator may intervene on anything (the caller must audit it).
 *  - Evidence submission and evidence verification are distinct actions.
 */
export type TaskAction =
  | "view"
  | "update_progress"
  | "add_evidence"
  | "accept"
  | "submit_estimate"
  | "request_verification"
  | "reassign"
  | "edit_plan"
  | "approve_completion"
  | "verify"
  | "cancel";

export interface TaskActor {
  companyId: string;
  membershipId: string;
  userId: string;
  isAdmin: boolean;
  /** Manager = holds the `approve` capability in this company. */
  isManager: boolean;
}

export interface TaskRef {
  companyId: string;
  assignedToUserId: string | null;
  assigneeMembershipIds: string[];
}

export interface Decision {
  allowed: boolean;
  reason: string;
}

const ASSIGNEE_ALLOWED: ReadonlySet<TaskAction> = new Set<TaskAction>([
  "view",
  "update_progress",
  "add_evidence",
  "accept",
  "submit_estimate",
  "request_verification",
]);

// Actions an assignee may never perform on their own task (separation of duties).
const SELF_FORBIDDEN: ReadonlySet<TaskAction> = new Set<TaskAction>([
  "reassign",
  "approve_completion",
  "verify",
]);

const MANAGER_ALLOWED: ReadonlySet<TaskAction> = new Set<TaskAction>([
  "view",
  "update_progress",
  "add_evidence",
  "accept",
  "submit_estimate",
  "request_verification",
  "reassign",
  "edit_plan",
  "approve_completion",
  "verify",
  "cancel",
]);

function isAssignee(actor: TaskActor, task: TaskRef): boolean {
  if (task.assignedToUserId && task.assignedToUserId === actor.userId) return true;
  return task.assigneeMembershipIds.includes(actor.membershipId);
}

export function canActOnTask(actor: TaskActor, task: TaskRef, action: TaskAction): Decision {
  // Company scope first — never act across companies.
  if (actor.companyId !== task.companyId) {
    return { allowed: false, reason: "cross-company: actor and task are in different companies" };
  }

  // Administrators may intervene on anything (caller must record an audit event).
  if (actor.isAdmin) return { allowed: true, reason: "administrator intervention (audited)" };

  const assignee = isAssignee(actor, task);

  // Managers manage tasks in their company — but not self-approve/verify/reassign
  // their OWN task (separation of duties) unless they are an admin (handled above).
  if (actor.isManager) {
    if (assignee && SELF_FORBIDDEN.has(action)) {
      return { allowed: false, reason: `separation of duties: cannot ${action} own task` };
    }
    if (MANAGER_ALLOWED.has(action)) return { allowed: true, reason: "manager scope" };
    return { allowed: false, reason: `manager not permitted to ${action}` };
  }

  // Assignee acting on their own task: limited field set only.
  if (assignee) {
    if (ASSIGNEE_ALLOWED.has(action)) return { allowed: true, reason: "assignee on own task" };
    return { allowed: false, reason: `assignee not permitted to ${action}` };
  }

  // Any other company member: read-only.
  if (action === "view") return { allowed: true, reason: "company member read" };
  return { allowed: false, reason: "not assignee, manager, or admin" };
}
