/**
 * The human feedback and outcome path (R2B, owner Decision 3).
 *
 * This is the missing half of learning. `management_item_feedback` has existed since R1 draft
 * unit 006 and nothing ever wrote to it, so the fold had no input in production. This module is
 * the one service that writes it.
 *
 * ── What it will and will not accept ────────────────────────────────────────────────────────
 *
 * Only an AUTHORISED HUMAN, identified by the server session, may record feedback. There is no
 * parameter through which a model-generated claim can be labelled human: `actor_type` is fixed
 * to `user` inside the database function, not passed in. A model may propose; only a person may
 * attest.
 *
 * The company and the actor come from the authenticated context and are re-checked against the
 * ITEM's own company inside the RPC, so a caller cannot record feedback into another company
 * even by supplying its identifiers.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────────────────────
 *
 * Nothing here changes authority, permissions, employment, pay or discipline, and nothing here
 * assigns work. Feedback is evidence about an OUTCOME; the consequences of an outcome are a
 * human's to decide, every time.
 */
import { z } from "zod";

/** The structured events the owner specified, plus the four unit 006 already defined. */
export const FEEDBACK_EVENTS = [
  "recommendation_accepted",
  "recommendation_rejected",
  "different_candidate_selected",
  "outcome_successful",
  "outcome_unsuccessful",
  "result_disputed",
  "correction_supplied",
  "insufficient_evidence",
  // Retained from R1 draft unit 006.
  "decision_reason",
  "assignment_override",
  "verification_result",
  "detector_precision",
] as const;

export type FeedbackEvent = (typeof FEEDBACK_EVENTS)[number];

/**
 * Events that make a claim ABOUT A PERSON, and therefore feed the suitability fold.
 *
 * The distinction matters: `detector_precision` says a DETECTOR was noisy and
 * `recommendation_rejected` says the KERNEL proposed badly. Neither is evidence about the person
 * who happened to be named, and counting them would penalise people for the system's mistakes.
 */
export const PERSON_OUTCOME_EVENTS: ReadonlySet<FeedbackEvent> = new Set([
  "outcome_successful",
  "outcome_unsuccessful",
]);

/** Bounded, so a learning input cannot become an unbounded free-text store. */
export const MAX_COMMENT_LENGTH = 2000;

/**
 * The request, validated before it reaches the database.
 *
 * `companyId` and `actorMembershipId` are absent BY DESIGN: they are derived from the
 * authenticated server session by the caller, never accepted from the client. A schema that
 * cannot express them is a schema through which they cannot be forged.
 */
export const FeedbackRequestSchema = z.object({
  itemId: z.string().uuid(),
  event: z.enum(FEEDBACK_EVENTS),
  /** The person the feedback is ABOUT, when it concerns one. */
  subjectMembershipId: z.string().uuid().nullable().optional(),
  /** What the system proposed, and what actually happened. The difference is the signal. */
  proposed: z.record(z.unknown()).nullable().optional(),
  actual: z.record(z.unknown()).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
  comment: z.string().max(MAX_COMMENT_LENGTH).nullable().optional(),
  /** A correction supersedes an earlier row; the earlier row is never deleted. */
  supersedesId: z.string().uuid().nullable().optional(),
});

export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

/**
 * Strip anything that must never be stored on a learning input.
 *
 * A comment is written by a person and may contain anything at all. This does not attempt to
 * understand it — it removes control characters that would corrupt a log or a terminal, collapses
 * runaway whitespace, and truncates. It makes no claim to sanitise meaning, and the comment is
 * always rendered as text, never as markup.
 */
export function safeComment(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw
    // C0/C1 control characters and the Unicode line and paragraph separators, written as
    // ESCAPES so the source file itself never contains a raw control byte.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_COMMENT_LENGTH);
}

/**
 * Keys that must never appear in `proposed` or `actual`.
 *
 * These payloads are caller-shaped, so unlike candidate evidence they cannot use a positive
 * allowlist without breaking every legitimate future field. A denylist is the weaker tool and is
 * used here knowingly — the database refuses the same keys again on the way in.
 */
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  "ethnicity", "race", "religion", "maritalstatus", "familystatus", "health", "disability",
  "pregnancy", "gender", "sexualorientation", "politicalopinion", "dateofbirth", "dob",
  "age", "salary", "pay", "address", "postcode", "photo", "biometric", "criminalrecord",
  "suitability", "score", "rating", "rank",
]);

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

export class FeedbackRejected extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "FeedbackRejected";
  }
}

export function assertPayloadSafe(payload: Record<string, unknown> | null | undefined, field: string): void {
  if (!payload) return;
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(norm(key))) {
      throw new FeedbackRejected(
        "protected_attribute",
        `${field}.${key} is a protected attribute or a person score and may not be recorded as feedback`,
      );
    }
  }
}

/** Everything the writer needs, all of it server-derived. */
export interface FeedbackContext {
  companyId: string;
  actorMembershipId: string;
}

export interface FeedbackWriter {
  record(args: {
    companyId: string;
    itemId: string;
    actorMembershipId: string;
    event: FeedbackEvent;
    subjectMembershipId: string | null;
    proposed: Record<string, unknown> | null;
    actual: Record<string, unknown> | null;
    reason: string | null;
    comment: string | null;
    supersedesId: string | null;
  }): Promise<{ feedbackId: string }>;
}

/**
 * Validate and record one piece of feedback.
 *
 * The application checks are the FIRST line; the RPC repeats the company, actor, lifecycle and
 * rate rules independently. That duplication is deliberate: an application guard protects the
 * caller written against it, and a database guard protects the ones nobody has written yet.
 */
export async function recordFeedback(
  ctx: FeedbackContext,
  input: unknown,
  writer: FeedbackWriter,
): Promise<{ feedbackId: string }> {
  const parsed = FeedbackRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new FeedbackRejected("invalid_request", parsed.error.issues.map((i) => i.message).join("; "));
  }
  const req = parsed.data;

  assertPayloadSafe(req.proposed ?? null, "proposed");
  assertPayloadSafe(req.actual ?? null, "actual");

  // A correction must say what it corrects; an event named "correction_supplied" with nothing
  // superseded is a claim with no referent.
  if (req.event === "correction_supplied" && !req.supersedesId) {
    throw new FeedbackRejected(
      "correction_without_target",
      "a correction must name the feedback it supersedes",
    );
  }
  // Feedback about a PERSON must say which person. Otherwise the fold has an outcome it cannot
  // attribute, and an unattributable outcome is not evidence.
  if (PERSON_OUTCOME_EVENTS.has(req.event) && !req.subjectMembershipId) {
    throw new FeedbackRejected(
      "subject_required",
      `"${req.event}" is evidence about a person and must name the membership it concerns`,
    );
  }

  return writer.record({
    companyId: ctx.companyId,
    itemId: req.itemId,
    actorMembershipId: ctx.actorMembershipId,
    event: req.event,
    subjectMembershipId: req.subjectMembershipId ?? null,
    proposed: req.proposed ?? null,
    actual: req.actual ?? null,
    reason: req.reason ?? null,
    comment: safeComment(req.comment),
    supersedesId: req.supersedesId ?? null,
  });
}
