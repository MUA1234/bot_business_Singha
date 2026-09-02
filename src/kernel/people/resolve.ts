/**
 * The ONE shared candidate-resolution service (R2B).
 *
 * The owner's requirement: *"Build one shared candidate-resolution service used by management
 * recommendations."* Everything that recommends a person, a team, an advisor, a delegate or an
 * external consultant enters here. `selectAssignee` in `recommend.ts` delegates to it; there is
 * no second path, because a second path is how two different definitions of "eligible" appear.
 *
 * The service is PURE. Loading evidence is the caller's job (`cycle-deps.ts` in production, a
 * fixture in tests), so every fairness and isolation property below is testable without a
 * database — and so no query in this file can accidentally read a protected attribute.
 *
 * Three outcomes, and never any other:
 *
 *   candidates      one or more people passed every hard gate, ordered for human consideration
 *   needs_routing   nobody is eligible — with a PRECISE reason, into the relevant department
 *                   queue, NEVER silently to an administrator or the owner (R1-D-3)
 *   (throw)         the request itself is unsafe — a cross-company candidate set, a protected
 *                   attribute. These are programming errors and must be loud.
 */
import type { Department } from "../types";
import {
  type CandidateEvidence, type CandidateRequest, type CandidateResolution, type CandidateRole,
  type EligibleCandidate, type Reason, type RejectedCandidate,
} from "./candidate";
import { evaluateDelegation, refuseRedelegation, type DelegatorAuthority } from "./delegation-scope";
import { evaluateEligibility } from "./eligibility";
import { assertRoleBoundaries } from "./roles";
import { orderCandidates, scoreSuitability, type SuitabilitySignal } from "./suitability";

/** How the caller supplies derived outcome signals. Keyed by membership AND task kind. */
export type SignalLookup = (membershipId: string, taskKind: string) => SuitabilitySignal | null;

/**
 * Everything the resolver needs from the outside. All optional and all defaulting to the SAFE
 * answer: no signal, and an unknown delegator (which refuses the delegation) rather than an
 * assumed one.
 */
export interface ResolveDeps {
  signalFor?: SignalLookup;
  /** The delegator's OWN authority, resolved from company rules — never from the delegation. */
  delegatorFor?: (fromMembershipId: string) => DelegatorAuthority | null;
  /**
   * Does the delegator hold this authority in their own right? False means it is borrowed, and
   * borrowed authority may not be delegated onward. Defaults to true so that callers with no
   * chain information are not silently refused — the ceiling check still applies.
   */
  delegatorHoldsOwnAuthority?: (fromMembershipId: string) => boolean;
}

/** The rule version reported when no learning is consulted at all. */
export const NO_LEARNING_RULE_VERSION = "none";

/**
 * Which candidate types may fill which role. A team is resolved to its members before it gets
 * here, so `team` appears only as the type of an already-resolved group proposal.
 */
const ROLE_TYPES: Record<CandidateRole, ReadonlySet<string>> = {
  assignee: new Set(["staff", "team"]),
  advisor: new Set(["staff", "advisor", "external_consultant"]),
  delegate: new Set(["delegate"]),
  external_consultant: new Set(["external_consultant"]),
};

