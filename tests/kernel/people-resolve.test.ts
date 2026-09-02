/**
 * R2B checkpoint 2 — the shared candidate-resolution service.
 *
 * These tests are the owner's acceptance list for capability routing. Each one states the rule
 * it protects, because a fairness rule that is only implied by a passing assertion is a rule
 * that will be removed by the next refactor.
 */
import { describe, expect, it } from "vitest";
import {
  candidateEvidence, type AvailabilitySignal, type CandidateEvidence, type CandidateRequest,
} from "@/kernel/people/candidate";
import { absent, fact } from "@/kernel/people/evidence";
import { ProtectedAttributeError } from "@/kernel/people/protected";
import { assertSingleCompany, resolveCandidates, type SignalLookup } from "@/kernel/people/resolve";
import type { SuitabilitySignal } from "@/kernel/people/suitability";

const CO_A = "11111111-1111-4111-8111-111111111111";
const CO_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-02T09:00:00.000Z");

const available: AvailabilitySignal = {
  available: true, onLeave: false, availableHours: 20, capacityStatus: "healthy",
};

/** A fully-evidenced, eligible member of company A. Tests subtract from this. */
function staff(id: string, over: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    ...candidateEvidence(
      { membershipId: id, companyId: CO_A, candidateType: "staff" },
      {
        active: fact(true, "verified", { sourceRef: { table: "memberships", id } }),
        roles: fact(["staff"], "verified"),
        capabilities: fact(["finance.collect"], "verified", { sourceRef: { table: "membership_roles", id } }),
        authorityLevel: fact("manager_approval", "verified"),
        authorityCeiling: fact({ amount: "100000.00", currency: "LKR" }, "verified"),
        departmentIds: fact(["finance"], "verified"),
        declaredSkills: fact(["collections"], "self_declared", { sourceRef: { table: "employee_profiles", id } }),
        available: fact(available, "inferred", {
          asOf: "2026-09-01T00:00:00.000Z",
          sourceRef: { table: "capacity_snapshots", id },
        }),
      },
    ),
    ...over,
  };
}

const request = (over: Partial<CandidateRequest> = {}): CandidateRequest => ({
  companyId: CO_A,
  department: "finance",
  taskKind: "finance.receivable_followup",
  roles: ["assignee"],
  requiredCapability: "finance.collect",
  requiredAuthority: "manager_approval",
  authorityAmount: null,
  authorityDomain: null,
  requiredVerifiedSkills: [],
  preferredSkills: [],
  requiredLanguage: null,
  onDateIso: "2026-09-02",
  estimateHours: 4,
  now: NOW,
  ...over,
});

describe("resolveCandidates — the happy path stays honest", () => {
  it("recommends an eligible candidate and ALWAYS requires a human decision", () => {
    const r = resolveCandidates(request(), [staff("m1")]);
    expect(r.outcome).toBe("candidates");
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.membershipId).toBe("m1");
    // The owner: "Human managers retain final assignment authority."
    expect(r.humanDecisionRequired).toBe(true);
    // Every recommendation carries its evidence and its reasons.
    expect(r.candidates[0]!.evidenceRefs.length).toBeGreaterThan(0);
    expect(r.candidates[0]!.reasons.map((x) => x.code)).toContain("capability_ok");
  });

  it("reports skill provenance rather than presenting a self-declared skill as fact", () => {
    const r = resolveCandidates(request({ preferredSkills: ["collections"] }), [staff("m1")]);
    const matched = r.candidates[0]!.relevantSkills;
    expect(matched).toEqual([{ skill: "collections", verified: false }]);
    expect(r.candidates[0]!.reasons.find((x) => x.code === "preferred_skills_matched")!.detail)
      .toContain("self-declared, unverified");
  });
});

