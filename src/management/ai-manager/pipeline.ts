/**
 * Observation → plan (Architecture V2 change plan §6.2). Pure and deterministic:
 * turns a validated ManagementObservation into a plan the app can act on SAFELY —
 * concrete tasks to capture, whether human approval is required, and open questions.
 * It decides nothing sensitive: it only ever proposes `captured` tasks (a low-risk
 * informational action) and flags everything else for a human (Constitution §6).
 */
import type { ManagementObservation, AuthorityLevel } from "@/schemas/management";

export interface PlannedTask {
  title: string;
  note: string | null;
  /** Task requires human evidence to complete when the observation carries risk/impact. */
  requiresEvidence: boolean;
}

export interface ManagerPlan {
  tasks: PlannedTask[];
  requiredAuthority: AuthorityLevel;
  needsApproval: boolean; // anything above policy_controlled
  clarifications: string[]; // missing info to resolve first
  suggestedActions: string[]; // for the human to consider — never auto-run
  confidence: number;
}

const APPROVAL_LEVELS = new Set<AuthorityLevel>(["manager_approval", "specialist_approval", "owner_approval"]);

/** Any material impact means a completed task should require evidence. */
function hasImpact(o: ManagementObservation): boolean {
  const i = o.impact ?? {};
  return Boolean(i.financial || i.legal || i.operational || i.safety);
}

export function planFromObservation(o: ManagementObservation): ManagerPlan {
  const requiresEvidence = hasImpact(o);
  const tasks: PlannedTask[] = (o.detectedTasks ?? []).map((t) => ({
    title: t.title,
    note: t.note ?? null,
    requiresEvidence,
  }));

  return {
    tasks,
    requiredAuthority: o.requiredAuthority,
    needsApproval: APPROVAL_LEVELS.has(o.requiredAuthority),
    clarifications: o.missingInfo ?? [],
    suggestedActions: o.suggestedActions ?? [],
    confidence: o.confidence,
  };
}
