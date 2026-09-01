/**
 * Recommendation and reviewer decisions (R1 checkpoint 4).
 *
 * A recommendation is a PROPOSAL: which registered action, on what evidence, needing whose
 * authority. It never performs anything. Everything financial, customer-facing, external or
 * irreversible stays in the existing human-operated workflows.
 *
 * Pure and transport-free, so every rule below is directly testable. The caller applies the
 * returned decision inside a transaction.
 */
import { resolveRequiredAuthority, type AuthorityContext } from "@/policy/authority-engine";
import type { AuthorityLevel } from "@/schemas/management";
import { ACTION_CATALOGUE, actionFor, actionById } from "./catalogue";
import { assertActionRegistered, assertInternalOnly, InvariantViolation } from "./invariants";
import { mayInfluenceRecommendation } from "./interpretation";
import type { Observation } from "./observation";
import type { DomainAction, Interpretation } from "./types";

/** What a reviewer may do with a management item. */
export type ReviewAction =
  | "approve"
  | "reject"
  | "dismiss"
  | "edit"
  | "delegate"
  | "postpone"
  | "request_evidence"
  | "route";

/** Reasons are mandatory for the actions whose reason IS the learning signal (IMP-001). */
export const REASON_REQUIRED_ACTIONS: readonly ReviewAction[] = [
  "reject", "dismiss", "edit", "delegate", "postpone", "request_evidence", "route",
];

export interface Recommendation {
  action: DomainAction;
  /** Why, in terms of the recorded evidence — never free prose from a model. */
  rationale: string[];
  requiredAuthority: AuthorityLevel;
  authorityReasons: string[];
  authorityFailedClosed: boolean;
  /** True when the item may proceed unattended (D-9): automatic AND catalogue-safe. */
  mayRunUnattended: boolean;
  confidence: number;
  /** Displayed truthfully rather than hidden. */
  evidenceQuality: "sufficient" | "low_confidence" | "contradictory" | "insufficient";
}

export interface BuildInput {
  observation: Observation;
  interpretation: Interpretation;
  authority: AuthorityContext;
  /** A second interpretation that disagrees, when one exists. */
  contradiction?: boolean;
}

/**
 * Build a recommendation, or explain why none can be made.
 *
 * Returns `null` when the catalogue cannot express a response — a legitimate outcome that
 * becomes a clarification for a human, never an improvised action.
 */
export function buildRecommendation(input: BuildInput): Recommendation | null {
  const { observation: o, interpretation, authority } = input;

  // A recommendation must cite evidence. Enforced here, in the lifecycle, and in the
  // database — three independent layers, because this is the rule that keeps the system
  // honest.
  if (!o.evidence || o.evidence.length === 0) {
    throw new InvariantViolation("zero_evidence", "a recommendation requires at least one evidence reference");
  }

  const action = actionFor(o.department, o.suggestedActionCategory);
  if (!action) return null;

  // Belt and braces: the action came from the catalogue, and is re-checked as registered
  // and internal-only before it can be proposed.
  assertActionRegistered(action.id, [...ACTION_CATALOGUE]);
  assertInternalOnly(action);

  // AUTHORITY comes from the existing engine, never from a model and never from a table in
  // this module. `impact` is structured — booleans the detector derived — not model prose.
  const resolution = resolveRequiredAuthority(
    {
      domain: o.department === "operations" ? "ops" : o.department,
      action: action.id,
      impact: {
        financial: o.department === "finance",
        customer: o.department === "crm",
        operational: o.department === "operations" || o.department === "system",
      },
      confidence: o.confidence,
    },
    authority,
  );

  // The action's own registered floor can only RAISE the requirement, never lower it.
  const required = higherOf(resolution.level, action.authorityFloor);

  const evidenceQuality: Recommendation["evidenceQuality"] = input.contradiction
    ? "contradictory"
    : interpretation.status === "low_confidence"
      ? "low_confidence"
      : o.evidence.length === 0
        ? "insufficient"
        : "sufficient";

  const rationale: string[] = [
    `${o.summary} (${o.severity})`,
    ...o.evidence.map((e) => `evidence: ${e.sourceTable}:${e.sourceId}`),
  ];
  // A model may only contribute statements it grounded in recorded evidence, and only when
  // the interpretation is trustworthy at all.
  if (mayInfluenceRecommendation(interpretation)) {
    rationale.push(...interpretation.statements.map((s) => `interpretation: ${s.claim}`));
  }

  return {
    action,
    rationale,
    requiredAuthority: required,
    authorityReasons: resolution.reasons,
    authorityFailedClosed: resolution.failedClosed,
    // D-9: unattended ONLY at automatic authority, for a catalogue-safe reversible action,
    // and never when the authority engine had to fail closed or the evidence is doubtful.
    mayRunUnattended:
      required === "automatic" &&
      action.automaticSafe === true &&
      action.reversible === true &&
      !resolution.failedClosed &&
      evidenceQuality === "sufficient",
    confidence: o.confidence,
    evidenceQuality,
  };
}

