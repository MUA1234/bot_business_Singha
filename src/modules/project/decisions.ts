/**
 * PRJ-004 — Per-project decision log helpers.
 *
 * Pure deterministic functions for decision status and option handling.
 */

export type ProjectDecisionStatus = "pending" | "decided" | "reversed";

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
}

export function isValidDecisionOption(options: DecisionOption[], optionId: string | null | undefined): boolean {
  if (!optionId) return false;
  return options.some((o) => o.id === optionId);
}

export function decisionStatusLabel(status: ProjectDecisionStatus, decidedOptionId?: string | null): string {
  if (status === "reversed") return "reversed";
  if (status === "decided") return decidedOptionId ? "decided" : "decided (no option recorded)";
  return "pending";
}