export function resolveCandidates(
  req: CandidateRequest,
  evidence: readonly CandidateEvidence[],
  deps: ResolveDeps = {},
): CandidateResolution {
  if (req.roles.length === 0) {
    throw new Error("resolveCandidates: at least one role must be requested");
  }
  const signalFor = deps.signalFor ?? (() => null);

  const eligible: EligibleCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const aggregateMissing = new Map<string, Reason>();
  let ruleVersion = NO_LEARNING_RULE_VERSION;

  for (const c of evidence) {
    // Which of the requested roles could this candidate even fill?
    const roles = req.roles.filter((r) => ROLE_TYPES[r].has(c.candidateType));
    if (roles.length === 0) {
      rejected.push({
        membershipId: c.membershipId,
        candidateType: c.candidateType,
        reasons: [{
          code: "wrong_candidate_type",
          detail: `a ${c.candidateType} cannot fill ${req.roles.join(" or ")}`,
          evidence: null,
        }],
        // Not a fault of the person — the wrong list was supplied.
        neutral: true,
      });
      continue;
    }

    const outcome = evaluateEligibility(c, req);
    for (const m of outcome.missing) if (!aggregateMissing.has(m.code)) aggregateMissing.set(m.code, m);

    if (!outcome.eligible) {
      rejected.push({
        membershipId: c.membershipId,
        candidateType: c.candidateType,
        reasons: outcome.failed,
        neutral: outcome.neutral,
      });
      continue;
    }

    const signal = signalFor(c.membershipId, req.taskKind);
    if (signal) ruleVersion = signal.ruleVersion;
    const s = scoreSuitability(c, req, signal);

    // One entry per role the candidate can fill: an advisor recommendation and an assignee
    // recommendation are different proposals even when they name the same person.
    for (const role of roles) {
      // A delegate is only a candidate if the delegation itself survives scrutiny — scope,
      // window, and (R2B-F-001) the delegator's own authority.
      if (role === "delegate") {
        const verdict = checkDelegation(c, req, deps);
        if (!verdict.ok) {
          rejected.push({
            membershipId: c.membershipId,
            candidateType: c.candidateType,
            reasons: verdict.reasons,
            // A delegation that does not apply is a fact about the DELEGATION, not the person.
            neutral: true,
          });
          continue;
        }
      }

      const candidate: EligibleCandidate = {
        membershipId: c.membershipId,
        candidateType: c.candidateType,
        role,
        // Being recommended is never authorisation: a consultant carries no internal capability.
        relevantCapabilities: c.candidateType === "external_consultant" ? [] : relevantCapabilities(c, req),
        relevantSkills: s.matchedSkills,
        availability: c.available.value,
        confidence: s.confidence,
        suitability: s.suitability,
        evidenceRefs: outcome.evidenceRefs,
        reasons: [...outcome.passed, ...s.reasons],
        missingInformation: [...outcome.missing, ...s.missingInformation],
        requiresHumanReview: s.requiresHumanReview,
        // An advisor owns nothing, so no delegation rides along with the recommendation.
        delegationScope: role === "advisor" ? null : c.delegationScope.value,
        engagementScope: c.engagementScope.value,
      };
      // Loud, not filtered: a boundary violation here is a loader or resolver bug.
      assertRoleBoundaries(candidate);
      eligible.push(candidate);
    }
  }

  if (eligible.length === 0) {
    return {
      companyId: req.companyId,
      taskKind: req.taskKind,
      outcome: "needs_routing",
      candidates: [],
      rejected,
      routing: buildRouting(req, rejected),
      missingInformation: [...aggregateMissing.values()],
      humanDecisionRequired: true,
      signalRuleVersion: ruleVersion,
    };
  }

  return {
    companyId: req.companyId,
    taskKind: req.taskKind,
    outcome: "candidates",
    candidates: orderCandidates(eligible),
    rejected,
    routing: null,
    missingInformation: [...aggregateMissing.values()],
    humanDecisionRequired: true,
    signalRuleVersion: ruleVersion,
  };
}

/**
 * Validate a delegate candidate's delegation.
 *
 * Fails closed at every step: no delegation record, an unknown delegator, or a delegator whose
 * authority is itself borrowed all refuse. The delegation is NEVER taken as evidence of the
 * delegator's authority — that is the whole point of R2B-F-001.
 */
function checkDelegation(
  c: CandidateEvidence,
  req: CandidateRequest,
  deps: ResolveDeps,
): { ok: true } | { ok: false; reasons: Reason[] } {
  const scope = c.delegationScope.value;
  if (!scope) {
    return {
      ok: false,
      reasons: [{ code: "no_delegation_record", detail: "no delegation exists for this person", evidence: null }],
    };
  }

  const holdsOwn = deps.delegatorHoldsOwnAuthority?.(scope.fromMembership) ?? true;
  const chain = refuseRedelegation(holdsOwn);
  if (chain && !chain.valid) return { ok: false, reasons: chain.reasons };

  const delegator = deps.delegatorFor?.(scope.fromMembership) ?? null;
  const verdict = evaluateDelegation(
    scope,
    delegator,
    {
      companyId: req.companyId,
      authorityDomain: req.authorityDomain,
      authorityAmount: req.authorityAmount,
      requiredAuthority: req.requiredAuthority,
      now: req.now,
    },
    c.companyId,
  );
  return verdict.valid ? { ok: true } : { ok: false, reasons: verdict.reasons };
}

