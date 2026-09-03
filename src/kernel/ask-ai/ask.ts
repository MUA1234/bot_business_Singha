/**
 * R2D — the Ask-AI service.
 *
 * One path, in a fixed order that is itself the safety property:
 *
 *   1. classify the question   — before anything is written down
 *   2. resolve the language    — preference, override, or a truthful fallback
 *   3. retrieve authorised evidence — filtered by the REQUESTER, never by the model
 *   4. ask the provider        — with evidence fenced as data
 *   5. validate strictly       — refuse rather than repair
 *   6. persist what is allowed — and only in the modes that permit it
 *
 * Step 1 precedes step 6 for a reason that cannot be retrofitted: once a grievance is in an
 * operational history a manager may read, the disclosure has already happened.
 */
import { randomUUID } from "node:crypto";
import {
  validateAnswer, AnswerRejected, LANGUAGES,
  type Answer, type Language,
} from "./contract";
import {
  retrieveAuthorisedEvidence, untrustedEvidenceBlock,
  type Db, type EvidenceRecord,
} from "./retrieval";
import type { UserId, MembershipId, CompanyId } from "./identity";
import {
  classifySensitive, redirectionMessage, privacyNoticeMessage, PROTECTED_CHANNEL,
  type AskMode, type SensitiveCategory,
} from "./sensitive";

export interface AskInput {
  // Branded. Two uuids that address different things cannot be interchanged by accident:
  // the swap that produced an empty task list in this phase is now uncompilable.
  companyId: CompanyId;
  membershipId: MembershipId;
  /** The requester's user id — what task assignment is recorded against. */
  userId: UserId;
  capabilities: ReadonlySet<string>;
  question: string;
  /** Overrides the stored preference for THIS turn only. */
  language?: string;
  threadId?: string;
  context?: { table: string; id: string };
}

/** What the provider is asked, and what it returns. Injected, so no live model is reachable. */
export interface AskProvider {
  complete(input: {
    question: string;
    language: Language;
    evidence: string;
    catalogueActionIds: readonly string[];
  }): Promise<unknown>;
}

export interface AskDeps {
  db: Db;
  provider: AskProvider;
  /** The member's stored preference, if the (quarantined) language table is readable. */
  preferredLanguage?(companyId: CompanyId, membershipId: MembershipId): Promise<Language | null>;
  persist?(record: PersistedTurn): Promise<{ threadId: string }>;
  recordSafetyEvent?(e: SafetyEvent): Promise<void>;
  now?(): Date;
}

export interface PersistedTurn {
  companyId: CompanyId;
  membershipId: MembershipId;
  threadId?: string;
  language: Language;
  question: string;
  answer: Answer;
  correlationId: string;
}

export interface SafetyEvent {
  companyId: CompanyId;
  membershipId: MembershipId;
  category: SensitiveCategory;
  redirectedTo: string;
  correlationId: string;
}

export interface AskResult {
  mode: AskMode;
  answer: Answer;
  /** True when this turn was deliberately NOT written to reviewable history. */
  persisted: boolean;
  threadId?: string;
  /** Shown to the person: why their question was not kept, or where to take it. */
  notice?: string;
  correlationId: string;
  /** True when the preference could not be read and English was used instead. */
  languageFellBack: boolean;
}

const isLanguage = (v: unknown): v is Language =>
  typeof v === "string" && (LANGUAGES as readonly string[]).includes(v);

/**
 * Resolve the answer language.
 *
 * An explicit request wins; then the stored preference; then English. The fallback is REPORTED —
 * `languageFellBack` — because silently answering in English while claiming to honour a Sinhala
 * preference is the kind of small dishonesty that makes the rest untrustworthy.
 */
async function resolveLanguage(
  deps: AskDeps, input: AskInput,
): Promise<{ language: Language; fellBack: boolean }> {
  if (isLanguage(input.language)) return { language: input.language, fellBack: false };

  if (deps.preferredLanguage) {
    try {
      const stored = await deps.preferredLanguage(input.companyId, input.membershipId);
      if (isLanguage(stored)) return { language: stored, fellBack: false };
    } catch {
      // The language table is a quarantined draft; where it is absent, this is expected and must
      // not fail the whole request.
    }
  }
  return { language: "en", fellBack: true };
}

