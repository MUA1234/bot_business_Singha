/**
 * The boundary between outcome verification and what the system believes about people.
 *
 * ── Why this is a permanent gate rather than a one-off check ─────────────────────────────────
 *
 * Verification now writes to `management_item_transitions`, and that is the same log the learning
 * fold reads to decide whether an outcome is evidence about a person. Two of those states already
 * carry a polarity: `verified` is +1 and `reopened` is −1. So the machine that decides whether a
 * business condition is resolved is one field away from deciding whether someone is good at their
 * job.
 *
 * Nothing here connects verification to learning. These tests assert that it CANNOT be connected
 * by accident, and they are written against the EXISTING fold — no rule beside an existing rule,
 * because a second, laxer path to the same grant is how a boundary quietly loosens (R2F-F-007).
 *
 * Pure: no database, no clock, no network.
 */
import { describe, it, expect } from "vitest";
import { isAdmissible, buildSignal, type OutcomeRecord } from "@/kernel/people/learning";
import { MIN_OUTCOMES_TO_DEMOTE, MIN_DECIDERS } from "@/kernel/people/suitability";

const CO = "11111111-1111-1111-1111-111111111111";
const SUBJECT = "mem-subject";
const HUMAN = "mem-human-verifier";
const NOW = new Date("2026-09-05T00:00:00.000Z");

const record = (over: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
  outcomeId: `o-${Math.random().toString(36).slice(2)}`,
  companyId: CO,
  membershipId: SUBJECT,
  taskKind: "ops.task.create_internal",
  role: "assignee",
  itemId: "item-1",
  outcome: "verified",
  deciderId: HUMAN,
  deciderType: "user",
  occurredAt: "2026-09-01T00:00:00.000Z",
  businessDeadline: null,
  metOnTime: null,
  correctsOutcomeId: null,
  source: "transition",
  ...over,
});

/** Exactly what the scheduled verifier writes: no actor, and a system actor type. */
const machineVerification = (over: Partial<OutcomeRecord> = {}) =>
  record({ deciderId: null, deciderType: "system", ...over });

describe("a machine conclusion is never evidence about a person", () => {
  it("a scheduled `verified` is inadmissible", () => {
    expect(isAdmissible(machineVerification(), SUBJECT, CO)).toBe(false);
  });

  it("a scheduled `reopened` — a condition that persists — is inadmissible", () => {
    // This is the one that matters most. `reopened` scores −1, and a persisting condition says
    // nothing about whether the assigned person did their work: they may have done exactly what
    // was asked and the underlying problem may still be there.
    expect(isAdmissible(machineVerification({ outcome: "reopened" }), SUBJECT, CO)).toBe(false);
  });

  it("BOTH guards exclude it independently, so neither is load-bearing alone", () => {
    // Type alone, with an actor id present.
    expect(isAdmissible(record({ deciderType: "system" }), SUBJECT, CO)).toBe(false);
    // Actor alone, with a human type.
    expect(isAdmissible(record({ deciderId: null }), SUBJECT, CO)).toBe(false);
    // A record that is missing either one is refused; only both together admit it.
    expect(isAdmissible(record(), SUBJECT, CO)).toBe(true);
  });

  it("`ai` is excluded on the same footing as `system`", () => {
    expect(isAdmissible(record({ deciderType: "ai" }), SUBJECT, CO)).toBe(false);
  });

  it("a hundred machine verifications move nothing at all", () => {
    const many = Array.from({ length: 100 }, () => machineVerification());
    expect(buildSignal(many, SUBJECT, "ops.task.create_internal", CO, NOW)).toBeNull();
  });

  it("machine records cannot dilute or outvote a real human record", () => {
    const human = record();
    const withNoise = [human, ...Array.from({ length: 50 }, () => machineVerification({ outcome: "reopened" }))];
    const alone = buildSignal([human], SUBJECT, "ops.task.create_internal", CO, NOW);
    const noisy = buildSignal(withNoise, SUBJECT, "ops.task.create_internal", CO, NOW);
    // Byte for byte the same conclusion: the machine records are not weighted, not counted, and
    // not treated as disagreement.
    expect(JSON.stringify(noisy)).toBe(JSON.stringify(alone));
  });
});

describe("a machine cannot satisfy a rule that requires distinct people", () => {
  it("machine verifications contribute no distinct deciders", () => {
    const many = Array.from({ length: 20 }, () => machineVerification());
    const signal = buildSignal([...many, record()], SUBJECT, "ops.task.create_internal", CO, NOW);
    // One human wrote one record. Twenty machine conclusions add nobody.
    expect(signal?.distinctDeciderCount).toBe(1);
  });

  it("a person still cannot confirm their own outcome", () => {
    expect(isAdmissible(record({ deciderId: SUBJECT }), SUBJECT, CO)).toBe(false);
  });

  it("and never across companies", () => {
    expect(isAdmissible(record({ companyId: "other" }), SUBJECT, CO)).toBe(false);
  });
});

/**
 * ── R2F-F-015, pinned rather than fixed ──────────────────────────────────────────────────────
 *
 * The protection above is the ACTOR DISCIPLINE — `deciderType` and `deciderId` — and not the
 * polarity table. `reopened` is −1 whatever produced it, so a `condition_persists` recorded with
 * a human actor becomes admissible negative evidence about whoever is named accountable, even
 * though a persisting condition says nothing about whether that person did their work.
 *
 * Nothing in the runtime does that today: the scheduled sweep passes no actor and is the only
 * writer. Two further thresholds bound the damage even then. These tests state the exposure and
 * its bounds exactly, so the day somebody passes an actor id to a verification they are looking at
 * a test that says what it would mean.
 */
describe("what protects people here, precisely", () => {
  it("a HUMAN-recorded `reopened` IS admissible and IS counted against them", () => {
    const humanReopen = record({ outcome: "reopened" });
    expect(isAdmissible(humanReopen, SUBJECT, CO)).toBe(true);

    const signal = buildSignal([humanReopen], SUBJECT, "ops.task.create_internal", CO, NOW);
    expect(signal).not.toBeNull();
    // Counted as evidence, and none of it successful.
    expect(signal!.confirmedOutcomeCount).toBe(1);
    expect(signal!.weightedSuccessRate).toBe(0);
  });

  it("but the existing thresholds mean one, or one person, can never demote anyone", () => {
    // The anti-fabrication rules the owner's instruction refers to. A single conclusion — human
    // or otherwise — cannot move a recommendation, and neither can one person's opinion.
    expect(MIN_OUTCOMES_TO_DEMOTE).toBeGreaterThan(1);
    expect(MIN_DECIDERS).toBeGreaterThan(1);

    const signal = buildSignal(
      [record({ outcome: "reopened" })], SUBJECT, "ops.task.create_internal", CO, NOW,
    );
    expect(signal!.confirmedOutcomeCount).toBeLessThan(MIN_OUTCOMES_TO_DEMOTE);
    expect(signal!.distinctDeciderCount).toBeLessThan(MIN_DECIDERS);
  });

  it("so the protection is that verification never records a human actor", () => {
    // The paired assertion lives with the runtime, in
    // tests/integration/r2-verification-schedule.test.ts, which reads back the actual transition
    // rows and requires actor_type='system' with a null actor. Here the contract is stated: it is
    // the ACTOR, not the outcome value, that keeps a machine conclusion out of a person's record.
    expect(isAdmissible(machineVerification({ outcome: "reopened" }), SUBJECT, CO)).toBe(false);
  });
});
