/**
 * Hard eligibility gates for capability routing (R2B).
 *
 * These are the owner's requirements, one function each, all deterministic and all FAIL-CLOSED:
 * a gate that cannot be evaluated refuses the candidate and says which evidence was missing. The
 * alternative — treating unknown as pass — is how a person without a required capability ends up
 * assigned to work that needs it.
 *
 * A gate returns one of three verdicts, and the distinction between the last two is the whole
 * fairness model:
 *
 *   pass                 the requirement is met, on stated evidence
 *   fail                 the requirement is NOT met (wrong company, no capability, expired
 *                        compliance) — an adverse finding about eligibility
 *   fail-NEUTRAL         the person is unavailable for a reason that must never count against
 *                        them: approved leave, authorised training, an accommodation, or simply
 *                        no data. Excluded from THIS request, and nothing more.
 *
 * Nothing in this file ranks anybody. Gates answer yes or no; ordering happens in suitability.ts.
 */
import Decimal from "decimal.js";
import { LADDER } from "@/policy/authority-engine";
import type { AuthorityLevel } from "@/schemas/management";
import type { CandidateEvidence, CandidateRequest, Reason } from "./candidate";
import { CAPACITY_MAX_AGE_MS, isPresent, isVerified, provenanceLabel, withFreshness } from "./evidence";

export interface GateVerdict {
  passed: boolean;
  /** True only on a failure that must never be held against the person. */
  neutral: boolean;
  reasons: Reason[];
  /** Evidence we needed and did not have. */
  missing: Reason[];
}

const ok = (code: string, detail: string, evidence?: { table: string; id: string } | null): GateVerdict => ({
  passed: true, neutral: false, reasons: [{ code, detail, evidence: evidence ?? null }], missing: [],
});
const no = (code: string, detail: string): GateVerdict => ({
  passed: false, neutral: false, reasons: [{ code, detail, evidence: null }], missing: [],
});
const neutralNo = (code: string, detail: string): GateVerdict => ({
  passed: false, neutral: true, reasons: [{ code, detail, evidence: null }], missing: [],
});
/** Missing evidence FAILS the gate (fail-closed) but is NEUTRAL — absence is not a fault. */
const unknown = (code: string, detail: string): GateVerdict => ({
  passed: false, neutral: true, reasons: [{ code, detail, evidence: null }],
  missing: [{ code, detail, evidence: null }],
});

const rank = (l: AuthorityLevel) => LADDER.indexOf(l);

/**
 * Company scope. Taken from the AUTHORISED REQUEST, never from the candidate record — a
 * candidate that claims to be in the right company is not evidence that it is.
 *
 * The one lawful exception is an approved external consultant, who is by definition outside the
 * company; their boundary is enforced by {@link gateExternalConsultant} instead.
 */
export function gateCompany(c: CandidateEvidence, req: CandidateRequest): GateVerdict {
  if (c.candidateType === "external_consultant") {
    return ok("company_external", "external consultant — company membership does not apply");
  }
  if (c.companyId !== req.companyId) {
    return no("company_mismatch", "candidate belongs to a different company");
  }
  return ok("company_ok", "same authorised company");
}

/** Active membership or active provider status. */
export function gateActive(c: CandidateEvidence): GateVerdict {
  if (!isPresent(c.active)) return unknown("active_unknown", "membership status is not recorded");
  if (c.active.evidenceClass === "stale") {
    return unknown("active_stale", "membership status is out of date and was not trusted");
  }
  return c.active.value === true
    ? ok("active_ok", "active membership", c.active.sourceRef)
    : no("inactive", "membership is inactive, suspended or revoked");
}

/** The capability the work requires, from `has_capability` — a verified system-of-record fact. */
export function gateCapability(c: CandidateEvidence, req: CandidateRequest): GateVerdict {
  if (req.requiredCapability === null) return ok("capability_not_required", "no capability is required");
  if (!isPresent(c.capabilities)) {
    return unknown("capabilities_unknown", `capabilities are not recorded, so "${req.requiredCapability}" cannot be confirmed`);
  }
  if (!isVerified(c.capabilities)) {
    return unknown(
      "capabilities_unverified",
      `capabilities are ${provenanceLabel(c.capabilities.evidenceClass)} and cannot satisfy a required capability`,
    );
  }
  return c.capabilities.value!.includes(req.requiredCapability)
    ? ok("capability_ok", `holds ${req.requiredCapability}`, c.capabilities.sourceRef)
    : no("capability_missing", `does not hold ${req.requiredCapability}`);
}

/**
 * Authority. The candidate must sit at or above the level the work requires, and — when the work
 * commits money — their ceiling must cover it.
 *
 * Money is compared with Decimal, never a JS float, because this decides authority.
 */