const LADDER: AuthorityLevel[] = [
  "automatic", "policy_controlled", "manager_approval", "specialist_approval", "owner_approval",
];
const higherOf = (a: AuthorityLevel, b: AuthorityLevel): AuthorityLevel =>
  LADDER.indexOf(a) >= LADDER.indexOf(b) ? a : b;

// ─────────────────────────────────────────────────────────────────────────────────────────
// Reviewer decisions
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface ReviewerContext {
  /** The reviewer's membership in the item's company. Absent ⇒ not authorised here. */
  membershipId: string | null;
  companyId: string;
  /** Capabilities the reviewer actually holds, from the existing capability matrix. */
  capabilities: readonly string[];
  /** The authority level this reviewer may exercise. */
  authorityLevel: AuthorityLevel;
  /** Memberships this reviewer has already acted on THIS item, for separation of duties. */
  priorDecisions: readonly ReviewAction[];
}

export interface ReviewRequest {
  action: ReviewAction;
  reason?: string | null;
  /** `edit` only. */
  editedActionId?: string | null;
  /** `delegate` only — the membership receiving it. */
  delegateToMembershipId?: string | null;
  /** `delegate` only — the delegate's own authority ceiling. */
  delegateAuthorityLevel?: AuthorityLevel | null;
  /** `postpone` only. */
  snoozeUntil?: string | null;
}

export type ReviewOutcome =
  | { ok: true; action: ReviewAction; nextState: string | null; effects: string[] }
  | { ok: false; code: string; message: string };

const TERMINAL = new Set(["verified", "rejected", "dismissed", "expired"]);

/**
 * Decide whether a reviewer may take this action on this item, and what it implies.
 *
 * FAILS CLOSED on every branch. It performs nothing: the caller applies the outcome.
 */
