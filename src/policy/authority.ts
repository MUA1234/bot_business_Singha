/**
 * Deterministic policy & approval engine. Guide §10 (separation of duties) and
 * §18 (owner thresholds). This is the ONLY place that decides whether something
 * may auto-approve, needs human approval, or must be rejected. It is pure and
 * fully unit-tested. AI free text never reaches here — only a validated
 * extraction + the owner-configured policy do (guide §2 rule 8).
 */
import { Money } from "@/lib/money";
import type { AiExtraction } from "@/schemas/ai-extraction";
import type { ApprovalPolicy, ApprovalRule, Permission, Role } from "@/schemas/approval-policy";

export interface PolicyDecision {
  outcome: "auto_approve" | "require_approval" | "reject";
  matched_rule_id: string | null;
  required_approver_roles: Role[];
  approvals_required: number;
  reasons: string[];
}

/** A candidate event to evaluate. Amount/currency come from the *validated* draft. */
export interface EvaluatableEvent {
  event_type: string;
  amount: string | null;
  currency: string;
  has_evidence: boolean;
  risk_flags: string[];
}

function amountInBand(amount: Money | null, rule: ApprovalRule, currency: string): boolean {
  if (amount === null) return rule.min_amount === null && rule.max_amount === null;
  if (rule.min_amount !== null && amount.compare(Money.of(rule.min_amount, currency)) < 0) return false;
  if (rule.max_amount !== null && amount.compare(Money.of(rule.max_amount, currency)) > 0) return false;
  return true;
}

function ruleMatches(event: EvaluatableEvent, rule: ApprovalRule, policyCurrency: string): boolean {
  if (rule.event_types && !rule.event_types.includes(event.event_type)) return false;
  if (rule.currency && rule.currency !== event.currency) return false;
  const amount = event.amount === null ? null : Money.of(event.amount, event.currency);
  if (!amountInBand(amount, rule, policyCurrency)) return false;
  return true;
}

/**
 * Evaluate a validated event against the company's approval policy. First rule
 * (by priority ascending) that matches wins. Auto-approve is only ever granted
 * when the rule allows it AND no blocking risk flag is present AND evidence
 * requirements are met AND the event type is not in `never_auto`.
 */
export function evaluatePolicy(event: EvaluatableEvent, policy: ApprovalPolicy): PolicyDecision {
  const reasons: string[] = [];

  if (policy.never_auto.includes(event.event_type)) {
    reasons.push(`event_type "${event.event_type}" is in never_auto`);
  }

  const rules = [...policy.rules].sort((a, b) => a.priority - b.priority);
  const matched = rules.find((r) => ruleMatches(event, r, policy.currency));

  if (!matched) {
    return {
      outcome: "require_approval",
      matched_rule_id: null,
      required_approver_roles: ["finance_reviewer"],
      approvals_required: 1,
      reasons: [...reasons, "no matching rule — defaulting to human approval (fail-safe)"],
    };
  }

  const blockingFlags = event.risk_flags.filter((f) => matched.block_auto_approve_risk_flags.includes(f));
  const evidenceOk = matched.require_evidence ? event.has_evidence : true;
  if (!evidenceOk) reasons.push("evidence required but missing");
  if (blockingFlags.length) reasons.push(`blocking risk flags: ${blockingFlags.join(", ")}`);

  const canAuto =
    matched.auto_approve &&
    !policy.never_auto.includes(event.event_type) &&
    blockingFlags.length === 0 &&
    evidenceOk;

  if (canAuto) {
    return {
      outcome: "auto_approve",
      matched_rule_id: matched.id,
      required_approver_roles: [],
      approvals_required: 0,
      reasons: [...reasons, `auto-approved by rule ${matched.id}`],
    };
  }

  return {
    outcome: "require_approval",
    matched_rule_id: matched.id,
    required_approver_roles: matched.required_approver_roles,
    approvals_required: Math.max(1, matched.approvals_required),
    reasons: [...reasons, `human approval required by rule ${matched.id}`],
  };
}

export interface Approver {
  user_id: string;
  roles: Role[];
  permissions: Permission[];
}

export interface SoDContext {
  submitter_user_id: string;
  /** true if the event benefits this approver personally (own reimbursement/advance). */
  approver_is_beneficiary: boolean;
  /** the sensitive action being approved, if any. */
  action: Permission | null;
}

/**
 * Separation-of-duties gate. Guide §10: "No user should approve their own
 * sensitive reimbursement or supplier bank-detail change." Also enforces that the
 * approver actually holds `approve` and one required role, and is not the submitter
 * for sensitive actions.
 */
export function checkSeparationOfDuties(
  approver: Approver,
  requiredRoles: Role[],
  ctx: SoDContext,
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (!approver.permissions.includes("approve")) {
    reasons.push("approver lacks 'approve' permission");
  }
  if (requiredRoles.length && !requiredRoles.some((r) => approver.roles.includes(r))) {
    reasons.push(`approver holds none of the required roles: ${requiredRoles.join(", ")}`);
  }
  if (approver.user_id === ctx.submitter_user_id) {
    reasons.push("submitter cannot approve their own submission");
  }
  if (ctx.approver_is_beneficiary) {
    reasons.push("approver is the beneficiary — self-approval blocked");
  }
  const sensitive: Permission[] = ["change_supplier_bank_details", "authorize_payment", "initiate_payment"];
  if (ctx.action && sensitive.includes(ctx.action) && approver.user_id === ctx.submitter_user_id) {
    reasons.push(`sensitive action ${ctx.action} requires a second person`);
  }

  return { allowed: reasons.length === 0, reasons };
}

/** Convenience: derive an EvaluatableEvent from a validated AI extraction + draft state. */
export function toEvaluatable(x: AiExtraction, hasEvidence: boolean): EvaluatableEvent {
  return {
    event_type: x.event_type,
    amount: x.amount,
    currency: x.currency ?? "LKR",
    has_evidence: hasEvidence,
    risk_flags: x.risk_flags,
  };
}