describe("candidates who must be excluded", () => {
  it("excludes someone on approved leave — and records it as NEUTRAL, never a mark against them", () => {
    const onLeave = staff("m1", {
      available: fact({ ...available, available: false, onLeave: true }, "inferred", {
        asOf: "2026-09-01T00:00:00.000Z",
      }),
    });
    const r = resolveCandidates(request(), [onLeave]);
    expect(r.outcome).toBe("needs_routing");
    const rej = r.rejected[0]!;
    expect(rej.reasons.map((x) => x.code)).toContain("on_approved_leave");
    // THE fairness assertion: approved leave may never be an adverse finding.
    expect(rej.neutral).toBe(true);
    expect(r.routing!.reasonCode).toBe("temporarily_unavailable:on_approved_leave");
  });

  it("excludes an overloaded member as NEUTRAL, and says so precisely", () => {
    const loaded = staff("m1", {
      available: fact({ available: true, onLeave: false, availableHours: 0, capacityStatus: "overloaded" }, "inferred", {
        asOf: "2026-09-01T00:00:00.000Z",
      }),
    });
    const r = resolveCandidates(request(), [loaded]);
    expect(r.rejected[0]!.neutral).toBe(true);
    expect(r.routing!.detail).toContain("overloaded");
  });

  it("excludes an inactive or revoked membership — and this one is NOT neutral", () => {
    const revoked = staff("m1", { active: fact(false, "verified") });
    const r = resolveCandidates(request(), [revoked]);
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("inactive");
    expect(r.rejected[0]!.neutral).toBe(false);
  });

  it("excludes a candidate without the required capability", () => {
    const wrong = staff("m1", { capabilities: fact(["hr.review"], "verified") });
    const r = resolveCandidates(request(), [wrong]);
    expect(r.routing!.reasonCode).toBe("capability_missing");
  });

  it("refuses to accept an UNVERIFIED capability claim (fail-closed, and neutral)", () => {
    const claimed = staff("m1", { capabilities: fact(["finance.collect"], "self_declared") });
    const r = resolveCandidates(request(), [claimed]);
    expect(r.outcome).toBe("needs_routing");
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("capabilities_unverified");
    expect(r.rejected[0]!.neutral).toBe(true);
  });

  it("refuses a candidate whose authority is below what the work requires", () => {
    const junior = staff("m1", { authorityLevel: fact("automatic", "verified") });
    const r = resolveCandidates(request(), [junior]);
    expect(r.routing!.reasonCode).toBe("authority_below_required");
  });

  it("refuses when the amount exceeds the ceiling, comparing as decimals not floats", () => {
    const r = resolveCandidates(
      request({ authorityAmount: { amount: "100000.01", currency: "LKR" } }),
      [staff("m1")],
    );
    expect(r.routing!.reasonCode).toBe("authority_ceiling_exceeded");

    const atCeiling = resolveCandidates(
      request({ authorityAmount: { amount: "100000.00", currency: "LKR" } }),
      [staff("m1")],
    );
    expect(atCeiling.outcome).toBe("candidates");
  });

  it("never converts currency to satisfy a ceiling", () => {
    const r = resolveCandidates(
      request({ authorityAmount: { amount: "1.00", currency: "USD" } }),
      [staff("m1")],
    );
    expect(r.outcome).toBe("needs_routing");
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("authority_currency_mismatch");
  });

  it("does not recommend the person who raised the work to decide it", () => {
    const r = resolveCandidates(request({ raisedByMembershipId: "m1" }), [staff("m1")]);
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("self_review");
    expect(r.rejected[0]!.neutral).toBe(false);
  });
});

