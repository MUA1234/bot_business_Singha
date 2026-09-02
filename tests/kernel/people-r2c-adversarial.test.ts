/**
 * R2C — the adversarial scenarios the owner listed that the live campaign cannot reach cheaply.
 *
 * These are the ones about REFUSAL: an advisor who must not gain approval authority, a consultant
 * from another company, language used where it may not be, and a person who legitimately appears
 * in several role pools at once without any of them leaking into another.
 */
import { describe, expect, it } from "vitest";
import {
  candidateEvidence, type AvailabilitySignal, type CandidateEvidence, type CandidateRequest,
} from "@/kernel/people/candidate";
import { fact } from "@/kernel/people/evidence";
import { resolveCandidates } from "@/kernel/people/resolve";
import { buildSignal, type OutcomeRecord } from "@/kernel/people/learning";
import { formTeam } from "@/kernel/people/team";

const CO_A = "11111111-1111-4111-8111-111111111111";
const CO_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-02T09:00:00.000Z");

const available: AvailabilitySignal = {
  available: true, onLeave: false, availableHours: 20, capacityStatus: "healthy",
};

function staff(id: string, over: Record<string, unknown> = {}): CandidateEvidence {
  return candidateEvidence(
    { membershipId: id, companyId: CO_A, candidateType: "staff" },
    {
      active: fact(true, "verified"),
      capabilities: fact(["ops.manage"], "verified"),
      authorityLevel: fact("manager_approval", "verified"),
      available: fact(available, "inferred", { asOf: "2026-09-01T00:00:00.000Z" }),
      ...over,
    },
  );
}

const req = (over: Partial<CandidateRequest> = {}): CandidateRequest => ({
  companyId: CO_A, department: "operations", taskKind: "ops.task.create_internal",
  roles: ["assignee"], requiredCapability: "ops.manage", requiredAuthority: "automatic",
  authorityAmount: null, authorityDomain: "operations",
  requiredVerifiedSkills: [], preferredSkills: [], requiredLanguage: null,
  onDateIso: "2026-09-02", estimateHours: null, now: NOW, ...over,
});

describe("ONE PERSON IN SEVERAL ROLE POOLS", () => {
  const versatile = staff("m1", { advisorDomains: fact(["operations"], "verified") });

  it("appears in each pool as a SEPARATE proposal, never as one merged entry", () => {
    const r = resolveCandidates(req({ roles: ["assignee", "advisor"] }), [versatile]);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.map((c) => c.role).sort()).toEqual(["advisor", "assignee"]);
    expect(new Set(r.candidates.map((c) => c.membershipId))).toEqual(new Set(["m1"]));
  });

  it("is judged against DIFFERENT history in each pool", () => {
    const asAssignee: OutcomeRecord[] = [1, 2, 3].map((i) => ({
      outcomeId: `a${i}`, companyId: CO_A, membershipId: "m1",
      taskKind: "ops.task.create_internal", role: "assignee", itemId: `i${i}`,
      outcome: "verified", deciderId: `mgr${i}`, deciderType: "user",
      occurredAt: new Date(NOW.getTime() - i * 5 * 86_400_000).toISOString(),
      businessDeadline: null, metOnTime: null, correctsOutcomeId: null, source: "transition",
    }));

    const r = resolveCandidates(req({ roles: ["assignee", "advisor"] }), [versatile], {
      signalFor: (m, kind, role) => buildSignal(asAssignee, m, kind, CO_A, NOW, role ?? "assignee"),
    });

    const assignee = r.candidates.find((c) => c.role === "assignee")!;
    const advisor = r.candidates.find((c) => c.role === "advisor")!;

    // The assignee proposal is lifted by the history; the advisor proposal is not touched by it.
    expect(assignee.suitability).toBeGreaterThan(advisor.suitability);
    // The FOLD already filtered by role, so the advisor lookup returns nothing at all and the
    // resolver reports plain absence. That is the stronger outcome: the cross-role guard in the
    // resolver (asserted in people-roles-team.test.ts) is the second line, for a caller that
    // hands over a signal from the wrong role directly.
    expect(advisor.missingInformation.map((x) => x.code)).toContain("no_outcome_history");
  });

  it("keeps the ADVISOR proposal free of any delegated authority", () => {
    const withDelegation = staff("m1", {
      advisorDomains: fact(["operations"], "verified"),
      delegationScope: fact({
        delegationId: "d1", fromMembership: "boss", domain: "operations",
        maxAmount: "1000.00", currency: "LKR",
        startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-30T00:00:00.000Z",
      }, "verified"),
    });
    const r = resolveCandidates(req({ roles: ["advisor"] }), [withDelegation]);
    expect(r.candidates[0]!.delegationScope).toBeNull();
  });
});

