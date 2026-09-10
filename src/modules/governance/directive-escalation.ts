/**
 * GOV-002 — Directive escalation decision engine.
 *
 * Pure, deterministic helper that decides whether an unacknowledged directive
 * should advance up its escalation chain or become overdue. The cron route
 * calls this and then performs the database updates / audit writes.
 */

export type DirectiveStatus = "issued" | "acknowledged" | "overdue" | "closed" | "escalated";

export interface EscalatableDirective {
  id: string;
  status: DirectiveStatus;
  response_required_by: string;
  escalation_chain: string[] | null;
  escalation_level: number;
  acknowledged_at?: string | null;
}

export interface EscalationDecision {
  newStatus: "escalated" | "overdue";
  escalation_level: number;
  escalated_to: string | null;
  escalated_at: string;
  escalation_reason: string;
  auditAction: "management_directive.escalated" | "management_directive.overdue";
}

/**
 * Evaluate a single directive for escalation at a given point in time.
 *
 * Returns null when:
 *   - the directive is terminal (acknowledged/closed),
 *   - the response window has not yet expired,
 *   - the directive is already overdue and the chain is exhausted.
 */
export function evaluateDirectiveEscalation(
  directive: EscalatableDirective,
  now: Date,
): EscalationDecision | null {
  // Terminal states never escalate.
  if (directive.status === "acknowledged" || directive.status === "closed") return null;
  if (directive.acknowledged_at) return null;

  const due = new Date(directive.response_required_by);
  if (Number.isNaN(due.getTime())) return null;
  if (due.getTime() > now.getTime()) return null;

  const chain = directive.escalation_chain ?? [];
  const chainLength = chain.length;
  const isoDue = directive.response_required_by;
  const isoNow = now.toISOString();

  // Advance up the chain while there are remaining recipients.
  if (directive.escalation_level < chainLength) {
    const nextLevel = directive.escalation_level + 1;
    const escalatedTo = chain[nextLevel - 1] ?? null;
    return {
      newStatus: "escalated",
      escalation_level: nextLevel,
      escalated_to: escalatedTo,
      escalated_at: isoNow,
      escalation_reason: `Response required by ${isoDue} missed`,
      auditAction: "management_directive.escalated",
    };
  }

  // Chain exhausted: become (or remain) overdue. Only transition if not already overdue
  // so the audit event and cron summary stay idempotent.
  if (directive.status !== "overdue") {
    return {
      newStatus: "overdue",
      escalation_level: directive.escalation_level,
      escalated_to: null,
      escalated_at: isoNow,
      escalation_reason: `Response required by ${isoDue} missed; escalation chain exhausted`,
      auditAction: "management_directive.overdue",
    };
  }

  return null;
}