describe("mandatory verified skills — F-R2B-2", () => {
  it("refuses EVERYONE when the work mandates a verified skill and no verified record exists", () => {
    // Both people SAY they have it. Neither has it verified. The system must not choose.
    const a = staff("m1", { declaredSkills: fact(["forklift"], "self_declared") });
    const b = staff("m2", { declaredSkills: fact(["forklift"], "manager_entered") });
    const r = resolveCandidates(request({ requiredVerifiedSkills: ["forklift"] }), [a, b]);

    expect(r.outcome).toBe("needs_routing");
    expect(r.routing!.reasonCode).toBe("temporarily_unavailable:verified_skills_absent");
    expect(r.routing!.detail).toContain("mandates a verified skill");
    // Not a mark against either person: nobody was ever offered verification.
    expect(r.rejected.every((x) => x.neutral)).toBe(true);
  });

  it("accepts a genuinely verified skill, and rejects one that is verified but wrong", () => {
    const holder = staff("m1", { verifiedSkills: fact(["forklift"], "verified", { sourceRef: { table: "certifications", id: "c1" } }) });
    const other = staff("m2", { verifiedSkills: fact(["crane"], "verified") });
    const r = resolveCandidates(request({ requiredVerifiedSkills: ["forklift"] }), [holder, other]);

    expect(r.candidates.map((c) => c.membershipId)).toEqual(["m1"]);
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("verified_skill_missing");
    expect(r.rejected[0]!.neutral).toBe(false);
  });
});

describe("company isolation", () => {
  it("refuses a candidate from another company even when the caller supplies one", () => {
    const foreign = staff("m1", { companyId: CO_B });
    const r = resolveCandidates(request(), [foreign]);
    expect(r.outcome).toBe("needs_routing");
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("company_mismatch");
  });

  it("makes a cross-company leak LOUD at its source rather than quietly filtering it", () => {
    expect(() => assertSingleCompany(CO_A, [staff("m1"), staff("m2", { companyId: CO_B })]))
      .toThrow(/leaked across companies/);
  });

  it("takes the company from the request, never from the candidate record", () => {
    // The candidate claims company A while the authorised request is for company B.
    const r = resolveCandidates(request({ companyId: CO_B }), [staff("m1")]);
    expect(r.outcome).toBe("needs_routing");
    expect(r.companyId).toBe(CO_B);
  });
});