/** The capabilities this candidate holds that the request actually cares about. */
function relevantCapabilities(c: CandidateEvidence, req: CandidateRequest): string[] {
  if (!c.capabilities.value) return [];
  if (!req.requiredCapability) return [];
  return c.capabilities.value.filter((cap) => cap === req.requiredCapability);
}

/**
 * Build the no-candidate answer.
 *
 * Owner rules, both enforced here: the reason must be PRECISE, and the item must go to the
 * relevant authorised department queue — **never silently to an administrator or the owner**.
 * The department is the request's own department, which is always known, so there is no code
 * path in which this falls back to a person.
 *
 * The reason code is chosen from what actually happened, in order of how much it tells a human:
 * "nobody holds this capability" is a different management problem from "everyone who holds it
 * is on leave", and collapsing them into "no candidates" destroys exactly the information a
 * manager needs.
 */
function buildRouting(
  req: CandidateRequest,
  rejected: readonly RejectedCandidate[],
): { department: Department; reasonCode: string; detail: string } {
  const codes = new Set<string>();
  for (const r of rejected) for (const reason of r.reasons) codes.add(reason.code);

  const considered = rejected.length;
  if (considered === 0) {
    return {
      department: req.department,
      reasonCode: "no_candidates_supplied",
      detail: "no candidate was available to evaluate for this work",
    };
  }

  // Everyone excluded, and every exclusion was neutral — the team exists but cannot take it now.
  const allNeutral = rejected.every((r) => r.neutral);

  const ordered: Array<[string, string]> = [
    ["verified_skills_absent", "this work mandates a verified skill and no verified skill record exists for anyone considered"],
    ["capability_missing", `nobody considered holds ${req.requiredCapability ?? "the required capability"}`],
    ["authority_below_required", `nobody considered holds ${req.requiredAuthority}`],
    ["authority_ceiling_exceeded", "the amount exceeds every candidate's authority ceiling"],
    ["on_approved_leave", "everyone who qualifies is on approved leave on the requested date"],
    ["overloaded", "everyone who qualifies is already overloaded"],
    ["insufficient_capacity", "nobody who qualifies has enough free capacity for the estimate"],
    ["language_missing", `nobody considered has ${req.requiredLanguage} recorded, which this work requires`],
    ["provider_not_verified", "no external consultant considered has active approval and valid compliance"],
    ["inactive", "every candidate considered has an inactive or revoked membership"],
    ["company_mismatch", "every candidate considered belongs to a different company"],
  ];
  for (const [code, detail] of ordered) {
    if (codes.has(code)) {
      return {
        department: req.department,
        reasonCode: allNeutral ? `temporarily_unavailable:${code}` : code,
        detail: `${detail} (${considered} considered)`,
      };
    }
  }

  return {
    department: req.department,
    reasonCode: "no_eligible_assignee",
    detail: `no candidate met every requirement (${considered} considered)`,
  };
}

/**
 * Guard for the caller that assembles evidence: refuse a candidate set that mixes companies.
 *
 * Company isolation is already enforced per candidate by `gateCompany`, so this cannot change a
 * result. It exists to make a leak LOUD at its source rather than quietly correct: a loader that
 * returned another company's people has a bug that must be fixed, not filtered.
 */
export function assertSingleCompany(companyId: string, evidence: readonly CandidateEvidence[]): void {
  for (const c of evidence) {
    if (c.candidateType === "external_consultant") continue; // lawfully outside the company
    if (c.companyId !== companyId) {
      throw new Error(
        `candidate evidence leaked across companies: ${c.membershipId} belongs to ${c.companyId}, not ${companyId}`,
      );
    }
  }
}