export function gateAuthority(c: CandidateEvidence, req: CandidateRequest): GateVerdict {
  // `automatic` is the FLOOR of the ladder: it is the ABSENCE of an authority requirement, not a
  // level someone must hold. Demanding a verified authority record in order to satisfy "no
  // requirement" would refuse every candidate on work that needs no approval at all.
  if (req.requiredAuthority === "automatic" && !req.authorityAmount) {
    return ok("authority_not_required", "this work requires no approval authority");
  }
  if (!isVerified(c.authorityLevel)) {
    return unknown("authority_unknown", "authority level is not established from company rules");
  }
  if (rank(c.authorityLevel.value!) < rank(req.requiredAuthority)) {
    return no("authority_below_required", `authority ${c.authorityLevel.value} is below the required ${req.requiredAuthority}`);
  }
  if (!req.authorityAmount) return ok("authority_ok", `authority ${c.authorityLevel.value} meets the requirement`);

  if (!isVerified(c.authorityCeiling)) {
    return unknown("authority_ceiling_unknown", "no verified authority ceiling, and this work commits money");
  }
  const ceiling = c.authorityCeiling.value!;
  if (ceiling.currency !== req.authorityAmount.currency) {
    // Never convert. A ceiling in another currency is not a ceiling for this amount.
    return unknown(
      "authority_currency_mismatch",
      `authority ceiling is in ${ceiling.currency} but the work is in ${req.authorityAmount.currency}; no conversion is applied`,
    );
  }
  let within: boolean;
  try {
    within = !new Decimal(req.authorityAmount.amount).greaterThan(new Decimal(ceiling.amount));
  } catch {
    return unknown("authority_amount_unreadable", "an authority amount could not be read as a decimal");
  }
  return within
    ? ok("authority_ok", `ceiling ${ceiling.amount} ${ceiling.currency} covers the amount`, c.authorityCeiling.sourceRef)
    : no("authority_ceiling_exceeded", `the amount exceeds the ceiling of ${ceiling.amount} ${ceiling.currency}`);
}

/**
 * Availability, approved leave and capacity.
 *
 * EVERY failure here is NEUTRAL. Approved leave is a right that was granted by a manager; being
 * fully loaded is a fact about the schedule, not the person. Neither may ever count against
 * someone, which is why they are excluded from this request and produce no learning signal.
 */
export function gateAvailability(c: CandidateEvidence, req: CandidateRequest): GateVerdict {
  const f = withFreshness(c.available, req.now, CAPACITY_MAX_AGE_MS);
  if (!isPresent(f)) return unknown("availability_unknown", "availability could not be computed");
  if (f.evidenceClass === "stale") {
    return unknown("availability_stale", "the capacity snapshot is out of date and was not trusted");
  }
  const a = f.value!;
  if (a.onLeave) {
    return neutralNo("on_approved_leave", "on approved leave on the requested date — excluded from this request only");
  }
  if (!a.available) {
    return neutralNo("not_available", "not available on the requested date — excluded from this request only");
  }
  if (a.capacityStatus === "overloaded") {
    return neutralNo("overloaded", "already overloaded — excluded from this request only");
  }
  if (req.estimateHours !== null && a.availableHours < req.estimateHours) {
    return neutralNo(
      "insufficient_capacity",
      `has ${a.availableHours}h free, which does not cover an estimate of ${req.estimateHours}h`,
    );
  }
  return ok("available_ok", `available with ${a.availableHours}h free`, f.sourceRef);
}

/**
 * Mandatory skills. **Only a VERIFIED skill can satisfy a mandatory requirement.**
 *
 * The dependency audit (F-R2B-2) found that no verified skill source exists: `employee_profiles
 * .skills` is a bare text array with no verifier, evidence or expiry. So today this gate refuses
 * EVERY candidate whenever the work mandates a skill — which is correct, and yields
 * `needs_routing` with a precise reason rather than picking somebody on an unchecked claim. When
 * a verification source is added, data changes and this logic does not.
 */
export function gateMandatorySkills(c: CandidateEvidence, req: CandidateRequest): GateVerdict {
  if (req.requiredVerifiedSkills.length === 0) return ok("skills_not_required", "no verified skill is mandatory");

  if (!isVerified(c.verifiedSkills)) {
    return unknown(
      "verified_skills_absent",
      `this work mandates verified skills (${req.requiredVerifiedSkills.join(", ")}) and no verified skill record exists ` +
        `for this person; a self-declared skill cannot satisfy a mandatory requirement`,
    );
  }
  const held = new Set(c.verifiedSkills.value!);
  const missing = req.requiredVerifiedSkills.filter((s) => !held.has(s));
  return missing.length === 0
    ? ok("skills_ok", `holds verified ${req.requiredVerifiedSkills.join(", ")}`, c.verifiedSkills.sourceRef)
    : no("verified_skill_missing", `lacks verified ${missing.join(", ")}`);
}

/**
 * Language. Applies ONLY when the task genuinely requires a language (owner rule) — otherwise
 * this gate passes unconditionally and language plays no part anywhere else, including ranking.
 */
