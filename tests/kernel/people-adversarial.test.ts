/**
 * R2B — regressions for defects found by the adversarial review pass.
 *
 * Each of these was REPRODUCED against the code as written before it was fixed. They are kept
 * separately from the acceptance suites because their value is specifically that they go red if
 * the fix is ever undone.
 */
import { describe, expect, it } from "vitest";
import {
  candidateEvidence, type AvailabilitySignal, type CandidateEvidence, type CandidateRequest,
} from "@/kernel/people/candidate";
import { fact } from "@/kernel/people/evidence";
import { resolveCandidates } from "@/kernel/people/resolve";
import { buildSignal, explainSignal, OBSOLETE_AFTER_DAYS, type OutcomeRecord } from "@/kernel/people/learning";

const CO_A = "aaaaaaaa-1111-4111-8111-111111111111";
const CO_B = "bbbbbbbb-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-02T09:00:00.000Z");

const available: AvailabilitySignal = {
  available: true, onLeave: false, availableHours: 12, capacityStatus: "healthy",
};

function staff(id: string, over: Record<string, unknown> = {}): CandidateEvidence {
  return candidateEvidence(
    { membershipId: id, companyId: CO_A, candidateType: "staff" },
    {
      active: fact(true, "verified"),
      capabilities: fact([], "verified"),
      authorityLevel: fact("automatic", "verified"),
      available: fact(available, "inferred", { asOf: "2026-09-01T00:00:00.000Z" }),
      ...over,
    },
  );
}

const request = (over: Partial<CandidateRequest> = {}): CandidateRequest => ({
  companyId: CO_A, department: "finance", taskKind: "k", roles: ["assignee"],
  requiredCapability: null, requiredAuthority: "automatic", authorityAmount: null,
  authorityDomain: null, requiredVerifiedSkills: [], preferredSkills: [], requiredLanguage: null,
  onDateIso: "2026-09-02", estimateHours: null, now: NOW, ...over,
});

describe("R2B-F-002 — supplied evidence must never override the authorised identity", () => {
  it("keeps the caller's company and membership, whatever the loader supplied", () => {
    // Identity keys are legitimately on the permitted-signal allowlist, so the protected-attribute
    // guard lets them through. Before the fix, the spread order let them REPLACE the identity.
    const e = candidateEvidence(
      { membershipId: "m1", companyId: CO_A, candidateType: "staff" },
      { companyId: CO_B, membershipId: "someone-else", candidateType: "external_consultant" } as never,
    );
    expect(e.companyId).toBe(CO_A);
    expect(e.membershipId).toBe("m1");
    expect(e.candidateType).toBe("staff");
  });

  it("means an outcome-history lookup can never be pointed at a different person", () => {
    // The real damage was never the company check — gateCompany would still have refused. It was
    // that signalFor(c.membershipId, ...) would fetch SOMEONE ELSE's record.
    const seen: string[] = [];
    const e = candidateEvidence(
      { membershipId: "m1", companyId: CO_A, candidateType: "staff" },
      {
        membershipId: "victim",
        active: fact(true, "verified"),
        capabilities: fact([], "verified"),
        authorityLevel: fact("automatic", "verified"),
        available: fact(available, "inferred", { asOf: "2026-09-01T00:00:00.000Z" }),
      } as never,
    );
    resolveCandidates(request(), [e], {
      signalFor: (m) => { seen.push(m); return null; },
    });
    expect(seen).toEqual(["m1"]);
    expect(seen).not.toContain("victim");
  });
});

describe("R2B-F-003 — two roles for the same person must order deterministically", () => {
  it("gives the same order however the caller lists the roles", () => {
    // R2C: an advisor also needs evidenced advisory experience, so this test can still exercise
    // the ORDERING rule it was written for rather than the advisor-evidence gate.
    const p = staff("m1", { advisorDomains: fact(["finance"], "verified") });
    const a = resolveCandidates(request({ roles: ["assignee", "advisor"] }), [p]);
    const b = resolveCandidates(request({ roles: ["advisor", "assignee"] }), [p]);
    // Both entries share a membership id, so membership alone left the order decided by input.
    expect(a.candidates.map((c) => c.role)).toEqual(b.candidates.map((c) => c.role));
    expect(a.candidates.map((c) => c.role)).toEqual(["advisor", "assignee"]);
  });
});

