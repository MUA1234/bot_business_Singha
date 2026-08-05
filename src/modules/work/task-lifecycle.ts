/**
 * Task lifecycle state machine (Architecture V2 change plan §7.3, diagram 6).
 * Pure and deterministic — the single authority on which task transitions are legal.
 * The AI may PROPOSE a transition, but only a legal, evidence-satisfying transition
 * is ever applied (Constitution §10: never mark work verified on a say-so when
 * acceptance criteria require human/system/financial/site evidence).
 */

export type TaskState =
  | "captured"
  | "clarifying"
  | "planned"
  | "awaiting_estimate"
  | "scheduled"
  | "in_progress"
  | "blocked"
  | "awaiting_evidence"
  | "verification"
  | "completed"
  | "overdue"
  | "escalated"
  | "cancelled"
  | "reopened";

export const TASK_STATES: readonly TaskState[] = [
  "captured", "clarifying", "planned", "awaiting_estimate", "scheduled",
  "in_progress", "blocked", "awaiting_evidence", "verification", "completed",
  "overdue", "escalated", "cancelled", "reopened",
] as const;

/** Legal transitions (from → allowed next states). */
const TRANSITIONS: Record<TaskState, TaskState[]> = {
  captured: ["clarifying", "planned", "cancelled"],
  clarifying: ["captured", "cancelled"],
  planned: ["awaiting_estimate", "cancelled"],
  awaiting_estimate: ["scheduled", "planned", "cancelled"],
  scheduled: ["in_progress", "overdue", "cancelled"],
  in_progress: ["blocked", "awaiting_evidence", "overdue", "cancelled"],
  blocked: ["in_progress", "escalated", "cancelled"],
  awaiting_evidence: ["verification", "in_progress"],
  verification: ["completed", "in_progress"],
  overdue: ["in_progress", "escalated", "cancelled"],
  escalated: ["in_progress", "planned", "cancelled"],
  completed: ["reopened"],
  reopened: ["in_progress", "planned"],
  cancelled: [],
};

/** Terminal unless explicitly reopened. */
export function isTerminal(state: TaskState): boolean {
  return state === "cancelled" || state === "completed";
}

export function allowedTransitions(from: TaskState): TaskState[] {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return allowedTransitions(from).includes(to);
}

export interface VerificationContext {
  /** Acceptance criteria demand human/system/financial/site proof. */
  requiresEvidence: boolean;
  /** Verifiable evidence has actually been supplied. */
  hasEvidence: boolean;
  /** The actor completing verification is a human (not the AI). */
  verifiedByHuman: boolean;
}

/**
 * Guard for verification → completed. Even when the transition is structurally
 * legal, work cannot be marked complete without the required evidence, and never
 * autonomously by the AI when evidence is required (Constitution §10).
 */
export function canComplete(ctx: VerificationContext): boolean {
  if (!ctx.requiresEvidence) return true;
  return ctx.hasEvidence && ctx.verifiedByHuman;
}

/** Full check used by the domain service before applying a transition. */
export function assertTransition(
  from: TaskState,
  to: TaskState,
  ctx?: VerificationContext,
): { ok: true } | { ok: false; reason: string } {
  if (!canTransition(from, to)) {
    return { ok: false, reason: `illegal transition ${from} → ${to}` };
  }
  if (from === "verification" && to === "completed") {
    if (!ctx) return { ok: false, reason: "verification context required to complete" };
    if (!canComplete(ctx)) return { ok: false, reason: "completion requires human-verified evidence" };
  }
  return { ok: true };
}