export function gateLanguage(c: CandidateEvidence, req: CandidateRequest): GateVerdict {
  if (!req.requiredLanguage) return ok("language_not_required", "the task does not require a specific language");
  if (!isPresent(c.languages)) {
    return unknown("language_unknown", `the task requires ${req.requiredLanguage} and no language is recorded for this person`);
  }
  return c.languages.value!.includes(req.requiredLanguage)
    ? ok("language_ok", `speaks ${req.requiredLanguage}`, c.languages.sourceRef)
    : no("language_missing", `does not have ${req.requiredLanguage} recorded`);
}

/**
 * Separation of duties. The person who raised the work does not get recommended to approve or
 * verify their own. Mirrors `canActOnTask` rather than reimplementing it.
 */
export function gateSeparationOfDuties(c: CandidateEvidence, req: CandidateRequest): GateVerdict {
  if (!req.raisedByMembershipId) return ok("sod_not_applicable", "no raiser recorded");
  return c.membershipId === req.raisedByMembershipId
    ? no("self_review", "raised this work and may not also be recommended to decide it")
    : ok("sod_ok", "not the person who raised the work");
}

/**
 * External consultants. Approval, compliance and a defined scope are ALL required, and the
 * engagement can never carry internal access.
 */
export function gateExternalConsultant(c: CandidateEvidence, req: CandidateRequest): GateVerdict {
  if (c.candidateType !== "external_consultant") return ok("not_external", "not an external consultant");

  if (!req.allowExternalConsultants) {
    return no("external_not_permitted", "this work has not been opened to external consultants");
  }
  if (!isVerified(c.providerStatus)) {
    return unknown("provider_status_unknown", "no verified provider record");
  }
  if (c.providerStatus.value !== "verified") {
    return no("provider_not_verified", `provider health is "${c.providerStatus.value}" — active approval, valid compliance and valid insurance are all required`);
  }
  if (!isPresent(c.engagementScope)) {
    return unknown("engagement_scope_absent", "no approved engagement scope");
  }
  const scope = c.engagementScope.value!;
  if (scope.domains.length === 0) {
    return no("engagement_scope_empty", "the engagement defines no approved domain");
  }
  if (req.authorityDomain && !scope.domains.includes(req.authorityDomain)) {
    return no("engagement_scope_excludes_domain", `the engagement does not cover ${req.authorityDomain}`);
  }
  if (scope.endsAt && Date.parse(scope.endsAt) <= req.now.getTime()) {
    return no("engagement_expired", "the engagement has expired");
  }
  // Belt and braces: the type forbids it, but a loader could still have been wrong.
  if ((scope as { internalAccess: boolean }).internalAccess === true) {
    return no("engagement_grants_internal_access", "an external engagement may never carry internal company access");
  }
  return ok("external_ok", `approved consultant within scope: ${scope.domains.join(", ")}`, c.providerId.sourceRef);
}

/** Every gate, in order. Company first — nothing about a foreign candidate is worth evaluating. */
export const GATES: ReadonlyArray<{
  name: string;
  run: (c: CandidateEvidence, req: CandidateRequest) => GateVerdict;
}> = [
  { name: "company", run: gateCompany },
  { name: "active", run: gateActive },
  { name: "separation_of_duties", run: gateSeparationOfDuties },
  { name: "external_consultant", run: gateExternalConsultant },
  { name: "capability", run: gateCapability },
  { name: "authority", run: gateAuthority },
  { name: "mandatory_skills", run: gateMandatorySkills },
  { name: "language", run: gateLanguage },
  { name: "availability", run: gateAvailability },
];

export interface EligibilityOutcome {
  eligible: boolean;
  /** True when EVERY failure was neutral — nothing adverse was found about this person. */
  neutral: boolean;
  passed: Reason[];
  failed: Reason[];
  missing: Reason[];
  evidenceRefs: Array<{ table: string; id: string }>;
}

/**
 * Run every gate. All gates run even after the first failure, so the human sees the complete
 * picture — "no capability AND on leave" is a different conversation from either alone.
 */
export function evaluateEligibility(c: CandidateEvidence, req: CandidateRequest): EligibilityOutcome {
  const passed: Reason[] = [];
  const failed: Reason[] = [];
  const missing: Reason[] = [];
  const evidenceRefs: Array<{ table: string; id: string }> = [];
  let eligible = true;
  let allNeutral = true;

  for (const gate of GATES) {
    const v = gate.run(c, req);
    if (v.passed) {
      passed.push(...v.reasons);
      for (const r of v.reasons) if (r.evidence) evidenceRefs.push(r.evidence);
    } else {
      eligible = false;
      failed.push(...v.reasons);
      if (!v.neutral) allNeutral = false;
    }
    missing.push(...v.missing);
  }

  return { eligible, neutral: eligible ? true : allNeutral, passed, failed, missing, evidenceRefs };
}