export function reviewItem(
  item: { id: string; companyId: string; state: string; requiredAuthority: AuthorityLevel; proposedActionId: string | null },
  ctx: ReviewerContext,
  req: ReviewRequest,
): ReviewOutcome {
  // COMPANY: a reviewer from another company is not a reviewer here.
  if (ctx.companyId !== item.companyId || !ctx.membershipId) {
    return { ok: false, code: "not_a_member", message: "reviewer is not an active member of this item's company" };
  }

  if (TERMINAL.has(item.state)) {
    return { ok: false, code: "already_terminal", message: `item is ${item.state} and accepts no further decision` };
  }

  // REASON: mandatory where the reason is the learning signal.
  if (REASON_REQUIRED_ACTIONS.includes(req.action) && !(req.reason ?? "").trim()) {
    return { ok: false, code: "reason_required", message: `"${req.action}" requires a reason` };
  }

  switch (req.action) {
    case "approve": {
      // AUTHORITY: the reviewer must hold at least the required level.
      if (rank(ctx.authorityLevel) < rank(item.requiredAuthority)) {
        return {
          ok: false,
          code: "insufficient_authority",
          message: `approval requires ${item.requiredAuthority}; reviewer holds ${ctx.authorityLevel}`,
        };
      }
      // SEPARATION OF DUTIES: whoever edited the recommendation may not also approve it.
      // Maker and checker must differ, exactly as the finance controls already require.
      if (ctx.priorDecisions.includes("edit")) {
        return {
          ok: false,
          code: "self_approval_blocked",
          message: "a reviewer who edited this recommendation may not also approve it",
        };
      }
      if (ctx.priorDecisions.includes("approve")) {
        return { ok: false, code: "duplicate_decision", message: "this reviewer has already approved this item" };
      }
      return { ok: true, action: "approve", nextState: "approved", effects: ["decision_recorded"] };
    }

    case "reject":
      return { ok: true, action: "reject", nextState: "rejected", effects: ["decision_recorded", "feedback_recorded"] };

    case "dismiss":
      return { ok: true, action: "dismiss", nextState: "dismissed", effects: ["decision_recorded", "feedback_recorded"] };

    case "edit": {
      const edited = req.editedActionId ? actionById(req.editedActionId) : null;
      if (!edited) {
        return { ok: false, code: "unsupported_action", message: `"${req.editedActionId}" is not a registered action` };
      }
      if (!edited.internalOnly) {
        return { ok: false, code: "external_action_refused", message: `"${edited.id}" is not internal-only` };
      }
      // An edit may RAISE the authority requirement; it may never lower it.
      return {
        ok: true,
        action: "edit",
        nextState: null,
        effects: ["decision_recorded", "feedback_recorded", `authority_recheck:${edited.authorityFloor}`],
      };
    }

    case "delegate": {
      if (!req.delegateToMembershipId) {
        return { ok: false, code: "missing_delegate", message: "delegation requires a delegate" };
      }
      if (req.delegateToMembershipId === ctx.membershipId) {
        return { ok: false, code: "self_delegation", message: "a reviewer cannot delegate to themselves" };
      }
      // A delegation is a SUBSET of the delegator's authority — never an expansion.
      const delegateLevel = req.delegateAuthorityLevel ?? "automatic";
      if (rank(delegateLevel) > rank(ctx.authorityLevel)) {
        return {
          ok: false,
          code: "delegation_exceeds_delegator",
          message: "a delegate may not exceed the delegator's own authority",
        };
      }
      return { ok: true, action: "delegate", nextState: null, effects: ["decision_recorded"] };
    }

    case "postpone": {
      if (!req.snoozeUntil) {
        return { ok: false, code: "missing_snooze_until", message: "postponing requires a time to return to it" };
      }
      if (Number.isNaN(Date.parse(req.snoozeUntil))) {
        return { ok: false, code: "malformed_snooze_until", message: "snooze time is not a valid timestamp" };
      }
      return { ok: true, action: "postpone", nextState: null, effects: ["decision_recorded", "snoozed"] };
    }

    case "request_evidence":
      return { ok: true, action: "request_evidence", nextState: null, effects: ["decision_recorded", "evidence_requested"] };

    case "route":
      // Routing an unassigned item is how R1-D-3 is honoured: it goes to a department queue
      // with a reason, never silently to an administrator.
      return { ok: true, action: "route", nextState: "needs_routing", effects: ["decision_recorded", "routing_requested"] };

    default:
      return { ok: false, code: "unsupported_review_action", message: `unknown review action` };
  }
}

const rank = (l: AuthorityLevel) => LADDER.indexOf(l);

/**
 * Can this candidate hold the work?
 *
 * Same company, active, available (leave and capacity), and holding the action's capability.
 * If nobody qualifies the answer is NULL, and the caller must route the item — never fall
 * back to an owner or administrator (R1-D-3).
 */
export interface AssigneeCandidate {
  membershipId: string;
  companyId: string;
  active: boolean;
  available: boolean;
  availableHours: number;
  capabilities: readonly string[];
}

export function selectAssignee(
  candidates: readonly AssigneeCandidate[],
  action: DomainAction,
  companyId: string,
): { membershipId: string } | { membershipId: null; reason: string } {
  const eligible = candidates.filter(
    (c) =>
      c.companyId === companyId &&
      c.active &&
      c.available &&
      (action.capability === null || c.capabilities.includes(action.capability)),
  );
  if (eligible.length === 0) {
    return {
      membershipId: null,
      reason: `no active, available member of this company holds ${action.capability ?? "the required capability"}`,
    };
  }
  // Least-loaded first — the same ranking rule the follow-up loop uses.
  const best = [...eligible].sort((a, b) => b.availableHours - a.availableHours)[0]!;
  return { membershipId: best.membershipId };
}
