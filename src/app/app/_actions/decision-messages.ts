/**
 * Human wording for every refusal the decision boundary can return.
 *
 * A separate module because `management-decision.ts` carries `"use server"`, and a server-action
 * file may only export async functions. This is a pure lookup used by both the action and the
 * client control, so it lives where both can import it.
 *
 * Every refusal in the closed set has an entry. A refusal with no message would render as a silent
 * no-op, which is exactly how a person concludes their decision was recorded when it was not.
 */
const REFUSAL_MESSAGE: Record<string, string> = {
  unauthenticated: "Your session has expired. Sign in again.",
  not_found: "That item is no longer available to you.",
  insufficient_capability: "You do not have permission to decide this.",
  unresolved_authority:
    "This needs an authority this system cannot yet verify. It has to be decided outside the app.",
  reason_required: "A reason is required to reject.",
  stale_item: "Someone changed this while you were looking at it. Reload and decide again.",
  action_changed: "The proposed action changed while you were looking at it. Reload it.",
  evidence_changed: "The evidence changed since this was recommended. Reload and review it again.",
  state_does_not_admit_decision: "This item is no longer awaiting a decision.",
  conflicting_retry: "A different decision was already recorded under this submission.",
  unavailable: "The management tables are unavailable.",
};

export function decisionMessage(refusal: string): string {
  // An unknown refusal gets a truthful, non-specific sentence rather than a raw database string:
  // the detail is logged on the server, never shown.
  return REFUSAL_MESSAGE[refusal] ?? "That decision could not be recorded.";
}
