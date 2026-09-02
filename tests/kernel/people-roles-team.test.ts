/**
 * R2C — required roles, complementary team formation and role-specific learning.
 *
 * The rules under test are the ones that stop this becoming a staff-ranking system: roles come
 * from the catalogue and never from a model, a team is picked for COVERAGE rather than by taking
 * the top N, and an outcome earned in one role is never evidence about another.
 */
import { describe, expect, it } from "vitest";
import { requiredRolesFor, roleSpecOf, type ActionWithRoles } from "@/kernel/people/roles-required";
import { formTeam } from "@/kernel/people/team";
import { buildSignal, explainSignal, type OutcomeRecord } from "@/kernel/people/learning";
import { resolveCandidates } from "@/kernel/people/resolve";
import { candidateEvidence, type CandidateRequest, type EligibleCandidate } from "@/kernel/people/candidate";
import { fact } from "@/kernel/people/evidence";
import type { Observation } from "@/kernel/observation";

const CO = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-02T09:00:00.000Z");

const action = (over: Partial<ActionWithRoles> = {}): ActionWithRoles => ({
  id: "ops.task.create_internal", department: "operations", capability: "operations.task.manage",
  authorityFloor: "automatic", reversible: true, automaticSafe: true, internalOnly: true,
  description: "x", ...over,
});

const obs = (over: Partial<Observation> = {}): Observation => ({
  companyId: CO, department: "operations", observationSource: "operations.task_exception",
  kind: "task_exception", subjectRef: { table: "tasks", id: "t1" },
  evidence: [{ sourceTable: "tasks", sourceId: "t1", facts: {}, origin: "detector" }],
  evidenceAt: NOW.toISOString(), detectedAt: NOW.toISOString(), facts: {},
  summary: "x", severity: "warn", priority: "normal", confidence: 1,
  identityKey: "k", freshness: "fresh", suggestedActionCategory: "schedule",
  authorityClass: "automatic", correlationId: "c1", businessDeadline: null, ...over,
} as Observation);

