/**
 * R2B checkpoint 3 — advisors, delegates and external consultants.
 *
 * The four roles must stay distinct, and the delegation rules must hold. R2B-F-001 (a delegation
 * exceeding the delegator's own authority) has its own block, because it is a real defect this
 * phase found in existing code and the regression must be unmissable.
 */
import { describe, expect, it } from "vitest";
import {
  candidateEvidence, type AvailabilitySignal, type CandidateEvidence, type CandidateRequest,
  type DelegationScope, type EngagementScope,
} from "@/kernel/people/candidate";
import { evaluateDelegation, refuseRedelegation, type DelegatorAuthority } from "@/kernel/people/delegation-scope";
import { fact } from "@/kernel/people/evidence";
import { resolveCandidates } from "@/kernel/people/resolve";
import { assertRoleBoundaries, RoleBoundaryViolation } from "@/kernel/people/roles";

const CO_A = "11111111-1111-4111-8111-111111111111";
const CO_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-02T09:00:00.000Z");

const available: AvailabilitySignal = {
  available: true, onLeave: false, availableHours: 20, capacityStatus: "healthy",
};

const scope = (over: Partial<DelegationScope> = {}): DelegationScope => ({
  delegationId: "d1",
  fromMembership: "boss",
  domain: "expense",
  maxAmount: "50000.00",
  currency: "LKR",
  startsAt: "2026-09-01T00:00:00.000Z",
  endsAt: "2026-09-30T00:00:00.000Z",
  ...over,
});

const boss = (over: Partial<DelegatorAuthority> = {}): DelegatorAuthority => ({
  membershipId: "boss",
  companyId: CO_A,
  level: "manager_approval",
  ceiling: { amount: "100000.00", currency: "LKR" },
  ...over,
});

const delegationReq = (over: Partial<Parameters<typeof evaluateDelegation>[2]> = {}) => ({
  companyId: CO_A,
  authorityDomain: "expense" as string | null,
  authorityAmount: { amount: "10000.00", currency: "LKR" } as { amount: string; currency: string } | null,
  requiredAuthority: "manager_approval" as const,
  now: NOW,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("R2B-F-001 — a delegation may never exceed the delegator's own authority", () => {
  it("REFUSES a delegation that grants more than the delegator holds", () => {
    // The exact defect: a manager with a 50,000 ceiling writes a 5,000,000 delegation.
    const overGranted = scope({ maxAmount: "5000000.00" });
    const limitedBoss = boss({ ceiling: { amount: "50000.00", currency: "LKR" } });
    const v = evaluateDelegation(overGranted, limitedBoss, delegationReq({
      authorityAmount: { amount: "200000.00", currency: "LKR" },
    }), CO_A);

    expect(v.valid).toBe(false);
    if (!v.valid) {
      expect(v.reasons[0]!.code).toBe("delegation_exceeds_delegator");
      expect(v.reasons[0]!.detail).toMatch(/never exceed the delegator/);
    }
  });

  it("caps the effective ceiling at the LOWER of the delegation and the delegator", () => {
    const v = evaluateDelegation(
      scope({ maxAmount: "50000.00" }),
      boss({ ceiling: { amount: "100000.00", currency: "LKR" } }),
      delegationReq({ authorityAmount: { amount: "40000.00", currency: "LKR" } }),
      CO_A,
    );
    expect(v.valid).toBe(true);
    if (v.valid) expect(v.effectiveCeiling).toEqual({ amount: "50000", currency: "LKR" });
  });

  it("refuses an UNCAPPED delegation when the delegator is not themselves uncapped", () => {
    const v = evaluateDelegation(scope({ maxAmount: null }), boss(), delegationReq(), CO_A);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reasons[0]!.code).toBe("delegation_uncapped_but_delegator_is_not");
  });

  it("allows an uncapped delegation ONLY from a genuinely uncapped delegator", () => {
    const v = evaluateDelegation(
      scope({ maxAmount: null }),
      boss({ unlimited: true, ceiling: null }),
      delegationReq({ authorityAmount: { amount: "99999999.00", currency: "LKR" } }),
      CO_A,
    );
    expect(v.valid).toBe(true);
  });

  it("refuses when the delegator's authority is UNKNOWN — absence is never permission", () => {
    const v = evaluateDelegation(scope(), null, delegationReq(), CO_A);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reasons[0]!.code).toBe("delegator_authority_unknown");
  });

  it("refuses a delegator who holds no money authority to lend", () => {
    const v = evaluateDelegation(scope(), boss({ ceiling: null }), delegationReq(), CO_A);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reasons[0]!.code).toBe("delegator_has_no_money_authority");
  });

  it("refuses a delegator delegating a LEVEL above their own", () => {
    const v = evaluateDelegation(
      scope(),
      boss({ level: "policy_controlled" }),
      delegationReq({ requiredAuthority: "owner_approval" }),
      CO_A,
    );
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reasons[0]!.code).toBe("delegation_exceeds_delegator_level");
  });

  it("refuses a delegation attributed to a different delegator than the one supplied", () => {
    const v = evaluateDelegation(scope({ fromMembership: "someone_else" }), boss(), delegationReq(), CO_A);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reasons[0]!.code).toBe("delegator_mismatch");
  });

  it("refuses onward re-delegation of borrowed authority", () => {
    expect(refuseRedelegation(true)).toBeNull();
    const chain = refuseRedelegation(false);
    expect(chain!.valid).toBe(false);
    if (!chain!.valid) expect(chain!.reasons[0]!.code).toBe("redelegation_refused");
  });
});