describe("R2B-F-004 — an undated workload reading must not be silently trusted", () => {
  it("says the age is unknown rather than treating it as current", () => {
    const undated = staff("m1", { available: fact(available, "inferred") });
    // `now` is years after any plausible snapshot; with no asOf it cannot be aged at all.
    const r = resolveCandidates(request({ now: new Date("2030-01-01T00:00:00.000Z") }), [undated]);
    expect(r.candidates[0]!.missingInformation.map((m) => m.code)).toContain("capacity_age_unknown");
  });

  it("still USES it — excluding someone for a loader's omission would penalise missing data", () => {
    const undated = staff("m1", { available: fact(available, "inferred") });
    const r = resolveCandidates(request(), [undated]);
    expect(r.outcome).toBe("candidates");
  });

  it("reports the unknown age even when the person is excluded for another reason", () => {
    const undatedOnLeave = staff("m1", {
      available: fact({ ...available, available: false, onLeave: true }, "inferred"),
    });
    const r = resolveCandidates(request(), [undatedOnLeave]);
    expect(r.missingInformation.map((m) => m.code)).toContain("capacity_age_unknown");
  });
});

describe("R2B-F-005 — a reopened outcome must never be reported as a verified one", () => {
  const reopened = (i: number, decider: string, days: number): OutcomeRecord => ({
    outcomeId: `r${i}`, companyId: CO_A, membershipId: "m1", taskKind: "k", role: "assignee", itemId: `i${i}`,
    outcome: "reopened", deciderId: decider, deciderType: "user",
    occurredAt: new Date(NOW.getTime() - days * 86_400_000).toISOString(),
    businessDeadline: null, metOnTime: null, correctsOutcomeId: null, source: "transition",
  });

  it("calls the evidence base CONFIRMED outcomes, not verified ones", () => {
    const history = [1, 2, 3, 4, 5].map((i) => reopened(i, `mgr${i % 3}`, i * 4));
    const r = resolveCandidates(request(), [staff("m1")], {
      signalFor: () => buildSignal(history, "m1", "k", CO_A, NOW),
    });
    const adverse = r.candidates[0]!.reasons.find((x) => x.code === "outcome_history_counts_against")!;
    // It read "5 verified outcome(s)" on a record of five REOPENED items — praise for rework.
    expect(adverse.detail).toContain("confirmed outcome");
    expect(adverse.detail).not.toContain("verified outcome");
  });
});

describe("R2B-F-006 — the challenge explanation must match what the fold actually counted", () => {
  const rec = (id: string, decider: string, days: number): OutcomeRecord => ({
    outcomeId: id, companyId: CO_A, membershipId: "m1", taskKind: "k", role: "assignee", itemId: id,
    outcome: "verified", deciderId: decider, deciderType: "user",
    occurredAt: new Date(NOW.getTime() - days * 86_400_000).toISOString(),
    businessDeadline: null, metOnTime: null, correctsOutcomeId: null, source: "transition",
  });

  it("excludes obsolete records from the count it shows a manager", () => {
    const records = [rec("a", "m2", 3), rec("b", "m3", 10), rec("c", "m4", OBSOLETE_AFTER_DAYS + 5)];
    const x = explainSignal(records, "m1", "k", CO_A, NOW);
    expect(x.counted).toBe(2);
    expect(x.excluded.find((e) => e.outcomeId === "c")!.why).toMatch(/obsolete/);
  });

  it("excludes future-dated records", () => {
    const future = { ...rec("f", "m2", 0), occurredAt: new Date(NOW.getTime() + 86_400_000).toISOString() };
    const x = explainSignal([future], "m1", "k", CO_A, NOW);
    expect(x.counted).toBe(0);
    expect(x.excluded[0]!.why).toMatch(/future/);
  });

  it("names the burst-suppressed records instead of silently counting them", () => {
    const sameDay = [
      { ...rec("b1", "attacker", 1), occurredAt: "2026-09-01T01:00:00.000Z" },
      { ...rec("b2", "attacker", 1), occurredAt: "2026-09-01T02:00:00.000Z" },
      { ...rec("b3", "attacker", 1), occurredAt: "2026-09-01T03:00:00.000Z" },
    ];
    const x = explainSignal(sameDay, "m1", "k", CO_A, NOW);
    expect(x.counted).toBe(1);
    expect(x.excluded.map((e) => e.outcomeId)).toEqual(["b2", "b3"]);
    expect(x.excluded[0]!.why).toMatch(/more than 1 outcome from this decision-maker/);
  });

  it("agrees with the fold's own count", () => {
    const records = [
      rec("a", "m2", 2), rec("b", "m3", 6), rec("c", "m4", 11),
      { ...rec("d", "m2", 2), outcomeId: "d" },                    // same decider, same day -> suppressed
      rec("e", "m5", OBSOLETE_AFTER_DAYS + 1),                     // obsolete
    ];
    const signal = buildSignal(records, "m1", "k", CO_A, NOW)!;
    const x = explainSignal(records, "m1", "k", CO_A, NOW);
    expect(x.counted).toBe(signal.confirmedOutcomeCount);
  });
});
