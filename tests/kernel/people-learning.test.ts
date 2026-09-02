/**
 * R2B checkpoint 4 — safe outcome learning.
 *
 * The owner set an explicit bar: *"Do not mark AIM-008 or related learning requirements
 * locally_verified merely because feedback is read. Verification requires a deterministic test
 * proving that a verified outcome changes a later suitable recommendation for an explainable
 * reason."*
 *
 * The first block below is exactly that test. The rest are the safety properties.
 */
import { describe, expect, it } from "vitest";
import {
  candidateEvidence, type AvailabilitySignal, type CandidateEvidence, type CandidateRequest,
} from "@/kernel/people/candidate";
import { fact } from "@/kernel/people/evidence";
import {
  buildSignal, explainSignal, signalLookupFrom, SIGNAL_RULE_VERSION,
  OBSOLETE_AFTER_DAYS, type OutcomeRecord,
} from "@/kernel/people/learning";
import { resolveCandidates } from "@/kernel/people/resolve";

const CO_A = "11111111-1111-4111-8111-111111111111";
const CO_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-02T09:00:00.000Z");
const KIND = "finance.receivable_followup";

const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

let seq = 0;
function outcome(over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  seq += 1;
  return {
    outcomeId: `o${seq}`,
    companyId: CO_A,
    membershipId: "m1",
    taskKind: KIND,
    itemId: `i${seq}`,
    outcome: "verified",
    deciderId: "mgr1",
    deciderType: "user",
    occurredAt: daysAgo(10),
    businessDeadline: daysAgo(12),
    metOnTime: true,
    correctsOutcomeId: null,
    source: "transition",
    ...over,
  };
}

/** A run of good outcomes from several deciders on distinct days — genuinely strong evidence. */
function goodHistory(membershipId = "m1"): OutcomeRecord[] {
  return [
    outcome({ membershipId, deciderId: "mgr1", occurredAt: daysAgo(5) }),
    outcome({ membershipId, deciderId: "mgr2", occurredAt: daysAgo(12) }),
    outcome({ membershipId, deciderId: "mgr3", occurredAt: daysAgo(20) }),
    outcome({ membershipId, deciderId: "mgr1", occurredAt: daysAgo(31) }),
  ];
}

const available: AvailabilitySignal = {
  available: true, onLeave: false, availableHours: 20, capacityStatus: "healthy",
};

function staff(id: string, over: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    ...candidateEvidence(
      { membershipId: id, companyId: CO_A, candidateType: "staff" },
      {
        active: fact(true, "verified"),
        capabilities: fact(["finance.collect"], "verified"),
        authorityLevel: fact("manager_approval", "verified"),
        available: fact(available, "inferred", { asOf: "2026-09-01T00:00:00.000Z" }),
      },
    ),
    ...over,
  };
}

