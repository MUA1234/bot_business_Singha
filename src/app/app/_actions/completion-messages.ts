/**
 * Human wording for every refusal the completion-claim boundary can return, and for every state
 * the completion control can be in.
 *
 * A separate module because `task-completion.ts` carries `"use server"`, and a server-action file
 * may only export async functions. This is a pure lookup used by both the action and the client
 * control, so it lives where both can import it.
 *
 * Every refusal in the closed set has an entry. A refusal with no message renders as a silent
 * no-op, which is how a person concludes their work was reported when it was not.
 */
const REFUSAL_MESSAGE: Record<string, string> = {
  unauthenticated: "Your session has expired. Sign in again.",
  not_found: "That item is no longer available to you.",
  task_not_linked: "That task is not the work this item is about.",
  insufficient_capability: "You do not have permission to report work complete.",
  task_unassigned: "Nobody is assigned to this task, so there is no one to report it complete.",
  not_assignee: "Only the person assigned to this task can report it complete.",
  task_not_terminal: "The task is not finished yet. Complete the task first.",
  evidence_required: "This task needs evidence attached before it can be reported complete.",
  stale_item: "Someone changed this while you were looking at it. Reload and try again.",
  action_changed: "The proposed action changed while you were looking at it. Reload it.",
  evidence_changed: "The evidence changed since this page loaded. Reload and check it again.",
  state_does_not_admit_claim: "This item is not at a stage where completion can be reported.",
  conflicting_retry: "A different claim was already recorded under this submission.",
  unavailable: "The management tables are unavailable.",
};

export function completionMessage(refusal: string): string {
  // An unknown refusal gets a truthful, non-specific sentence rather than a raw database string:
  // the detail is logged on the server, never shown.
  return REFUSAL_MESSAGE[refusal] ?? "That could not be recorded.";
}

/**
 * Every state the completion area can be in.
 *
 * Deliberately distinct values rather than a boolean. "The task is not done", "it is somebody
 * else's", "you have reported it and nobody has checked" and "the condition is still there" are
 * four different things, and collapsing any of them into "nothing to do here" is how a screen
 * becomes reassuring without being true.
 */
export type CompletionState =
  | "not_applicable"
  | "unavailable"
  | "task_unassigned"
  | "assigned_to_another"
  | "task_not_completed"
  | "evidence_required"
  | "capability_missing"
  | "state_not_claimable"
  | "claimable"
  | "claimed_awaiting_verification"
  | "verification_unavailable"
  | "condition_persists"
  | "contradicted"
  | "verified_resolved";

const STATE_MESSAGE: Record<CompletionState, string> = {
  not_applicable: "No task is linked to this item.",
  unavailable: "Completion status is unavailable.",
  task_unassigned: "The linked task is not assigned to anyone.",
  assigned_to_another: "The linked task is assigned to someone else.",
  task_not_completed: "The linked task is not finished yet.",
  evidence_required: "The linked task needs evidence before it can be reported complete.",
  capability_missing: "You do not have permission to report work on this item.",
  state_not_claimable: "This item is not at a stage where completion can be reported.",
  claimable: "You are assigned this work and the task is finished.",
  claimed_awaiting_verification:
    "You reported this complete. Nobody has checked whether the original problem still exists.",
  verification_unavailable: "This could not be checked. It has not been closed.",
  condition_persists: "The work was reported done, but the original problem is still there.",
  contradicted: "What was reported does not match the record. This has been reopened.",
  verified_resolved: "Checked: the original problem is resolved.",
};

export function completionStateMessage(state: CompletionState): string {
  return STATE_MESSAGE[state];
}