describe("no protected or sensitive attribute may ever enter", () => {
  const forbidden = [
    "ethnicity", "religion", "maritalStatus", "health", "disability", "dateOfBirth",
    "gender", "sexualOrientation", "politicalOpinion", "homeAddress", "photoUrl",
    "visaStatus", "criminalRecord", "salary", "unionMembership", "dependants", "pregnancyStatus",
  ];

  for (const key of forbidden) {
    it(`refuses "${key}" at construction`, () => {
      expect(() =>
        candidateEvidence({ membershipId: "m1", companyId: CO_A, candidateType: "staff" }, { [key]: "x" }),
      ).toThrow(ProtectedAttributeError);
    });
  }

  it("names the attribute as protected rather than giving a generic refusal", () => {
    try {
      candidateEvidence({ membershipId: "m1", companyId: CO_A, candidateType: "staff" }, { religion: "x" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/protected or sensitive personal attribute/);
    }
  });

  it("refuses an UNKNOWN signal too — the guard is an allowlist, not a word blocklist", () => {
    // "postcodeCluster" is on no denylist anywhere. An allowlist refuses it anyway.
    expect(() =>
      candidateEvidence({ membershipId: "m1", companyId: CO_A, candidateType: "staff" }, { postcodeCluster: 3 }),
    ).toThrow(/not a permitted suitability signal/);
  });

  it("permits the approved signals", () => {
    expect(() =>
      candidateEvidence(
        { membershipId: "m1", companyId: CO_A, candidateType: "staff" },
        { capabilities: fact(["x"], "verified"), openAssignments: fact(3, "verified") },
      ),
    ).not.toThrow();
  });
});

describe("no universal employee rank", () => {
  it("ranks the SAME person differently for different work, from one evidence set", () => {
    const person = staff("m1");
    const signals: Record<string, SuitabilitySignal> = {
      "finance.receivable_followup": {
        taskKind: "finance.receivable_followup", membershipId: "m1",
        outcomeCount: 8, verifiedOutcomeCount: 8, onTimeCount: 8, distinctDeciderCount: 3,
        weightedSuccessRate: 0.95, contradictory: false, ruleVersion: "r2b.1",
      },
      "legal.obligation_review": {
        taskKind: "legal.obligation_review", membershipId: "m1",
        outcomeCount: 9, verifiedOutcomeCount: 9, onTimeCount: 1, distinctDeciderCount: 3,
        weightedSuccessRate: 0.1, contradictory: false, ruleVersion: "r2b.1",
      },
    };
    const lookup: SignalLookup = (_m, kind) => signals[kind] ?? null;

    const good = resolveCandidates(request({ taskKind: "finance.receivable_followup" }), [person], lookup);
    const bad = resolveCandidates(
      request({ taskKind: "legal.obligation_review", department: "legal" }),
      [person],
      lookup,
    );

    expect(good.candidates[0]!.suitability).toBeGreaterThan(bad.candidates[0]!.suitability);
    // Both are still ELIGIBLE — history orders, it never gates.
    expect(bad.outcome).toBe("candidates");
  });

  it("ignores a signal earned on different work", () => {
    const otherWork: SuitabilitySignal = {
      taskKind: "some.other.work", membershipId: "m1",
      outcomeCount: 20, verifiedOutcomeCount: 20, onTimeCount: 20, distinctDeciderCount: 5,
      weightedSuccessRate: 1, contradictory: false, ruleVersion: "r2b.1",
    };
    const withSignal = resolveCandidates(request(), [staff("m1")], () => otherWork);
    const without = resolveCandidates(request(), [staff("m1")]);
    expect(withSignal.candidates[0]!.suitability).toBe(without.candidates[0]!.suitability);
    expect(withSignal.candidates[0]!.missingInformation.map((m) => m.code))
      .toContain("outcome_history_other_work");
  });
});

describe("cold start and missing information never penalise", () => {
  it("ranks a person with NO history identically to one whose history is average", () => {
    const coldStart = staff("m1");
    const known = staff("m2");
    const averageHistory: SuitabilitySignal = {
      taskKind: "finance.receivable_followup", membershipId: "m2",
      outcomeCount: 10, verifiedOutcomeCount: 10, onTimeCount: 5, distinctDeciderCount: 3,
      weightedSuccessRate: 0.5, contradictory: false, ruleVersion: "r2b.1",
    };
    const r = resolveCandidates(request(), [coldStart, known], (m) => (m === "m2" ? averageHistory : null));
    const a = r.candidates.find((c) => c.membershipId === "m1")!;
    const b = r.candidates.find((c) => c.membershipId === "m2")!;
    expect(a.suitability).toBe(b.suitability);
    // They differ in CONFIDENCE, which is reported honestly, not in rank.
    expect(a.confidence).toBeLessThan(b.confidence);
  });

  it("explains what is missing instead of inventing it", () => {
    const noSkills = staff("m1", { declaredSkills: absent(), verifiedSkills: absent() });
    const r = resolveCandidates(request({ preferredSkills: ["collections"] }), [noSkills]);
    const codes = r.candidates[0]!.missingInformation.map((m) => m.code);
    expect(codes).toContain("no_skill_record");
    expect(codes).toContain("no_outcome_history");
    expect(r.candidates[0]!.relevantSkills).toEqual([]);
  });

  it("declares a stale capacity snapshot stale instead of trusting it", () => {
    const stale = staff("m1", {
      available: fact(available, "inferred", { asOf: "2026-07-01T00:00:00.000Z" }),
    });
    const r = resolveCandidates(request(), [stale]);
    expect(r.outcome).toBe("needs_routing");
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("availability_stale");
    expect(r.rejected[0]!.neutral).toBe(true);
  });
});

describe("equal candidates and determinism", () => {
  it("orders two identical candidates deterministically, not by sort stability", () => {
    const forward = resolveCandidates(request(), [staff("m2"), staff("m1")]);
    const reverse = resolveCandidates(request(), [staff("m1"), staff("m2")]);
    expect(forward.candidates.map((c) => c.membershipId)).toEqual(["m1", "m2"]);
    expect(reverse.candidates.map((c) => c.membershipId)).toEqual(["m1", "m2"]);
  });

  it("produces an identical result on repeated runs of the same inputs", () => {
    const once = resolveCandidates(request(), [staff("m1"), staff("m2"), staff("m3")]);
    const twice = resolveCandidates(request(), [staff("m1"), staff("m2"), staff("m3")]);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});

describe("no eligible candidate", () => {
  it("returns needs_routing to the DEPARTMENT, never to an administrator or the owner", () => {
    const r = resolveCandidates(request({ department: "procurement" }), []);
    expect(r.outcome).toBe("needs_routing");
    expect(r.routing!.department).toBe("procurement");
    expect(r.routing!.reasonCode).toBe("no_candidates_supplied");
    // R1-D-3: nothing here may name a person as the fallback.
    expect(JSON.stringify(r.routing)).not.toMatch(/admin|owner/i);
  });

  it("distinguishes 'nobody can' from 'nobody can right now'", () => {
    const cannot = resolveCandidates(request(), [staff("m1", { capabilities: fact([], "verified") })]);
    const notNow = resolveCandidates(request(), [
      staff("m1", { available: fact({ ...available, onLeave: true, available: false }, "inferred", { asOf: "2026-09-01T00:00:00.000Z" }) }),
    ]);
    expect(cannot.routing!.reasonCode).toBe("capability_missing");
    expect(notNow.routing!.reasonCode).toBe("temporarily_unavailable:on_approved_leave");
  });

  it("keeps every rejected candidate visible so a human can see who was excluded and why", () => {
    const r = resolveCandidates(request(), [
      staff("m1", { active: fact(false, "verified") }),
      staff("m2", { capabilities: fact([], "verified") }),
    ]);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected.flatMap((x) => x.reasons.map((y) => y.code))).toEqual(
      expect.arrayContaining(["inactive", "capability_missing"]),
    );
  });

  it("reports every failed gate, not only the first", () => {
    const doomed = staff("m1", {
      capabilities: fact([], "verified"),
      available: fact({ ...available, onLeave: true, available: false }, "inferred", { asOf: "2026-09-01T00:00:00.000Z" }),
    });
    const r = resolveCandidates(request(), [doomed]);
    const codes = r.rejected[0]!.reasons.map((x) => x.code);
    expect(codes).toContain("capability_missing");
    expect(codes).toContain("on_approved_leave");
  });
});

describe("language", () => {
  it("does NOT affect ranking when the task does not require a language", () => {
    const speaks = staff("m1", { languages: fact(["si", "ta", "en"], "manager_entered") });
    const noRecord = staff("m2", { languages: absent() });
    const r = resolveCandidates(request(), [speaks, noRecord]);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]!.suitability).toBe(r.candidates[1]!.suitability);
  });

  it("gates on language ONLY when the task genuinely requires it", () => {
    const ta = staff("m1", { languages: fact(["ta"], "manager_entered") });
    const en = staff("m2", { languages: fact(["en"], "manager_entered") });
    const r = resolveCandidates(request({ requiredLanguage: "ta" }), [ta, en]);
    expect(r.candidates.map((c) => c.membershipId)).toEqual(["m1"]);
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("language_missing");
  });

  it("says so when a required language cannot be checked, rather than guessing", () => {
    const r = resolveCandidates(request({ requiredLanguage: "si" }), [staff("m1")]);
    expect(r.outcome).toBe("needs_routing");
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("language_unknown");
    expect(r.rejected[0]!.neutral).toBe(true);
  });
});

describe("request validation", () => {
  it("refuses a request that asks for no role at all", () => {
    expect(() => resolveCandidates(request({ roles: [] }), [staff("m1")])).toThrow(/at least one role/);
  });
});
