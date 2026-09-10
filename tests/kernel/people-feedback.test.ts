/**
 * R2B runtime — the human feedback path (owner Decision 3), application rules.
 *
 * The database enforces the same rules again, independently, in
 * tests/integration/r2b-feedback-runtime.test.ts. That duplication is the design: an application
 * guard protects the caller written against it, and a database guard protects the ones nobody has
 * written yet.
 */
import { describe, expect, it } from "vitest";
import {
  recordFeedback, safeComment, assertPayloadSafe, FeedbackRejected,
  FEEDBACK_EVENTS, PERSON_OUTCOME_EVENTS, MAX_COMMENT_LENGTH,
  type FeedbackWriter,
} from "@/kernel/people/feedback";

const CO = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const ITEM = "33333333-3333-4333-8333-333333333333";
const SUBJECT = "44444444-4444-4444-8444-444444444444";

const ctx = { companyId: CO, actorMembershipId: ACTOR };

function spyWriter() {
  const calls: Parameters<FeedbackWriter["record"]>[0][] = [];
  const writer: FeedbackWriter = {
    async record(args) { calls.push(args); return { feedbackId: `f${calls.length}` }; },
  };
  return { writer, calls };
}

const valid = (over: Record<string, unknown> = {}) => ({
  itemId: ITEM, event: "recommendation_accepted", ...over,
});

describe("identity is server-derived and cannot be supplied", () => {
  it("takes the company and the actor from the context, never from the input", async () => {
    const { writer, calls } = spyWriter();
    await recordFeedback(ctx, valid({
      // A client trying to attribute feedback elsewhere. The schema has no such fields, so
      // these are simply not read — there is no path by which they could be.
      companyId: "99999999-9999-4999-8999-999999999999",
      actorMembershipId: "88888888-8888-4888-8888-888888888888",
    }), writer);
    expect(calls[0]!.companyId).toBe(CO);
    expect(calls[0]!.actorMembershipId).toBe(ACTOR);
  });

  it("refuses an unparseable request rather than recording a partial one", async () => {
    const { writer, calls } = spyWriter();
    await expect(recordFeedback(ctx, { itemId: "not-a-uuid", event: "outcome_successful" }, writer))
      .rejects.toThrow(FeedbackRejected);
    expect(calls).toEqual([]);
  });

  it("refuses an unknown event", async () => {
    const { writer } = spyWriter();
    await expect(recordFeedback(ctx, valid({ event: "promoted" }), writer)).rejects.toThrow(/invalid/i);
  });
});

describe("the structured events the owner specified", () => {
  it("accepts every one of them", async () => {
    for (const event of FEEDBACK_EVENTS) {
      const { writer, calls } = spyWriter();
      const extra: Record<string, unknown> = {};
      if (PERSON_OUTCOME_EVENTS.has(event)) extra.subjectMembershipId = SUBJECT;
      if (event === "correction_supplied") extra.supersedesId = "55555555-5555-4555-8555-555555555555";
      await recordFeedback(ctx, valid({ event, ...extra }), writer);
      expect(calls[0]!.event, event).toBe(event);
    }
  });

  it("requires a CORRECTION to name what it supersedes", async () => {
    const { writer } = spyWriter();
    await expect(recordFeedback(ctx, valid({ event: "correction_supplied" }), writer))
      .rejects.toThrow(/must name the feedback it supersedes/);
  });

  it("requires feedback ABOUT A PERSON to name the person", async () => {
    const { writer } = spyWriter();
    for (const event of ["outcome_successful", "outcome_unsuccessful"]) {
      await expect(recordFeedback(ctx, valid({ event }), writer))
        .rejects.toThrow(/must name the membership/);
    }
  });

  it("does NOT require a subject for feedback about the KERNEL", async () => {
    // "the detector was noisy" and "the recommendation was wrong" judge the system, not a person.
    const { writer, calls } = spyWriter();
    await recordFeedback(ctx, valid({ event: "detector_precision" }), writer);
    await recordFeedback(ctx, valid({ event: "recommendation_rejected" }), writer);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.subjectMembershipId === null)).toBe(true);
  });

  it("keeps WHO IS JUDGING separate from WHO IS JUDGED", async () => {
    const { writer, calls } = spyWriter();
    await recordFeedback(ctx, valid({ event: "outcome_successful", subjectMembershipId: SUBJECT }), writer);
    expect(calls[0]!.actorMembershipId).toBe(ACTOR);
    expect(calls[0]!.subjectMembershipId).toBe(SUBJECT);
    expect(calls[0]!.actorMembershipId).not.toBe(calls[0]!.subjectMembershipId);
  });
});