describe("delegation scope, start and expiry", () => {
  it("refuses an expired delegation", () => {
    const v = evaluateDelegation(scope(), boss(), delegationReq({ now: new Date("2026-10-05T00:00:00.000Z") }), CO_A);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reasons[0]!.code).toBe("delegation_expired");
  });

  it("refuses a delegation that has not started", () => {
    const v = evaluateDelegation(scope(), boss(), delegationReq({ now: new Date("2026-08-01T00:00:00.000Z") }), CO_A);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reasons[0]!.code).toBe("delegation_not_started");
  });

  it("treats expiry as EXCLUSIVE — a delegation is dead at the instant it ends", () => {
    const atEnd = evaluateDelegation(scope(), boss(), delegationReq({ now: new Date("2026-09-30T00:00:00.000Z") }), CO_A);
    expect(atEnd.valid).toBe(false);
    const justBefore = evaluateDelegation(scope(), boss(), delegationReq({ now: new Date("2026-09-29T23:59:59.999Z") }), CO_A);
    expect(justBefore.valid).toBe(true);
  });

  it("refuses an UNSCOPED delegation outright", () => {
    const v = evaluateDelegation(scope({ domain: null }), boss(), delegationReq(), CO_A);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reasons[0]!.code).toBe("delegation_scope_undefined");
  });

  it("refuses a delegation whose scope excludes the work's domain", () => {
    const v = evaluateDelegation(scope({ domain: "hr" }), boss(), delegationReq({ authorityDomain: "payment" }), CO_A);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reasons[0]!.code).toBe("delegation_domain_excluded");
  });

  it("never crosses a company boundary", () => {
    const v = evaluateDelegation(scope(), boss(), delegationReq(), CO_B);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reasons[0]!.code).toBe("delegation_cross_company");
  });

  it("never converts currency", () => {
    const v = evaluateDelegation(
      scope({ currency: "LKR" }), boss(),
      delegationReq({ authorityAmount: { amount: "10.00", currency: "USD" } }), CO_A,
    );
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reasons[0]!.code).toBe("delegation_currency_mismatch");
  });

  it("refuses an unreadable amount rather than treating it as zero", () => {
    const v = evaluateDelegation(scope(), boss(), delegationReq({ authorityAmount: { amount: "not a number", currency: "LKR" } }), CO_A);
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reasons[0]!.code).toBe("delegation_amount_unreadable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
function person(id: string, over: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    ...candidateEvidence(
      { membershipId: id, companyId: CO_A, candidateType: "staff" },
      {
        active: fact(true, "verified"),
        capabilities: fact(["finance.collect"], "verified"),
        authorityLevel: fact("manager_approval", "verified"),
        authorityCeiling: fact({ amount: "100000.00", currency: "LKR" }, "verified"),
        available: fact(available, "inferred", { asOf: "2026-09-01T00:00:00.000Z" }),
      },
    ),
    ...over,
  };
}

const engagement = (over: Partial<EngagementScope> = {}): EngagementScope => ({
  domains: ["legal"], internalAccess: false, endsAt: "2026-12-31T00:00:00.000Z", ...over,
});

function consultant(id: string, over: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    ...candidateEvidence(
      { membershipId: id, companyId: CO_B, candidateType: "external_consultant" },
      {
        active: fact(true, "verified"),
        providerId: fact("p1", "verified", { sourceRef: { table: "service_providers", id: "p1" } }),
        providerStatus: fact("verified" as const, "verified"),
        engagementScope: fact(engagement(), "verified"),
        authorityLevel: fact("manager_approval", "verified"),
        available: fact(available, "inferred", { asOf: "2026-09-01T00:00:00.000Z" }),
      },
    ),
    ...over,
  };
}