describe("AN ADVISOR GAINS NO APPROVAL AUTHORITY", () => {
  it("is offered as an advisor without their authority level being consulted at all", () => {
    // Someone at the very bottom of the ladder, with evidenced advisory experience.
    const junior = staff("m1", {
      authorityLevel: fact("automatic", "verified"),
      advisorDomains: fact(["operations"], "verified"),
    });
    const r = resolveCandidates(req({ roles: ["advisor"] }), [junior]);
    expect(r.candidates).toHaveLength(1);
    // …and being an advisor confers nothing: no delegation, no ceiling, no capability claim.
    expect(r.candidates[0]!.delegationScope).toBeNull();
    expect(JSON.stringify(r.candidates[0])).not.toMatch(/authorityCeiling|approve/i);
  });

  it("refuses somebody with no evidenced advisory experience, however capable", () => {
    const capable = staff("m1", { capabilities: fact(["ops.manage", "finance.approve"], "verified") });
    const r = resolveCandidates(req({ roles: ["advisor"] }), [capable]);
    expect(r.outcome).toBe("needs_routing");
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("no_advisory_experience_recorded");
    // Never having advised on something is not a fault.
    expect(r.rejected[0]!.neutral).toBe(true);
  });

  it("refuses advisory experience earned in a DIFFERENT domain", () => {
    const wrongDomain = staff("m1", { advisorDomains: fact(["legal"], "verified") });
    const r = resolveCandidates(req({ roles: ["advisor"], authorityDomain: "finance" }), [wrongDomain]);
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("advisory_experience_other_domain");
  });
});

describe("EXTERNAL CONSULTANTS", () => {
  const consultant = (id: string, over: Record<string, unknown> = {}): CandidateEvidence =>
    candidateEvidence(
      { membershipId: id, companyId: CO_B, candidateType: "external_consultant" },
      {
        active: fact(true, "verified"),
        providerId: fact("p1", "verified"),
        providerStatus: fact("verified" as const, "verified"),
        engagementScope: fact(
          { domains: ["operations"], internalAccess: false as const, endsAt: "2026-12-31T00:00:00.000Z" },
          "verified",
        ),
        authorityLevel: fact("automatic", "verified"),
        available: fact(available, "inferred", { asOf: "2026-09-01T00:00:00.000Z" }),
        ...over,
      },
    );

  it("a CROSS-COMPANY consultant is refused when the engagement is not this company's", () => {
    // The engagement is what makes a consultant considerable, and it belongs to a company. An
    // engagement covering another company's domains does not cover this work.
    const foreign = consultant("c1", {
      engagementScope: fact(
        { domains: ["something_else"], internalAccess: false as const, endsAt: null }, "verified"),
    });
    const r = resolveCandidates(
      req({ roles: ["external_consultant"], allowExternalConsultants: true }), [foreign]);
    expect(r.outcome).toBe("needs_routing");
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("engagement_scope_excludes_domain");
  });

  it("is refused outright when the work was never opened to external providers", () => {
    const r = resolveCandidates(req({ roles: ["external_consultant"] }), [consultant("c1")]);
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("external_not_permitted");
  });

  it("carries NO internal capability even when the evidence offered one", () => {
    const overreaching = consultant("c1", { capabilities: fact(["ops.manage"], "verified") });
    const r = resolveCandidates(
      req({ roles: ["external_consultant"], allowExternalConsultants: true }), [overreaching]);
    expect(r.candidates[0]!.relevantCapabilities).toEqual([]);
    expect(r.candidates[0]!.engagementScope!.internalAccess).toBe(false);
  });

  it("can never be the accountable assignee", () => {
    const r = resolveCandidates(
      req({ roles: ["assignee"], allowExternalConsultants: true }), [consultant("c1")]);
    expect(r.outcome).toBe("needs_routing");
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("wrong_candidate_type");
  });
});

