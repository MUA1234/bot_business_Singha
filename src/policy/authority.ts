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
import type { Delegation } from "@/modules/identity/delegation";
import {
  resolveDelegatedAuthority,
  type Ceiling,
  type DelegateStatus,
  type DelegatorAuthority,
} from "@/modules/identity/delegation-authority";

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

/**
 * Delegation-aware authority check (NEXT_PHASE_DEVELOPER_BRIEF §WP1.7).
 *
 * Composes separation-of-duties with a temporary delegation: hard SoD blocks
 * (approving your own submission, being the beneficiary, a sensitive action needing a
 * second person) can NEVER be overridden by a delegation. But when the only gap is a
 * missing role/permission, an active, in-window, in-ceiling delegation to this
 * approver grants the authority. Pure and fully unit-tested.
 */
export interface DelegatedAuthorityInput {
  approver: Approver;
  requiredRoles: Role[];
  ctx: SoDContext;
  /**
   * Optional delegation context; when present it can substitute for a missing role.
   *
   * `delegatorFor` and `delegateStatus` are REQUIRED whenever this is supplied. Without them the
   * delegator's own authority cannot be established, and unknown authority is never permission —
   * so the delegation is refused rather than honoured (defect R2B-F-001).
   */
  delegation?: {
    membershipId: string;
    companyId: string;
    domain: string;
    amount: string; // decimal string
    currency: string;
    delegations: Delegation[];
    now?: Date;
    /** The delegator's OWN authority, resolved from company rules — never from the delegation. */
    delegatorFor?: (fromMembershipId: string) => DelegatorAuthority | null;
    /** The delegate's live membership standing, revalidated at the moment of exercise. */
    delegateStatus?: DelegateStatus | null;
  };
}

/**
 * The authority path that justified the decision. `null` when nothing did.
 *
 * The owner requires direct and delegated authority to be DISTINGUISHED and RECORDED — an audit
 * that says only "approved" cannot answer "on whose authority", which is the first question
 * asked when a payment turns out to be wrong.
 */
export interface AuthorityDecision {
  allowed: boolean;
  via: "own" | "delegation" | null;
  reasons: string[];
  /** Populated only when `via === "delegation"`. */
  delegation?: {
    delegationId: string;
    effectiveCeiling: Ceiling | null;
    /** Which side of MIN(delegation, delegator) actually bound. */
    boundBy: "delegation" | "delegator" | "none";
  };
  /** A machine-readable refusal code when a delegation was offered and refused. */
  refusalCode?: string;
}

export function checkAuthority(input: DelegatedAuthorityInput): AuthorityDecision {
  const { approver, requiredRoles, ctx, delegation } = input;

  // Hard separation-of-duties blocks — never overridable by a delegation.
  const hard: string[] = [];
  if (ctx.approver_is_beneficiary) hard.push("approver is the beneficiary — self-approval blocked");
  if (approver.user_id === ctx.submitter_user_id) hard.push("submitter cannot approve their own submission");
  const sensitive: Permission[] = ["change_supplier_bank_details", "authorize_payment", "initiate_payment"];
  if (ctx.action && sensitive.includes(ctx.action) && approver.user_id === ctx.submitter_user_id) {
    hard.push(`sensitive action ${ctx.action} requires a second person`);
  }
  if (hard.length) return { allowed: false, via: null, reasons: hard };

  // ── DIRECT authority first, and it is INDEPENDENT of any delegation.
  //    A delegate who also holds the role in their own right is authorised on the direct path,
  //    and a bad or expired delegation cannot take that away from them.
  const ownOk =
    approver.permissions.includes("approve") &&
    (requiredRoles.length === 0 || requiredRoles.some((r) => approver.roles.includes(r)));
  if (ownOk) return { allowed: true, via: "own", reasons: ["authorised by own role/permission"] };

  if (!delegation) {
    return {
      allowed: false,
      via: null,
      reasons: ["approver lacks required role/permission and no delegation was offered"],
    };
  }

  // ── DELEGATED authority. FAILS CLOSED without live delegator and delegate evidence.
  if (!delegation.delegatorFor || delegation.delegateStatus === undefined) {
    return {
      allowed: false,
      via: null,
      refusalCode: "delegator_evidence_absent",
      reasons: [
        "a delegation was offered but the delegator's own authority and the delegate's membership " +
          "standing were not supplied; unknown authority is never permission (R2B-F-001)",
      ],
    };
  }

  const verdict = resolveDelegatedAuthority(
    {
      companyId: delegation.companyId,
      membershipId: delegation.membershipId,
      domain: delegation.domain,
      amount: delegation.amount,
      currency: delegation.currency,
      now: delegation.now ?? new Date(),
    },
    delegation.delegations,
    delegation.delegatorFor,
    delegation.delegateStatus,
    delegation.now ?? new Date(),
  );

  if (!verdict.ok) {
    return {
      allowed: false,
      via: null,
      refusalCode: verdict.code,
      reasons: ["approver lacks required role/permission and no valid delegation applies", ...verdict.reasons],
    };
  }

  return {
    allowed: true,
    via: "delegation",
    reasons: ["authorised by an active delegation within the EFFECTIVE ceiling", ...verdict.reasons],
    delegation: {
      delegationId: verdict.delegationId,
      effectiveCeiling: verdict.effectiveCeiling,
      boundBy: verdict.boundBy,
    },
  };
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