const req = (over: Partial<CandidateRequest> = {}): CandidateRequest => ({
  companyId: CO_A, department: "legal", taskKind: "legal.obligation_review",
  roles: ["assignee"], requiredCapability: null, requiredAuthority: "manager_approval",
  authorityAmount: null, authorityDomain: "legal",
  requiredVerifiedSkills: [], preferredSkills: [], requiredLanguage: null,
  onDateIso: "2026-09-02", estimateHours: 4, now: NOW, ...over,
});

describe("the four roles stay distinct", () => {
  it("an ADVISOR never carries delegated authority, even when the person holds a delegation", () => {
    const withDelegation = person("m1", { delegationScope: fact(scope(), "verified") });
    const r = resolveCandidates(req({ roles: ["advisor"] }), [withDelegation]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.role).toBe("advisor");
    // An advisor supplies guidance and owns nothing — the delegation does not ride along.
    expect(r.candidates[0]!.delegationScope).toBeNull();
  });

  it("an EXTERNAL CONSULTANT can never be the accountable assignee", () => {
    const r = resolveCandidates(
      req({ roles: ["assignee"], allowExternalConsultants: true }),
      [consultant("c1")],
    );
    // The consultant is not even a candidate TYPE for the assignee role.
    expect(r.outcome).toBe("needs_routing");
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("wrong_candidate_type");
  });

  it("a recommended consultant receives NO internal capability — recommendation is not authorisation", () => {
    const withCaps = consultant("c1", { capabilities: fact(["finance.collect"], "verified") });
    const r = resolveCandidates(
      req({ roles: ["external_consultant"], requiredCapability: "finance.collect", allowExternalConsultants: true }),
      [withCaps],
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.relevantCapabilities).toEqual([]);
    expect(r.candidates[0]!.engagementScope!.internalAccess).toBe(false);
    expect(r.candidates[0]!.delegationScope).toBeNull();
  });

  it("a DELEGATE without a delegation is not a delegate", () => {
    const r = resolveCandidates(req({ roles: ["delegate"] }), [
      { ...person("m1"), candidateType: "delegate" },
    ]);
    expect(r.outcome).toBe("needs_routing");
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("no_delegation_record");
  });

  it("boundary violations are LOUD, not quietly corrected", () => {
    expect(() =>
      assertRoleBoundaries({
        membershipId: "c1", candidateType: "external_consultant", role: "external_consultant",
        relevantCapabilities: [], relevantSkills: [], availability: null, confidence: 1, suitability: 1,
        evidenceRefs: [], reasons: [], missingInformation: [], requiresHumanReview: [],
        delegationScope: null,
        engagementScope: { domains: ["legal"], internalAccess: true as unknown as false, endsAt: null },
      }),
    ).toThrow(RoleBoundaryViolation);
  });
});

describe("external consultants must be approved, compliant and in scope", () => {
  it("is not considered at all unless the work was explicitly opened to consultants", () => {
    const r = resolveCandidates(req({ roles: ["external_consultant"] }), [consultant("c1")]);
    expect(r.outcome).toBe("needs_routing");
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("external_not_permitted");
  });

  it("refuses a consultant whose compliance or insurance is not valid", () => {
    const blocked = consultant("c1", { providerStatus: fact("blocked" as const, "verified") });
    const warn = consultant("c2", { providerStatus: fact("warning" as const, "verified") });
    const r = resolveCandidates(
      req({ roles: ["external_consultant"], allowExternalConsultants: true }),
      [blocked, warn],
    );
    expect(r.outcome).toBe("needs_routing");
    expect(r.rejected.map((x) => x.reasons[0]!.code)).toEqual(["provider_not_verified", "provider_not_verified"]);
  });

  it("refuses a consultant whose engagement does not cover the domain, or has expired", () => {
    const wrongDomain = consultant("c1", { engagementScope: fact(engagement({ domains: ["fleet"] }), "verified") });
    const expired = consultant("c2", { engagementScope: fact(engagement({ endsAt: "2026-01-01T00:00:00.000Z" }), "verified") });
    const empty = consultant("c3", { engagementScope: fact(engagement({ domains: [] }), "verified") });
    const r = resolveCandidates(
      req({ roles: ["external_consultant"], allowExternalConsultants: true }),
      [wrongDomain, expired, empty],
    );
    expect(r.rejected.map((x) => x.reasons[0]!.code)).toEqual([
      "engagement_scope_excludes_domain", "engagement_expired", "engagement_scope_empty",
    ]);
  });

  it("accepts an approved, compliant, in-scope consultant and states the boundary", () => {
    const r = resolveCandidates(
      req({ roles: ["external_consultant"], allowExternalConsultants: true }),
      [consultant("c1")],
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.reasons.map((x) => x.code)).toContain("external_ok");
    expect(r.candidates[0]!.engagementScope!.domains).toEqual(["legal"]);
  });
});