describe("LANGUAGE gates only work that genuinely requires it", () => {
  const si = staff("m1", { languages: fact(["si", "en"], "verified") });
  const ta = staff("m2", { languages: fact(["ta"], "verified") });
  const en = staff("m3", { languages: fact(["en"], "verified") });

  for (const [lang, expected] of [["en", "m3"], ["si", "m1"], ["ta", "m2"]] as const) {
    it(`selects only speakers of ${lang} when the work requires it`, () => {
      const r = resolveCandidates(req({ requiredLanguage: lang }), [si, ta, en]);
      expect(r.candidates.map((c) => c.membershipId)).toContain(expected);
      const wrong = [si, ta, en].filter((c) => !(c.languages.value ?? []).includes(lang));
      for (const w of wrong) {
        expect(r.candidates.map((c) => c.membershipId)).not.toContain(w.membershipId);
      }
    });
  }

  it("does NOT rank anyone by language when the work does not require one", () => {
    const r = resolveCandidates(req(), [si, ta, en]);
    expect(r.candidates).toHaveLength(3);
    const scores = new Set(r.candidates.map((c) => c.suitability));
    // Language is not a ranking input, so three people who differ only in language tie exactly.
    expect(scores.size).toBe(1);
  });

  it("says so when a required language cannot be checked, rather than guessing", () => {
    const unknown = staff("m9");
    const r = resolveCandidates(req({ requiredLanguage: "ta" }), [unknown]);
    expect(r.rejected[0]!.reasons.map((x) => x.code)).toContain("language_unknown");
    expect(r.rejected[0]!.neutral).toBe(true);
  });
});

describe("SKILL REVOCATION between one resolution and the next", () => {
  it("stops satisfying a mandatory requirement the moment the evidence is withdrawn", () => {
    const withSkill = staff("m1", { verifiedSkills: fact(["audit"], "verified") });
    const revoked = staff("m1", { verifiedSkills: fact([], "verified") });

    const before = resolveCandidates(req({ requiredVerifiedSkills: ["audit"] }), [withSkill]);
    expect(before.candidates).toHaveLength(1);

    // The SAME request, re-resolved against the revoked evidence. A recommendation is never a
    // standing permission: it is recomputed from whatever is true now.
    const after = resolveCandidates(req({ requiredVerifiedSkills: ["audit"] }), [revoked]);
    expect(after.outcome).toBe("needs_routing");
    expect(after.rejected[0]!.reasons.map((x) => x.code)).toContain("verified_skill_missing");
  });
});

describe("NO CANDIDATE FOR ONE ROLE, VALID CANDIDATES FOR ANOTHER", () => {
  it("resolves each role independently, so one empty pool does not empty the others", () => {
    // Capable, available, but has advised on nothing.
    const worker = staff("m1");

    const assignee = resolveCandidates(req({ roles: ["assignee"] }), [worker]);
    const advisor = resolveCandidates(req({ roles: ["advisor"] }), [worker]);

    expect(assignee.outcome).toBe("candidates");
    expect(advisor.outcome).toBe("needs_routing");
    // The two results are independent objects; neither can affect the other.
    expect(assignee.candidates).toHaveLength(1);
    expect(advisor.candidates).toHaveLength(0);
  });
});

describe("a team never silently duplicates responsibility", () => {
  it("never names the same person twice", () => {
    const a = { membershipId: "a", candidateType: "staff" as const, role: "assignee" as const,
      relevantCapabilities: ["x", "y"], relevantSkills: [], availability: null,
      confidence: 1, suitability: 1, evidenceRefs: [], reasons: [], missingInformation: [],
      requiresHumanReview: [], delegationScope: null, engagementScope: null };
    const t = formTeam([a], { minimum: 3, mustCover: ["x", "y"], leadCapability: null });
    expect(t.members).toHaveLength(1);
    expect(new Set(t.members.map((m) => m.membershipId)).size).toBe(t.members.length);
    expect(t.understaffed).toBe(true);
  });
});
