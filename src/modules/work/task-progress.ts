/**
 * Worker task-progress workflow (NEXT_PHASE_DEVELOPER_BRIEF §WP3).
 *
 * Pure and deterministic. Decides, for a worker/manager action, the resulting task
 * state and the validated field patch to persist — composing the lifecycle guard in
 * `task-lifecycle.ts` (WHAT is a legal state move) with the workflow rules (WHICH
 * action a step allows). WHO may act is decided separately by `canActOnTask`.
 *
 * The full workflow (Brief §WP3):
 *   captured → (assign) awaiting_estimate → (worker accepts + estimates) scheduled
 *   → in_progress ⇄ blocked → awaiting_evidence → verification
 *   → completed | returned for correction (→ in_progress)
 */
import { assertTransition, type TaskState } from "@/modules/work/task-lifecycle";

export type WorkflowAction =
  | "accept" // worker accepts an assigned task
  | "decline" // worker declines (with reason)
  | "submit_estimate" // worker submits hours + expected completion
  | "accept_estimate" // manager accepts the estimate → scheduled
  | "start" // worker begins work
  | "log_progress" // worker logs actual/remaining hours + note
  | "report_blocker" // worker flags a blocker (with reason)
  | "unblock" // worker/manager clears the blocker
  | "submit_for_evidence" // worker finishes, moving to evidence/verification
  | "request_verification" // worker asks a manager to verify
  | "verify_complete" // manager/verifier completes (evidence-gated)
  | "return_for_correction" // manager sends it back to the worker
  | "request_extension"; // worker requests a later due date (no state change)

export interface TaskSnapshot {
  status: TaskState;
  requiresEvidence: boolean;
  hasEvidence: boolean;
}

export interface WorkflowInput {
  action: WorkflowAction;
  hours?: string; // numeric string for estimate / actual / remaining
  reason?: string;
  expectedCompletion?: string; // ISO date
  byHuman?: boolean; // for verify_complete (never the AI)
}

export interface WorkflowResult {
  ok: boolean;
  reason?: string;
  toState?: TaskState;
  /** column patch to apply on `tasks` (empty for pure state moves). */
  patch: Record<string, unknown>;
}

function fail(reason: string): WorkflowResult {
  return { ok: false, reason, patch: {} };
}

function nonNegHours(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Compute the resulting state + patch for a workflow action, or a failure reason. */
export function applyWorkflowAction(task: TaskSnapshot, input: WorkflowInput): WorkflowResult {
  const { action } = input;
  const from = task.status;

  // Actions that do NOT change state (metadata only).
  if (action === "log_progress") {
    const patch: Record<string, unknown> = {};
    const actual = nonNegHours(input.hours);
    if (actual !== null) patch.actual_hours = actual;
    // Optional remaining is carried via reason-free second field; callers pass hours=actual.
    if (from !== "in_progress" && from !== "blocked") {
      return fail(`cannot log progress from ${from}`);
    }
    return { ok: true, toState: from, patch };
  }
  if (action === "request_extension") {
    if (!input.expectedCompletion) return fail("extension needs an expected completion date");
    return { ok: true, toState: from, patch: { expected_completion: input.expectedCompletion } };
  }

  // State-changing actions → target state + guard via assertTransition.
  let to: TaskState;
  const patch: Record<string, unknown> = {};

  switch (action) {
    case "accept":
      to = from; // acceptance is recorded on the assignment, task stays awaiting_estimate
      if (from !== "awaiting_estimate") return fail(`cannot accept from ${from}`);
      return { ok: true, toState: to, patch };
    case "decline":
      if (!input.reason?.trim()) return fail("decline requires a reason");
      to = "planned"; // back to a manager to re-plan/re-assign
      patch.declined_reason = input.reason.trim();
      break;
    case "submit_estimate": {
      const est = nonNegHours(input.hours);
      if (est === null) return fail("estimate requires non-negative hours");
      to = from; // stays awaiting_estimate until the manager accepts
      if (from !== "awaiting_estimate") return fail(`cannot estimate from ${from}`);
      patch.estimate_hours = est;
      if (input.expectedCompletion) patch.expected_completion = input.expectedCompletion;
      return { ok: true, toState: to, patch };
    }
    case "accept_estimate":
      to = "scheduled";
      break;
    case "start":
      to = "in_progress";
      break;
    case "report_blocker":
      if (!input.reason?.trim()) return fail("blocker requires a reason");
      to = "blocked";
      patch.blocker_reason = input.reason.trim();
      break;
    case "unblock":
      to = "in_progress";
      patch.blocker_reason = null;
      break;
    case "submit_for_evidence":
      to = "awaiting_evidence";
      break;
    case "request_verification":
      to = "verification";
      break;
    case "verify_complete":
      to = "completed";
      break;
    case "return_for_correction":
      to = "in_progress";
      break;
    default:
      return fail(`unknown action ${action}`);
  }

  const guard = assertTransition(
    from,
    to,
    to === "completed"
      ? { requiresEvidence: task.requiresEvidence, hasEvidence: task.hasEvidence, verifiedByHuman: !!input.byHuman }
      : undefined,
  );
  if (!guard.ok) return fail(guard.reason);

  return { ok: true, toState: to, patch };
}
