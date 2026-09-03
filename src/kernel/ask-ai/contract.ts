/**
 * R2D — the Ask-AI answer contract.
 *
 * The model's prose is never trusted on its own. What crosses this boundary is a structure that
 * has been checked against the catalogue, the requester's actual access and the languages this
 * system supports — and anything that fails is refused rather than repaired, because a
 * half-understood answer about someone's work is worse than no answer.
 *
 * The refusals here are not defensive decoration. Each one corresponds to a way an answer could
 * mislead a member of staff about what is true, what they may do, or what has already happened.
 */
import { z } from "zod";
import { actionById } from "../catalogue";

/** The languages R2D supports. An unrecognised code is refused, never approximated. */
export const LANGUAGES = ["en", "si", "ta"] as const;
export type Language = (typeof LANGUAGES)[number];

/** A reference to a record the answer relies on. Never a copy of it. */
export const CitationSchema = z.object({
  sourceTable: z.string().min(1).max(64),
  sourceId: z.string().min(1).max(64),
  /** What this citation supports — a label, not the record's content. */
  claimLabel: z.string().max(200).optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

/** A proposal from the action catalogue. Never an execution. */
export const SuggestedActionSchema = z.object({
  actionId: z.string().min(1).max(100),
  rationale: z.string().max(500).optional(),
  requiresApproval: z.boolean().default(true),
});
export type SuggestedAction = z.infer<typeof SuggestedActionSchema>;

/**
 * The structured answer.
 *
 * `answer` may be a truthful inability to answer — that is a valid outcome, not a failure. What is
 * not valid is an answer that sounds confident because the uncertainty was omitted.
 */
export const AnswerSchema = z
  .object({
    answer: z.string().min(1).max(8000),
    language: z.enum(LANGUAGES),
    citations: z.array(CitationSchema).max(50).default([]),
    confidence: z.number().min(0).max(1),
    uncertainties: z.array(z.string().max(300)).max(20).default([]),
    missingInformation: z.array(z.string().max(300)).max(20).default([]),
    suggestedActions: z.array(SuggestedActionSchema).max(10).default([]),
    requiredApproval: z.string().max(200).nullable().default(null),
    escalation: z.string().max(200).nullable().default(null),
    refusalReason: z.string().max(200).nullable().default(null),
    staleEvidence: z.boolean().default(false),
  })
  // Unknown keys are refused rather than dropped. A field this system does not understand may be
  // an instruction, a tool call, or a claim about an action — and silently discarding it would
  // hide exactly the output worth noticing.
  .strict();

export type Answer = z.infer<typeof AnswerSchema>;

/** Why an answer was refused. Codes, so they can be audited without storing the content. */
export type RejectionCode =
  | "malformed_output"
  | "unknown_language"
  | "unauthorised_citation"
  | "unknown_action"
  | "execution_attempt"
  | "unsupported_claim";

export class AnswerRejected extends Error {
  constructor(readonly code: RejectionCode, message: string) {
    super(message);
    this.name = "AnswerRejected";
  }
}

/**
 * Phrases that assert an ACTION HAS BEEN TAKEN.
 *
 * Ask-AI cannot assign, approve, send, pay or complete anything, so an answer claiming it did is
 * either a hallucination or an injected instruction that succeeded. Either way the person reading
 * it would believe their work was done. That is the single most damaging thing this contract can
 * prevent, so it is checked on the text rather than trusted to the prompt.
 */
const EXECUTION_CLAIMS: readonly RegExp[] = [
  /\bI have (assigned|approved|sent|paid|transferred|completed|resolved|granted|delegated)\b/i,
  /\bI(?:'ve| have) gone ahead and\b/i,
  /\b(has|have) been (assigned|approved|sent|paid|transferred|marked complete|resolved|granted) by me\b/i,
  /\bI just (assigned|approved|sent|paid|completed|resolved)\b/i,
  /\bdone[.!]? I (assigned|approved|sent|paid)\b/i,
];

export interface ValidationContext {
  /** Records the REQUESTER may actually access, as `table:id`. Built before the model ran. */
  authorisedRefs: ReadonlySet<string>;
  /** The language the answer was asked for. */
  requestedLanguage: Language;
}

export const refKey = (table: string, id: string) => `${table}:${id}`;

/**
 * Validate a provider response into an answer, or refuse it.
 *
 * Order matters: shape first (an unparseable object cannot be reasoned about), then the claims
 * that would mislead, then the references that would leak.
 */
export function validateAnswer(raw: unknown, ctx: ValidationContext): Answer {
  const parsed = AnswerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AnswerRejected(
      "malformed_output",
      `the model's response did not match the answer contract: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
        .join("; ")}`,
    );
  }
  const answer = parsed.data;

  // The language was chosen by this system, not by the model. A response in another language is
  // not a preference — it is the model overriding an authorisation-adjacent decision.
  if (answer.language !== ctx.requestedLanguage) {
    throw new AnswerRejected(
      "unknown_language",
      `answer language ${answer.language} is not the requested ${ctx.requestedLanguage}`,
    );
  }

  for (const pattern of EXECUTION_CLAIMS) {
    if (pattern.test(answer.answer)) {
      throw new AnswerRejected(
        "execution_attempt",
        "the answer claims an action was carried out; Ask-AI explains and recommends, it never acts",
      );
    }
  }

  // A citation the requester cannot open is either invented or a leak. Both are refusals, and
  // deliberately the SAME refusal: distinguishing them in the message would itself disclose
  // whether the record exists.
  for (const c of answer.citations) {
    if (!ctx.authorisedRefs.has(refKey(c.sourceTable, c.sourceId))) {
      throw new AnswerRejected(
        "unauthorised_citation",
        `the answer cites ${c.sourceTable} which is not among the evidence this person may see`,
      );
    }
  }

  // Only the catalogue may name an executable action. A model-invented id must never reach the
  // approval path, where it would arrive looking like a registered one.
  for (const a of answer.suggestedActions) {
    if (!actionById(a.actionId)) {
      throw new AnswerRejected(
        "unknown_action",
        `suggested action "${a.actionId}" is not registered in the action catalogue`,
      );
    }
  }

  // A confident factual answer with no evidence behind it is the shape of a plausible invention.
  // A refusal, or an answer that says what is missing, is allowed to have none.
  const saysSomethingIsMissing =
    answer.missingInformation.length > 0 || answer.uncertainties.length > 0;
  if (
    answer.citations.length === 0 &&
    answer.refusalReason === null &&
    !saysSomethingIsMissing &&
    answer.confidence > 0.5
  ) {
    throw new AnswerRejected(
      "unsupported_claim",
      "a confident operational answer must cite authorised evidence, or say what it is missing",
    );
  }

  return answer;
}