/** A refusal is a complete, valid answer — not an error. */
function refusal(language: Language, text: string, reason: string): Answer {
  return {
    answer: text,
    language,
    citations: [],
    confidence: 0,
    uncertainties: [],
    missingInformation: [],
    suggestedActions: [],
    requiredApproval: null,
    escalation: PROTECTED_CHANNEL,
    refusalReason: reason,
    staleEvidence: false,
  };
}

export async function ask(deps: AskDeps, input: AskInput): Promise<AskResult> {
  const correlationId = randomUUID();
  const { language, fellBack } = await resolveLanguage(deps, input);

  // ── 1. Sensitive topics, before anything is stored. ────────────────────────────────────
  const verdict = classifySensitive(input.question);

  if (verdict.mode === "sensitive") {
    // Only a coded event: the category and the fact of redirection. Never the question.
    await deps.recordSafetyEvent?.({
      companyId: input.companyId,
      membershipId: input.membershipId,
      category: verdict.category ?? "protected_hr",
      redirectedTo: PROTECTED_CHANNEL,
      correlationId,
    });
    return {
      mode: "sensitive",
      answer: refusal(language, redirectionMessage(language), "sensitive_topic_redirected"),
      persisted: false,
      notice: redirectionMessage(language),
      correlationId,
      languageFellBack: fellBack,
    };
  }

  // ── 2. Authorised evidence, gathered as the REQUESTER. ─────────────────────────────────
  const evidence = await retrieveAuthorisedEvidence(deps.db, {
    companyId: input.companyId,
    membershipId: input.membershipId,
    userId: input.userId,
    capabilities: input.capabilities,
    question: input.question,
    language,
    context: input.context,
  });

  // ── 3. Ask, then refuse or accept. ─────────────────────────────────────────────────────
  const { ACTION_CATALOGUE } = await import("../catalogue");
  let answer: Answer;
  try {
    const raw = await deps.provider.complete({
      question: input.question,
      language,
      evidence: untrustedEvidenceBlock(evidence.records),
      catalogueActionIds: ACTION_CATALOGUE.map((a) => a.id),
    });
    answer = validateAnswer(raw, {
      authorisedRefs: evidence.authorisedRefs,
      requestedLanguage: language,
    });
  } catch (e) {
    // A refused answer is reported as a refusal with its code — never as a plausible answer, and
    // never with the provider's raw text, which is precisely what failed validation.
    const code = e instanceof AnswerRejected ? e.code : "provider_unavailable";
    return {
      mode: verdict.mode,
      answer: refusal(
        language,
        "I could not produce an answer I can stand behind, so I am not going to guess.",
        code,
      ),
      persisted: false,
      correlationId,
      languageFellBack: fellBack,
    };
  }

  // Coverage the retrieval knew about, carried into the answer the person reads. The model is not
  // asked to be honest about this — it is asserted from what actually happened.
  if (evidence.staleEvidence) answer = { ...answer, staleEvidence: true };
  if (evidence.partialCoverage) {
    answer = {
      ...answer,
      missingInformation: [
        ...answer.missingInformation,
        `some sources could not be read this time: ${evidence.unavailableSources.join(", ")}`,
      ],
    };
  }

  // ── 4. Persist — but only where the mode allows it. ────────────────────────────────────
  //
  // An `unverified` turn is answered and deliberately not written to reviewable history: the
  // classifier cannot yet say, in this language, whether it was routine or protected.
  if (verdict.mode === "unverified") {
    return {
      mode: "unverified",
      answer,
      persisted: false,
      notice: privacyNoticeMessage(language),
      correlationId,
      languageFellBack: fellBack,
    };
  }

  let threadId: string | undefined;
  let persisted = false;
  if (deps.persist) {
    const stored = await deps.persist({
      companyId: input.companyId,
      membershipId: input.membershipId,
      threadId: input.threadId,
      language,
      question: input.question,
      answer,
      correlationId,
    });
    threadId = stored.threadId;
    persisted = true;
  }

  return { mode: "ordinary", answer, persisted, threadId, correlationId, languageFellBack: fellBack };
}

export type { EvidenceRecord };