const request = (over: Partial<CandidateRequest> = {}): CandidateRequest => ({
  companyId: CO_A, department: "finance", taskKind: KIND, roles: ["assignee"],
  requiredCapability: "finance.collect", requiredAuthority: "manager_approval",
  authorityAmount: null, authorityDomain: null,
  requiredVerifiedSkills: [], preferredSkills: [], requiredLanguage: null,
  onDateIso: "2026-09-02", estimateHours: 4, now: NOW, ...over,
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("THE OWNER'S BAR: a verified outcome changes a later recommendation, explainably", () => {
  it("promotes the person with verified outcomes ABOVE an otherwise identical colleague", () => {
    // Two candidates, identical in every respect the gates can see.
    const history = goodHistory("m1");

    const before = resolveCandidates(request(), [staff("m1"), staff("m2")]);
    // With NO history they are equal, and the deterministic tie-break orders them by id.
    expect(before.candidates[0]!.suitability).toBe(before.candidates[1]!.suitability);

    const after = resolveCandidates(request(), [staff("m1"), staff("m2")], {
      signalFor: signalLookupFrom(history, CO_A, NOW),
    });

    // MEASURABLE: the order actually changed, and by a real margin.
    expect(after.candidates[0]!.membershipId).toBe("m1");
    expect(after.candidates[0]!.suitability).toBeGreaterThan(after.candidates[1]!.suitability);

    // EXPLAINABLE: the reason names the evidence, the deciders and the rule version.
    const why = after.candidates[0]!.reasons.find((r) => r.code === "outcome_history_supports");
    expect(why).toBeDefined();
    expect(why!.detail).toContain("verified outcome");
    expect(why!.detail).toContain("decision-makers");
    expect(why!.detail).toContain(SIGNAL_RULE_VERSION);
    expect(after.signalRuleVersion).toBe(SIGNAL_RULE_VERSION);
  });

  it("DEMOTES on repeated reopened work, but only past the higher adverse threshold", () => {
    const reopened = (n: number, decider: string, days: number) =>
      outcome({ outcomeId: `r${n}`, outcome: "reopened", deciderId: decider, occurredAt: daysAgo(days), metOnTime: null });

    // Four adverse outcomes: below the demotion threshold of five, so NOTHING happens yet.
    const four = [reopened(1, "mgr1", 3), reopened(2, "mgr2", 9), reopened(3, "mgr3", 15), reopened(4, "mgr2", 22)];
    const withFour = resolveCandidates(request(), [staff("m1")], { signalFor: signalLookupFrom(four, CO_A, NOW) });
    expect(withFour.candidates[0]!.reasons.map((r) => r.code)).not.toContain("outcome_history_counts_against");
    expect(withFour.candidates[0]!.missingInformation.map((m) => m.code)).toContain("insufficient_outcome_history");

    // A fifth crosses it.
    const five = [...four, reopened(5, "mgr1", 28)];
    const withFive = resolveCandidates(request(), [staff("m1")], { signalFor: signalLookupFrom(five, CO_A, NOW) });
    expect(withFive.candidates[0]!.reasons.map((r) => r.code)).toContain("outcome_history_counts_against");
    expect(withFive.candidates[0]!.suitability).toBeLessThan(withFour.candidates[0]!.suitability);
  });

  it("keeps a demoted candidate ELIGIBLE — history orders, it never gates", () => {
    const bad = Array.from({ length: 8 }, (_, i) =>
      outcome({ outcomeId: `b${i}`, outcome: "reopened", deciderId: `mgr${i % 3}`, occurredAt: daysAgo(i * 4 + 2), metOnTime: null }),
    );
    const r = resolveCandidates(request(), [staff("m1")], { signalFor: signalLookupFrom(bad, CO_A, NOW) });
    expect(r.outcome).toBe("candidates");
    expect(r.candidates).toHaveLength(1);
  });
});

describe("minimum evidence thresholds", () => {
  it("makes NO adjustment below three verified outcomes", () => {
    const two = [outcome({ deciderId: "mgr1", occurredAt: daysAgo(4) }), outcome({ deciderId: "mgr2", occurredAt: daysAgo(9) })];
    const withTwo = resolveCandidates(request(), [staff("m1")], { signalFor: signalLookupFrom(two, CO_A, NOW) });
    const none = resolveCandidates(request(), [staff("m1")]);
    expect(withTwo.candidates[0]!.suitability).toBe(none.candidates[0]!.suitability);
    expect(withTwo.candidates[0]!.missingInformation.map((m) => m.code)).toContain("insufficient_outcome_history");
  });

  it("makes NO adjustment when every outcome comes from ONE decider (one-manager bias)", () => {
    const single = [
      outcome({ deciderId: "mgr1", occurredAt: daysAgo(3) }),
      outcome({ deciderId: "mgr1", occurredAt: daysAgo(10) }),
      outcome({ deciderId: "mgr1", occurredAt: daysAgo(17) }),
      outcome({ deciderId: "mgr1", occurredAt: daysAgo(24) }),
    ];
    const r = resolveCandidates(request(), [staff("m1")], { signalFor: signalLookupFrom(single, CO_A, NOW) });
    const none = resolveCandidates(request(), [staff("m1")]);
    expect(r.candidates[0]!.suitability).toBe(none.candidates[0]!.suitability);
    expect(r.candidates[0]!.missingInformation.map((m) => m.code)).toContain("single_decider_history");
  });
});

describe("contradictory and sparse history", () => {
  it("makes NO adjustment and asks for a human when history disagrees with itself", () => {
    const mixed = [
      outcome({ deciderId: "mgr1", occurredAt: daysAgo(4) }),
      outcome({ deciderId: "mgr2", occurredAt: daysAgo(8) }),
      outcome({ deciderId: "mgr3", outcome: "reopened", occurredAt: daysAgo(6), metOnTime: null }),
      outcome({ deciderId: "mgr2", outcome: "reopened", occurredAt: daysAgo(11), metOnTime: null }),
    ];
    const signal = buildSignal(mixed, "m1", KIND, CO_A, NOW)!;
    expect(signal.contradictory).toBe(true);

    const r = resolveCandidates(request(), [staff("m1")], { signalFor: signalLookupFrom(mixed, CO_A, NOW) });
    const none = resolveCandidates(request(), [staff("m1")]);
    expect(r.candidates[0]!.suitability).toBe(none.candidates[0]!.suitability);
    expect(r.candidates[0]!.requiresHumanReview.map((x) => x.code)).toContain("contradictory_outcome_history");
  });

  it("returns no signal at all from an empty or wholly inadmissible history", () => {
    expect(buildSignal([], "m1", KIND, CO_A, NOW)).toBeNull();
    expect(buildSignal([outcome({ deciderType: "ai" })], "m1", KIND, CO_A, NOW)).toBeNull();
  });
});

describe("recent versus obsolete evidence", () => {
  it("weights recent evidence above old evidence", () => {
    const recent = buildSignal(
      [
        outcome({ outcomeId: "n1", deciderId: "a", occurredAt: daysAgo(2) }),
        outcome({ outcomeId: "n2", deciderId: "b", occurredAt: daysAgo(5) }),
        outcome({ outcomeId: "n3", deciderId: "c", occurredAt: daysAgo(8) }),
        outcome({ outcomeId: "n4", outcome: "reopened", deciderId: "a", occurredAt: daysAgo(300), metOnTime: null }),
      ],
      "m1", KIND, CO_A, NOW,
    )!;
    // The single old failure is heavily decayed, so success still dominates and is not
    // classified as a contradiction.
    expect(recent.weightedSuccessRate).toBeGreaterThan(0.9);
    expect(recent.contradictory).toBe(false);
  });

  it("EXCLUDES obsolete evidence entirely rather than merely fading it", () => {
    const ancient = [
      outcome({ outcomeId: "x1", deciderId: "a", occurredAt: daysAgo(OBSOLETE_AFTER_DAYS + 1) }),
      outcome({ outcomeId: "x2", deciderId: "b", occurredAt: daysAgo(OBSOLETE_AFTER_DAYS + 40) }),
      outcome({ outcomeId: "x3", deciderId: "c", occurredAt: daysAgo(OBSOLETE_AFTER_DAYS + 90) }),
    ];
    expect(buildSignal(ancient, "m1", KIND, CO_A, NOW)).toBeNull();
  });

  it("ignores a future-dated outcome", () => {
    const future = outcome({ occurredAt: new Date(NOW.getTime() + 86_400_000).toISOString() });
    expect(buildSignal([future], "m1", KIND, CO_A, NOW)).toBeNull();
  });

  it("counts a verified-but-late outcome as success at reduced weight", () => {
    const onTime = buildSignal(goodHistory(), "m1", KIND, CO_A, NOW)!;
    const late = buildSignal(goodHistory().map((r) => ({ ...r, metOnTime: false })), "m1", KIND, CO_A, NOW)!;
    expect(onTime.onTimeCount).toBe(4);
    expect(late.onTimeCount).toBe(0);
    // Still success — lateness reduces weight, it does not invert the outcome.
    expect(late.weightedSuccessRate).toBe(1);
  });

  it("does not treat 'no deadline existed' as lateness", () => {
    const noDeadline = goodHistory().map((r) => ({ ...r, businessDeadline: null, metOnTime: null }));
    const s = buildSignal(noDeadline, "m1", KIND, CO_A, NOW)!;
    expect(s.onTimeCount).toBe(0);
    expect(s.weightedSuccessRate).toBe(1); // absence of a deadline is not a failure
  });
});

describe("resisting feedback poisoning and bias", () => {
  it("collapses a BURST of fabricated outcomes to a single day's worth of evidence", () => {
    const honest = goodHistory();
    const flood = Array.from({ length: 200 }, (_, i) =>
      outcome({
        outcomeId: `flood${i}`, membershipId: "m1", outcome: "reopened", metOnTime: null,
        deciderId: "attacker", occurredAt: `2026-09-01T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      }),
    );
    const clean = buildSignal(honest, "m1", KIND, CO_A, NOW)!;
    const poisoned = buildSignal([...honest, ...flood], "m1", KIND, CO_A, NOW)!;

    // 200 fabricated records counted as ONE. The signal moves a little, as one genuine
    // dissenting outcome would — and nowhere near enough to invert it.
    expect(poisoned.verifiedOutcomeCount).toBe(clean.verifiedOutcomeCount + 1);
    expect(poisoned.weightedSuccessRate).toBeGreaterThan(0.7);
    expect(poisoned.contradictory).toBe(false);
  });

  it("caps how much any ONE decider can contribute, however many days they spread it over", () => {
    const zealot = Array.from({ length: 40 }, (_, i) =>
      outcome({ outcomeId: `z${i}`, deciderId: "mgr1", occurredAt: daysAgo(i + 1) }),
    );
    const oneDissent = [outcome({ outcomeId: "d1", outcome: "reopened", deciderId: "mgr2", occurredAt: daysAgo(2), metOnTime: null })];
    const s = buildSignal([...zealot, ...oneDissent], "m1", KIND, CO_A, NOW)!;

    // mgr1's total weight is capped, so a single fresh dissent from a second manager is a
    // meaningful share rather than being drowned out.
    //
    // The threshold is a LITERAL, deliberately. An earlier version of this test derived it from
    // MAX_WEIGHT_PER_DECIDER, which made it pass even when the cap was removed — the assertion
    // moved with the thing it was supposed to be testing. With the cap at 3 the dissent is worth
    // roughly a quarter of the evidence; without it, under 3%.
    expect(s.distinctDeciderCount).toBe(2);
    const dissentShare = 1 - s.weightedSuccessRate;
    expect(dissentShare).toBeGreaterThan(0.15);
  });

  it("refuses self-verified outcomes", () => {
    const selfMade = Array.from({ length: 10 }, (_, i) =>
      outcome({ outcomeId: `s${i}`, deciderId: "m1", occurredAt: daysAgo(i * 3 + 1) }),
    );
    expect(buildSignal(selfMade, "m1", KIND, CO_A, NOW)).toBeNull();
  });

  it("refuses AI-authored and unattributed outcomes", () => {
    const bogus = [
      outcome({ outcomeId: "a1", deciderType: "ai", deciderId: "bot" }),
      outcome({ outcomeId: "a2", deciderType: "system", deciderId: "cron" }),
      outcome({ outcomeId: "a3", deciderId: null }),
    ];
    expect(buildSignal(bogus, "m1", KIND, CO_A, NOW)).toBeNull();
  });

  it("never learns across companies", () => {
    const foreign = goodHistory().map((r) => ({ ...r, companyId: CO_B }));
    expect(buildSignal(foreign, "m1", KIND, CO_A, NOW)).toBeNull();
    // And the lookup binds the company once, so no call site can widen it.
    const lookup = signalLookupFrom(foreign, CO_A, NOW);
    expect(lookup("m1", KIND)).toBeNull();
  });

  it("excludes rejections and dismissals — they judge the kernel, not the person", () => {
    const kernelJudgements = [
      outcome({ outcomeId: "k1", outcome: "rejected", deciderId: "mgr1", occurredAt: daysAgo(2) }),
      outcome({ outcomeId: "k2", outcome: "dismissed", deciderId: "mgr2", occurredAt: daysAgo(4) }),
      outcome({ outcomeId: "k3", outcome: "dismissed", deciderId: "mgr3", occurredAt: daysAgo(6) }),
    ];
    expect(buildSignal(kernelJudgements, "m1", KIND, CO_A, NOW)).toBeNull();
  });
});

describe("documented corrections", () => {
  it("lets a correction SUPERSEDE the outcome it corrects, never sit alongside it", () => {
    const wrong = outcome({ outcomeId: "w1", outcome: "reopened", deciderId: "mgr1", occurredAt: daysAgo(5), metOnTime: null });
    const correction = outcome({
      outcomeId: "c1", outcome: "verified", deciderId: "mgr2", occurredAt: daysAgo(4), correctsOutcomeId: "w1",
    });
    const rest = [
      outcome({ outcomeId: "g1", deciderId: "mgr3", occurredAt: daysAgo(9) }),
      outcome({ outcomeId: "g2", deciderId: "mgr1", occurredAt: daysAgo(15) }),
    ];

    const uncorrected = buildSignal([wrong, ...rest], "m1", KIND, CO_A, NOW)!;
    const corrected = buildSignal([wrong, correction, ...rest], "m1", KIND, CO_A, NOW)!;

    expect(uncorrected.weightedSuccessRate).toBeLessThan(1);
    expect(corrected.weightedSuccessRate).toBe(1);
    // The corrected record is gone, not double-counted.
    expect(corrected.verifiedOutcomeCount).toBe(3);
  });

  it("explains what was counted and what was refused, so a manager can challenge it", () => {
    const records = [
      outcome({ outcomeId: "e1", deciderId: "mgr1", occurredAt: daysAgo(3) }),
      outcome({ outcomeId: "e2", deciderId: "m1", occurredAt: daysAgo(4) }),
      outcome({ outcomeId: "e3", deciderType: "ai", deciderId: "bot", occurredAt: daysAgo(5) }),
      outcome({ outcomeId: "e4", taskKind: "legal.obligation_review", deciderId: "mgr2", occurredAt: daysAgo(6) }),
      outcome({ outcomeId: "e5", outcome: "dismissed", deciderId: "mgr2", occurredAt: daysAgo(7) }),
      outcome({ outcomeId: "e6", companyId: CO_B, deciderId: "mgr2", occurredAt: daysAgo(8) }),
    ];
    const x = explainSignal(records, "m1", KIND, CO_A);
    expect(x.counted).toBe(1);
    const reasons = Object.fromEntries(x.excluded.map((e) => [e.outcomeId, e.why]));
    expect(reasons.e2).toMatch(/self-verified/);
    expect(reasons.e3).toMatch(/confirmed by ai/);
    expect(reasons.e4).toMatch(/not this work/);
    expect(reasons.e5).toMatch(/not the person/);
    expect(reasons.e6).toMatch(/another company/);
  });
});

describe("deterministic rebuild", () => {
  it("produces an IDENTICAL signal from shuffled input", () => {
    const records = [...goodHistory(), outcome({ outcomeId: "z", outcome: "reopened", deciderId: "mgr4", occurredAt: daysAgo(40), metOnTime: null })];
    const forward = buildSignal(records, "m1", KIND, CO_A, NOW);
    const reversed = buildSignal([...records].reverse(), "m1", KIND, CO_A, NOW);
    const shuffled = buildSignal([records[2]!, records[0]!, records[4]!, records[1]!, records[3]!], "m1", KIND, CO_A, NOW);
    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it("rebuilds the same signal on repeated runs", () => {
    const records = goodHistory();
    for (let i = 0; i < 5; i++) {
      expect(buildSignal(records, "m1", KIND, CO_A, NOW)).toEqual(buildSignal(records, "m1", KIND, CO_A, NOW));
    }
  });

  it("carries a rule version so a past recommendation can be reproduced and challenged", () => {
    expect(buildSignal(goodHistory(), "m1", KIND, CO_A, NOW)!.ruleVersion).toBe(SIGNAL_RULE_VERSION);
  });
});

describe("learning may never touch authority, permissions or a person's terms", () => {
  it("leaves the required authority and every gate verdict unchanged", () => {
    const strong = signalLookupFrom(goodHistory(), CO_A, NOW);
    const withLearning = resolveCandidates(
      request({ requiredAuthority: "owner_approval" }), [staff("m1")], { signalFor: strong },
    );
    const without = resolveCandidates(request({ requiredAuthority: "owner_approval" }), [staff("m1")]);

    // An excellent record does NOT lift anyone over an authority gate.
    expect(withLearning.outcome).toBe("needs_routing");
    expect(without.outcome).toBe("needs_routing");
    expect(withLearning.routing!.reasonCode).toBe(without.routing!.reasonCode);
  });

  it("cannot make an ineligible person eligible, however good their history", () => {
    const noCapability = staff("m1", { capabilities: fact([], "verified") });
    const r = resolveCandidates(request(), [noCapability], { signalFor: signalLookupFrom(goodHistory(), CO_A, NOW) });
    expect(r.outcome).toBe("needs_routing");
    expect(r.routing!.reasonCode).toBe("capability_missing");
  });

  it("emits nothing that could discipline, reward, pay or terminate anyone", () => {
    const s = buildSignal(goodHistory(), "m1", KIND, CO_A, NOW)!;
    const keys = Object.keys(s).join(" ").toLowerCase();
    for (const forbidden of ["pay", "salary", "bonus", "discipline", "warning", "terminate", "dismiss", "rank", "grade", "rating"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("keeps the signal bounded so it can never dominate a hard requirement", () => {
    const perfect = signalLookupFrom(goodHistory(), CO_A, NOW);
    const none = resolveCandidates(request(), [staff("m1")]);
    const best = resolveCandidates(request(), [staff("m1")], { signalFor: perfect });
    expect(best.candidates[0]!.suitability - none.candidates[0]!.suitability).toBeLessThanOrEqual(0.15 + 1e-9);
  });
});