describe("comments are bounded and safely handled", () => {
  it("strips control characters that would corrupt a log or a terminal", () => {
    // Written as ESCAPES: a test file must not contain raw control bytes either.
    const nasty = "hello\u0000world\u001b[31mred\u0007next";
    const clean = safeComment(nasty)!;
    expect(clean).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
    expect(clean).toContain("hello");
    expect(clean).toContain("next");
  });

  it("collapses runaway whitespace and trims", () => {
    expect(safeComment("  a\n\n\n   b   ")).toBe("a b");
  });

  it("treats an empty or whitespace-only comment as none", () => {
    expect(safeComment("   ")).toBeNull();
    expect(safeComment("")).toBeNull();
    expect(safeComment(null)).toBeNull();
  });

  it("truncates at the bound rather than storing an unbounded blob", () => {
    const long = "x".repeat(MAX_COMMENT_LENGTH * 3);
    expect(safeComment(long)!.length).toBe(MAX_COMMENT_LENGTH);
  });

  it("refuses a comment that exceeds the bound at the schema, before truncation is needed", async () => {
    const { writer } = spyWriter();
    await expect(recordFeedback(ctx, valid({ comment: "x".repeat(MAX_COMMENT_LENGTH + 1) }), writer))
      .rejects.toThrow(FeedbackRejected);
  });

  it("does NOT claim to sanitise meaning — markup is preserved as TEXT, not stripped", () => {
    // Pretending to neutralise content invites a caller to render it as HTML. The comment is
    // stored as written and always rendered as text.
    expect(safeComment("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });
});

describe("protected attributes and person scores never enter the payload", () => {
  for (const key of ["ethnicity", "religion", "maritalStatus", "health", "salary", "dateOfBirth", "postcode"]) {
    it(`refuses "${key}" in proposed or actual`, () => {
      expect(() => assertPayloadSafe({ [key]: "x" }, "proposed")).toThrow(/protected attribute/);
      expect(() => assertPayloadSafe({ [key]: "x" }, "actual")).toThrow(/protected attribute/);
    });
  }

  for (const key of ["suitability", "score", "rating", "rank"]) {
    it(`refuses the person score "${key}"`, () => {
      expect(() => assertPayloadSafe({ [key]: 0.9 }, "actual")).toThrow(/person score/);
    });
  }

  it("permits the fields feedback legitimately carries", () => {
    expect(() =>
      assertPayloadSafe({ recommendedMembershipId: "m1", chosenMembershipId: "m2", reasonCode: "x" }, "actual"),
    ).not.toThrow();
  });

  it("refuses before anything is written", async () => {
    const { writer, calls } = spyWriter();
    await expect(recordFeedback(ctx, valid({ actual: { salary: 1 } }), writer)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("feedback never changes authority or employment", () => {
  it("the writer contract carries no field that could", async () => {
    const { writer, calls } = spyWriter();
    await recordFeedback(ctx, valid({ event: "outcome_unsuccessful", subjectMembershipId: SUBJECT }), writer);
    const keys = Object.keys(calls[0]!).join(" ").toLowerCase();
    for (const forbidden of ["role", "capability", "permission", "authority", "pay", "salary", "terminate", "discipline"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
