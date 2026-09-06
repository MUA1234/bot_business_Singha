/**
 * Human wording for every refusal the assignment boundary can return, and for every state the
 * assignment area can be in.
 *
 * A separate module because `task-assignment.ts` carries `"use server"`, and a server-action file
 * may only export async functions. This is a pure lookup used by both the action and the client
 * control, so it lives where both can import it.
 *
 * Every refusal in the closed set has an entry. A refusal with no message renders as a silent
 * no-op, which is how a manager concludes work was handed over when it was not.
 */
const REFUSAL_MESSAGE: Record<string, string> = {
  unauthenticated: "Your session has expired. Sign in again.",
  not_found: "That item is no longer available to you.",
  insufficient_capability: "You do not have permission to assign work in this company.",
  target_not_in_company: "That person is not a member of this company.",
  target_not_active: "That person's membership is not active.",
  target_lacks_capability: "That person is not permitted to work assigned tasks.",
  target_unavailable: "That person is on approved leave.",
  no_effect_to_assign: "There is no task to assign yet.",
  stale_item: "Someone changed this while you were looking at it. Reload and try again.",
  condition_changed: "The evidence changed since this page loaded. Reload and review it again.",
  recommendation_stale:
    "The recommendation is out of date — that person's roles, capacity or leave have changed. Reload it.",
  override_reason_required: "Assigning someone other than the recommended person needs a reason.",
  state_does_not_admit_assignment: "This item is not at a stage where work can be assigned.",
  conflicting_retry: "A different assignment was already recorded under this submission.",
  unavailable: "The management tables are unavailable.",
};

export function assignmentMessage(refusal: string): string {
  // An unknown refusal gets a truthful, non-specific sentence rather than a raw database string:
  // the detail is logged on the server, never shown.
  return REFUSAL_MESSAGE[refusal] ?? "That assignment could not be recorded.";
}

/**
 * Every state the assignment area can be in.
 *
 * Distinct values rather than a boolean. "Nobody is assigned yet", "you may not assign", "there is
 * nothing to assign yet" and "already assigned to someone" are four different things, and
 * collapsing any of them into an absent control is how a screen becomes reassuring without being
 * true.
 */
export type AssignmentState =
  | "not_applicable"
  | "unavailable"
  | "no_effect_yet"
  | "capability_missing"
  | "state_not_assignable"
  | "assignable"
  | "assigned";

const STATE_MESSAGE: Record<AssignmentState, string> = {
  not_applicable: "This item has no task to assign.",
  unavailable: "Assignment status is unavailable.",
  no_effect_yet: "No task has been created for this item yet.",
  capability_missing: "You can see this but may not assign it. Ask someone who manages this work.",
  state_not_assignable: "This item is not at a stage where work can be assigned.",
  assignable: "Nobody is doing this yet. Assign it to someone who can.",
  assigned: "Assigned.",
};

export function assignmentStateMessage(state: AssignmentState): string {
  return STATE_MESSAGE[state];
}