describe("delegate routing through the resolver", () => {
  const delegate = (over: Partial<CandidateEvidence> = {}): CandidateEvidence => ({
    ...person("dep"), candidateType: "delegate",
    delegationScope: fact(scope(), "verified"), ...over,
  });

  const deps = (over: Partial<Parameters<typeof resolveCandidates>[2]> = {}) => ({
    delegatorFor: () => boss(),
    ...over,
  });

  it("accepts a delegate inside scope, window and the delegator's ceiling", () => {
    const r = resolveCandidates(
      req({ roles: ["delegate"], authorityDomain: "expense", authorityAmount: { amount: "10000.00", currency: "LKR" } }),
      [delegate()], deps(),
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.role).toBe("delegate");
    expect(r.candidates[0]!.delegationScope!.endsAt).toBe("2026-09-30T00:00:00.000Z");
  });

  it("refuses a delegate whose delegation exceeds the delegator, and calls that NEUTRAL", () => {
    const r = resolveCandidates(
      req({ roles: ["delegate"], authorityDomain: "expense", authorityAmount: { amount: "200000.00", currency: "LKR" } }),
      [delegate({ delegationScope: fact(scope({ maxAmount: "5000000.00" }), "verified") })],
      deps({ delegatorFor: () => boss({ ceiling: { amount: "50000.00", currency: "LKR" } }) }),
    );
    expect(r.outcome).toBe("needs_routing");
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("delegation_exceeds_delegator");
    // A bad delegation is a fact about the DELEGATION, not about the delegate.
    expect(r.rejected[0]!.neutral).toBe(true);
  });

  it("refuses a delegate when the delegator's authority cannot be resolved", () => {
    const r = resolveCandidates(
      req({ roles: ["delegate"], authorityDomain: "expense" }),
      [delegate()],
      { delegatorFor: () => null },
    );
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("delegator_authority_unknown");
  });

  it("refuses a delegate when the delegator's own authority is itself borrowed", () => {
    const r = resolveCandidates(
      req({ roles: ["delegate"], authorityDomain: "expense" }),
      [delegate()],
      deps({ delegatorHoldsOwnAuthority: () => false }),
    );
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("redelegation_refused");
  });

  it("refuses an expired delegation at the resolver level too", () => {
    // The capacity snapshot is moved forward with `now`, so the ONLY thing wrong here is the
    // delegation. Leaving it behind would fail the candidate on staleness and prove nothing.
    const later = new Date("2026-11-01T00:00:00.000Z");
    const r = resolveCandidates(
      req({ roles: ["delegate"], authorityDomain: "expense", now: later }),
      [delegate({ available: fact(available, "inferred", { asOf: "2026-10-30T00:00:00.000Z" }) })],
      deps(),
    );
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("delegation_expired");
  });
});

describe("one request, several roles", () => {
  it("returns an assignee and an advisor as SEPARATE proposals for the same person", () => {
    const r = resolveCandidates(req({ roles: ["assignee", "advisor"] }), [person("m1")]);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.map((c) => c.role).sort()).toEqual(["advisor", "assignee"]);
    // Same person, two proposals — and the advisor one confers nothing.
    expect(new Set(r.candidates.map((c) => c.membershipId))).toEqual(new Set(["m1"]));
  });

  it("still requires a human decision no matter how many roles were filled", () => {
    const r = resolveCandidates(req({ roles: ["assignee", "advisor"] }), [person("m1")]);
    expect(r.humanDecisionRequired).toBe(true);
  });
});