describe("required roles come from the CATALOGUE, never from a model", () => {
  it("gives a plain action exactly one role: a mandatory assignee", () => {
    const roles = requiredRolesFor(action(), obs());
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ role: "assignee", mandatory: true });
  });

  it("asks for a TEAM only when the action declares a minimum size", () => {
    const roles = requiredRolesFor(action({ roles: { teamOfAtLeast: 3 } }), obs());
    expect(roles[0]).toMatchObject({ role: "assignee", mandatory: true, minimum: 3 });
  });

  it("makes an advisor MANDATORY only where specialist advice is genuinely required", () => {
    const required = requiredRolesFor(action({ roles: { requiresAdvisor: true } }), obs());
    expect(required.find((r) => r.role === "advisor")!.mandatory).toBe(true);

    const helpful = requiredRolesFor(action({ roles: { advisorHelpful: true } }), obs());
    expect(helpful.find((r) => r.role === "advisor")!.mandatory).toBe(false);
  });

  it("offers an OPTIONAL advisor on a critical observation, read from STRUCTURED severity", () => {
    const roles = requiredRolesFor(action(), obs({ severity: "critical" }));
    const advisor = roles.find((r) => r.role === "advisor")!;
    expect(advisor.mandatory).toBe(false);
    expect(advisor.reason).toContain("does not block the work");
  });

  it("never makes a DELEGATE mandatory — that would stall work unless authority had been lent", () => {
    const roles = requiredRolesFor(
      action({ authorityFloor: "manager_approval", roles: { mayProposeDelegate: true } }), obs());
    expect(roles.find((r) => r.role === "delegate")!.mandatory).toBe(false);
  });

  it("does not propose a delegate for work that needs no approval authority at all", () => {
    const roles = requiredRolesFor(action({ roles: { mayProposeDelegate: true } }), obs());
    expect(roles.find((r) => r.role === "delegate")).toBeUndefined();
  });

  it("considers an external consultant ONLY where the action has been opened to them", () => {
    expect(requiredRolesFor(action(), obs()).find((r) => r.role === "external_consultant")).toBeUndefined();
    const opened = requiredRolesFor(action({ roles: { mayUseExternalConsultant: true } }), obs());
    expect(opened.find((r) => r.role === "external_consultant")!.mandatory).toBe(false);
  });

  it("fills in conservative defaults for an action that declares nothing", () => {
    const spec = roleSpecOf(action());
    expect(spec.requiredVerifiedSkills).toEqual([]);
    expect(spec.preferredSkills).toEqual([]);
    expect(spec.teamMustCover).toEqual([]);
    expect(spec.requiresAdvisor).toBeUndefined();
  });

  it("is a pure function of the action and the observation — no model input exists", () => {
    const a = action({ roles: { requiresAdvisor: true } });
    const first = requiredRolesFor(a, obs());
    const second = requiredRolesFor(a, obs());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
const person = (id: string, caps: string[]): EligibleCandidate => ({
  membershipId: id, candidateType: "staff", role: "assignee",
  relevantCapabilities: caps, relevantSkills: [],
  availability: { available: true, onLeave: false, availableHours: 20, capacityStatus: "healthy" },
  confidence: 0.8, suitability: 0.6, evidenceRefs: [], reasons: [], missingInformation: [],
  requiresHumanReview: [], delegationScope: null, engagementScope: null,
});

describe("a team is built for COVERAGE, not by taking the top N", () => {
  it("prefers a complementary member over a duplicate of one already chosen", () => {
    // `dup` would rank alongside `a`; `b` covers something nobody else does.
    const a = person("a", ["design"]);
    const dup = person("dup", ["design"]);
    const b = person("b", ["build"]);
    const t = formTeam([a, dup, b], { minimum: 2, mustCover: ["design", "build"], leadCapability: null });

    expect(t.members.map((m) => m.membershipId).sort()).toEqual(["a", "b"]);
    expect(t.covered).toEqual(["build", "design"]);
    expect(t.missingCapabilities).toEqual([]);
  });

  it("REPORTS what it cannot cover rather than presenting a complete-looking team", () => {
    const t = formTeam([person("a", ["design"])], {
      minimum: 1, mustCover: ["design", "build", "test"], leadCapability: null,
    });
    expect(t.missingCapabilities).toEqual(["build", "test"]);
    expect(t.reasons.map((r) => r.code)).toContain("coverage_incomplete");
  });

  it("says when a member adds nothing new, rather than padding silently", () => {
    const t = formTeam([person("a", ["design"]), person("dup", ["design"])], {
      minimum: 2, mustCover: ["design"], leadCapability: null,
    });
    expect(t.members).toHaveLength(2);
    expect(t.reasons.map((r) => r.code)).toContain("added_without_new_coverage");
  });

  it("reports UNDERSTAFFED instead of pretending the requested size was met", () => {
    const t = formTeam([person("a", ["design"])], { minimum: 3, mustCover: ["design"], leadCapability: null });
    expect(t.understaffed).toBe(true);
    expect(t.requestedMinimum).toBe(3);
    expect(t.members).toHaveLength(1);
  });

  it("proposes exactly ONE accountable lead, listed first", () => {
    const t = formTeam([person("a", ["design"]), person("b", ["build"])], {
      minimum: 2, mustCover: ["design", "build"], leadCapability: null,
    });
    expect(t.lead).not.toBeNull();
    expect(t.members[0]!.membershipId).toBe(t.lead!.membershipId);
    expect(t.members.filter((m) => m.membershipId === t.lead!.membershipId)).toHaveLength(1);
  });

  it("returns NO LEAD when nobody holds the lead capability, rather than promoting whoever sorted first", () => {
    const t = formTeam([person("a", ["design"]), person("b", ["build"])], {
      minimum: 2, mustCover: ["design"], leadCapability: "operations.task.manage",
    });
    expect(t.lead).toBeNull();
    expect(t.leadReason).toContain("operations.task.manage");
    expect(t.reasons.map((r) => r.code)).toContain("no_lead");
    // The team is still proposed — a missing lead is reported, not a reason to hide the work.
    expect(t.members).toHaveLength(2);
  });

  it("makes the person who HOLDS the lead capability the lead, whatever their order", () => {
    const t = formTeam([person("a", ["design"]), person("b", ["operations.task.manage"])], {
      minimum: 2, mustCover: ["design"], leadCapability: "operations.task.manage",
    });
    expect(t.lead!.membershipId).toBe("b");
    expect(t.members[0]!.membershipId).toBe("b");
  });

  it("handles an empty pool truthfully", () => {
    const t = formTeam([], { minimum: 2, mustCover: ["design"], leadCapability: null });
    expect(t.members).toEqual([]);
    expect(t.lead).toBeNull();
    expect(t.missingCapabilities).toEqual(["design"]);
    expect(t.understaffed).toBe(true);
  });

  it("is deterministic — the same pool gives the same team every time", () => {
    const pool = [person("a", ["design"]), person("b", ["build"]), person("c", ["test"])];
    const once = formTeam(pool, { minimum: 2, mustCover: ["design", "build", "test"], leadCapability: null });
    const twice = formTeam(pool, { minimum: 2, mustCover: ["design", "build", "test"], leadCapability: null });
    expect(JSON.stringify(once.members.map((m) => m.membershipId)))
      .toBe(JSON.stringify(twice.members.map((m) => m.membershipId)));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
describe("outcomes NEVER cross roles", () => {
  const outcome = (over: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
    outcomeId: `o${Math.random()}`, companyId: CO, membershipId: "m1", taskKind: "k",
    role: "assignee", itemId: "i1", outcome: "verified",
    deciderId: "mgr1", deciderType: "user",
    occurredAt: new Date(NOW.getTime() - 5 * 86_400_000).toISOString(),
    businessDeadline: null, metOnTime: null, correctsOutcomeId: null, source: "transition", ...over,
  });

  const deliveryHistory = [
    outcome({ outcomeId: "d1", deciderId: "mgr1" }),
    outcome({ outcomeId: "d2", deciderId: "mgr2", occurredAt: new Date(NOW.getTime() - 10 * 86_400_000).toISOString() }),
    outcome({ outcomeId: "d3", deciderId: "mgr3", occurredAt: new Date(NOW.getTime() - 15 * 86_400_000).toISOString() }),
  ];

  it("delivery performance is NOT advisor performance", () => {
    expect(buildSignal(deliveryHistory, "m1", "k", CO, NOW, "assignee")).not.toBeNull();
    expect(buildSignal(deliveryHistory, "m1", "k", CO, NOW, "advisor")).toBeNull();
  });

  it("advisor success is NOT delegated-authority evidence", () => {
    const advisorHistory = deliveryHistory.map((r) => ({ ...r, role: "advisor" as const }));
    expect(buildSignal(advisorHistory, "m1", "k", CO, NOW, "advisor")).not.toBeNull();
    expect(buildSignal(advisorHistory, "m1", "k", CO, NOW, "delegate")).toBeNull();
  });

  it("consultant performance stays with the consultant role", () => {
    const consultantHistory = deliveryHistory.map((r) => ({ ...r, role: "external_consultant" as const }));
    expect(buildSignal(consultantHistory, "m1", "k", CO, NOW, "external_consultant")).not.toBeNull();
    expect(buildSignal(consultantHistory, "m1", "k", CO, NOW, "assignee")).toBeNull();
  });

  it("the signal states which role it belongs to", () => {
    expect(buildSignal(deliveryHistory, "m1", "k", CO, NOW, "assignee")!.role).toBe("assignee");
  });

  it("the explanation names the role an excluded outcome was earned in", () => {
    const x = explainSignal(deliveryHistory, "m1", "k", CO, NOW, "advisor");
    expect(x.counted).toBe(0);
    expect(x.excluded[0]!.why).toMatch(/earned in the "assignee" role, not as advisor/);
  });

  it("the RESOLVER refuses a signal from another role, and says so", () => {
    const evidence = candidateEvidence(
      { membershipId: "m1", companyId: CO, candidateType: "staff" },
      {
        active: fact(true, "verified"), capabilities: fact([], "verified"),
        authorityLevel: fact("automatic", "verified"),
        available: fact(
          { available: true, onLeave: false, availableHours: 20, capacityStatus: "healthy" as const },
          "inferred", { asOf: "2026-09-01T00:00:00.000Z" },
        ),
      },
    );
    const req: CandidateRequest = {
      companyId: CO, department: "operations", taskKind: "k", roles: ["advisor"],
      requiredCapability: null, requiredAuthority: "automatic", authorityAmount: null,
      authorityDomain: null, requiredVerifiedSkills: [], preferredSkills: [], requiredLanguage: null,
      onDateIso: "2026-09-02", estimateHours: null, now: NOW,
    };
    // A strong ASSIGNEE signal offered while resolving the ADVISOR role.
    const r = resolveCandidates(req, [evidence], {
      signalFor: () => buildSignal(deliveryHistory, "m1", "k", CO, NOW, "assignee"),
    });
    expect(r.candidates[0]!.missingInformation.map((m) => m.code)).toContain("outcome_history_other_role");
  });
});
