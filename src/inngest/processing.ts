/**
 * Consumer pipeline — the "further development" past the webhook boundary, now wired.
 *
 * This is PURE ORCHESTRATION over ports (no DB, no network, no Inngest imports) so it
 * is fully unit-testable offline, exactly like `src/events/source-event.ts`. The
 * Inngest function (`functions.ts`) supplies the live ports; tests supply fakes.
 *
 * The pipeline is the guide's mandated order (core principle: schema validation →
 * deterministic authority rules → permission check → audit log):
 *   1. load the stored source event (persist-before-process already happened upstream)
 *   2. AI extraction via the gateway (untrusted-fenced, Zod-validated, cost-logged)
 *   3. detect still-missing required fields (never re-asking known context)
 *   4. soft duplicate detection against recent events (never auto-merges)
 *   5. create a draft financial_event + immutable v1 snapshot
 *   6. derive the deterministic pipeline action (backend decides, NOT the AI)
 *   7. evaluate the company approval policy (only for the approval path)
 *   8. route: clarification / evidence / duplicate / review / approval / auto-approve
 *   9. append an audit event at every material step
 *
 * It NEVER posts a journal and NEVER executes a payment (financial controls): the
 * most it does on the happy path is move an event to `approved` (posting is a later,
 * separately-gated step). Auto-approval is granted only when the deterministic policy
 * engine says so — AI free text can never reach that decision.
 */
import type { AiExtraction } from "@/schemas/ai-extraction";
import type { ApprovalPolicy } from "@/schemas/approval-policy";
import type { AiGateway } from "@/ai/gateway";
import {
  buildClarificationMessage,
  derivePipelineAction,
  detectMissingFields,
  type KnownContext,
  type PipelineAction,
} from "@/events/intelligence";
import { scoreDuplicate, DUPLICATE_ALGORITHM_VERSION, type DuplicateCandidateInput } from "@/events/duplicate";
import { evaluatePolicy, toEvaluatable, type PolicyDecision } from "@/policy/authority";
import { assertTransition, type FinancialEventState } from "@/domain/lifecycle";

/** A source event loaded from storage, reduced to what the pipeline needs. */
export interface LoadedSourceEvent {
  id: string;
  company_id: string | null;
  correlation_id: string;
  /** Untrusted external text (WhatsApp body / email / OCR) to extract from. */
  content: string;
  /** Trusted, already-known context passed to the model as hints (never as truth). */
  trustedContext?: Record<string, unknown>;
}

/** Company context needed to decide + scope. Resolved from trusted rows, never AI. */
export interface CompanyContext {
  policy: ApprovalPolicy | null;
  known: KnownContext;
  /** The user this submission is attributed to (webhook sender → employee/user). */
  /** The PERSON who submitted, or null when the pipeline itself did (OF-013 / migration 0081). */
  submitterUserId: string | null;
}

export interface DraftInput {
  source_event_id: string;
  company_id: string | null;
  correlation_id: string;
  extraction: AiExtraction | null; // null when extraction failed validation
  missing_fields: string[];
  recommended_action: PipelineAction;
}

export interface AuditInput {
  company_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  correlation_id: string;
  source_event_id: string;
  payload?: Record<string, unknown>;
}

/** Everything the pipeline needs from the outside world. Implemented by the DB layer. */
export interface ConsumerDeps {
  gateway: AiGateway;
  loadSourceEvent(sourceEventId: string): Promise<LoadedSourceEvent>;
  loadCompanyContext(companyId: string | null): Promise<CompanyContext>;
  /** Recent events in the same company for soft-duplicate scoring. */
  recentEventsForDedup(
    companyId: string,
    within: DuplicateCandidateInput,
  ): Promise<{ id: string; candidate: DuplicateCandidateInput }[]>;
  /**
   * Draft the event, or return the one this source event already has.
   *
   * `resumedFromState` is set ONLY when an existing event was returned, and carries its current
   * state. The pipeline has two callers and both retry, so a second execution must resume from
   * where the first stopped rather than replay the state machine from `detected`.
   */
  createDraft(draft: DraftInput): Promise<{ financial_event_id: string; resumedFromState?: string }>;
  transitionState(
    financialEventId: string,
    from: FinancialEventState,
    to: FinancialEventState,
    reason: string,
  ): Promise<void>;
  recordPolicyEvaluation(
    financialEventId: string,
    companyId: string | null,
    decision: PolicyDecision,
  ): Promise<void>;
  createApprovalRequest(input: {
    financial_event_id: string;
    company_id: string;
    approvals_required: number;
    submitted_by: string | null;
  }): Promise<{ approval_request_id: string }>;
  createClarification(input: {
    financial_event_id: string;
    company_id: string | null;
    missing_fields: string[];
    message: string;
  }): Promise<void>;
  createDuplicateCandidates(input: {
    financial_event_id: string;
    company_id: string;
    matches: { matched_event_id: string; score: number; reasons: string[] }[];
  }): Promise<void>;
  /**
   * Open a REVIEWABLE duplicate suspicion for a person. Distinct from `createDuplicateCandidates`,
   * which is the raw scoring trace: this is the item someone opens and decides. Idempotent per
   * (event, matched event) so a resumed run does not stack reviews.
   */
  openDuplicateReview(input: {
    financial_event_id: string;
    company_id: string;
    matches: {
      matched_event_id: string;
      score: number;
      reasons: string[];
      contributions?: { amount: number; date: number; counterparty: number };
      evidence_present?: string[];
      evidence_missing?: string[];
    }[];
    algorithm_version: string;
  }): Promise<void>;
  appendAudit(input: AuditInput): Promise<void>;
}

/** Raised on a transport failure so Inngest retries (vs. a validation failure, which is terminal). */
export class RetryableExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableExtractionError";
  }
}

export type ProcessOutcome =
  | "awaiting_information"
  | "awaiting_evidence"
  | "duplicate"
  | "awaiting_approval"
  | "approved"
  | "rejected";

export interface ProcessResult {
  source_event_id: string;
  financial_event_id: string;
  outcome: ProcessOutcome;
  ai_ok: boolean;
}

/** Map the deterministic pipeline action to the target lifecycle state. */
function targetStateFor(action: PipelineAction): FinancialEventState {
  switch (action) {
    case "request_clarification":
      return "awaiting_information";
    case "request_evidence":
      return "awaiting_evidence";
    case "flag_duplicate":
      return "duplicate";
    case "flag_for_review":
      return "awaiting_information"; // a human must look before it can proceed
    case "create_draft_awaiting_approval":
      return "awaiting_approval"; // may be advanced again to `approved` by policy
  }
}

/**
 * Process one stored source event end-to-end. Idempotency is guaranteed upstream:
 * the Inngest function keys on the source_event_id so THAT caller runs this at most once per event.
 * The scheduled sweeper (R1 §4) is a SECOND caller and deliberately retries, so nothing here may
 * assume a single execution: `createDraft` is idempotent per source event and migration 0082 makes
 * a second drafted financial event impossible at the database.
 */
export async function processSourceEvent(
  input: { source_event_id: string; correlation_id: string },
  deps: ConsumerDeps,
): Promise<ProcessResult> {
  const src = await deps.loadSourceEvent(input.source_event_id);
  const ctx = await deps.loadCompanyContext(src.company_id);

  // ── Step 2: AI extraction (schema-validated, cost-logged inside the gateway) ──
  const extraction = await deps.gateway.runExtraction({
    content: src.content,
    trustedContext: src.trustedContext,
    correlationId: src.correlation_id,
  });

  await deps.appendAudit({
    company_id: src.company_id,
    action: extraction.ok ? "ai_extraction_ok" : `ai_extraction_${extraction.reason}`,
    entity_type: "source_event",
    entity_id: src.id,
    correlation_id: src.correlation_id,
    source_event_id: src.id,
    payload: { ai_run_id: extraction.run.ai_run_id, issues: extraction.ok ? undefined : extraction.issues },
  });

  // A transport error is transient — throw so Inngest retries (and dead-letters after
  // its configured retries). A *validation* failure is a real outcome: the model
  // answered but not in our contract, so we create a review draft and stop.
  if (!extraction.ok) {
    if (extraction.reason === "transport_error") {
      throw new RetryableExtractionError(
        `AI transport error for source_event ${src.id}: ${(extraction.issues ?? []).join("; ")}`,
      );
    }
    return await createReviewDraftForInvalidExtraction(src, deps);
  }

  const x = extraction.extraction;

  // ── Step 3: still-missing required fields (subtract known context) ──
  const missing = detectMissingFields(x, ctx.known);

  // ── Step 4: soft duplicate detection (raises a candidate; never auto-merges) ──
  const dupMatches = await findDuplicates(src.company_id, x, deps);
  const possibleDuplicate = dupMatches.length > 0;

  // ── Step 6: the deterministic action (backend's decision, not the AI's) ──
  const action = derivePipelineAction(x, missing, { possibleDuplicate });

  // ── Step 5: create the draft + immutable v1 snapshot ──
  const { financial_event_id, resumedFromState } = await deps.createDraft({
    source_event_id: src.id,
    company_id: src.company_id,
    correlation_id: src.correlation_id,
    extraction: x,
    missing_fields: missing,
    recommended_action: action,
  });

  // ── RESUME (S-01) ──────────────────────────────────────────────────────────────────────────
  // This source event already has a financial event, so a previous execution got at least this
  // far. Replaying the state machine from `detected` fails — the event has moved on — and treating
  // that failure as a processing error burned every retry and dead-lettered a captured payment.
  //
  // Resume from where it actually is. The one case that still needs WORK is an event parked in
  // `awaiting_approval` whose approval request never landed (a crash between the two): without it
  // the payment shows on no screen and can never be approved.
  if (resumedFromState && resumedFromState !== "draft") {
    if (resumedFromState === "awaiting_approval") {
      await deps.createApprovalRequest({
        financial_event_id,
        company_id: src.company_id ?? "",
        approvals_required: 1,
        submitted_by: ctx.submitterUserId,
      });
      await audit(deps, src, financial_event_id, "resumed_awaiting_approval", {});
      return result(src, financial_event_id, "awaiting_approval", true);
    }
    // Everything else is already a real outcome someone owns — a person, a policy, or a terminal
    // decision. Report it rather than redoing it.
    await audit(deps, src, financial_event_id, "resumed_no_further_work", { state: resumedFromState });
    return result(src, financial_event_id, outcomeForState(resumedFromState), true);
  }

  // Every event is drafted first (detected → draft) so it always has a versioned record.
  await deps.transitionState(financial_event_id, "detected", "draft", "extracted");
  await deps.appendAudit({
    company_id: src.company_id,
    action: "financial_event_drafted",
    entity_type: "financial_event",
    entity_id: financial_event_id,
    correlation_id: src.correlation_id,
    source_event_id: src.id,
    payload: { event_type: x.event_type, action, missing },
  });

  // ── Steps 7–9: route on the deterministic action ──
  const target = targetStateFor(action);

  if (action === "flag_duplicate") {
    // SUSPICION, NOT A VERDICT. A similarity score may ask a person to look; it may not discard a
    // payment. This used to write the TERMINAL `duplicate` state (no transition out), while
    // `duplicate_candidates` was read by no screen — so a second genuine payment to the same
    // supplier on the same day was silently and irreversibly lost.
    if (src.company_id && dupMatches.length) {
      await deps.createDuplicateCandidates({
        financial_event_id,
        company_id: src.company_id,
        matches: dupMatches,
      });
      // The reviewable record: the pair, the score, the per-feature contributions, what evidence
      // was present and what was missing, and the rule version that produced it.
      await deps.openDuplicateReview({
        financial_event_id,
        company_id: src.company_id,
        matches: dupMatches,
        algorithm_version: DUPLICATE_ALGORITHM_VERSION,
      });
    }
    // A REVERSIBLE pause. `awaiting_information` can go back to draft, on to approval, or to a
    // terminal state once a HUMAN decides — which is what "confirmed duplicate" now means.
    await deps.transitionState(financial_event_id, "draft", "awaiting_information", "possible duplicate — awaiting a person");
    await audit(deps, src, financial_event_id, "duplicate_suspected", { matches: dupMatches.length });
    return result(src, financial_event_id, "awaiting_information", true);
  }

  if (action === "request_clarification" || action === "flag_for_review") {
    await deps.transitionState(financial_event_id, "draft", target, action);
    await deps.createClarification({
      financial_event_id,
      company_id: src.company_id,
      missing_fields: missing,
      message: buildClarificationMessage(x, missing),
    });
    await audit(deps, src, financial_event_id, action, { missing });
    return result(src, financial_event_id, "awaiting_information", true);
  }

  if (action === "request_evidence") {
    await deps.transitionState(financial_event_id, "draft", "awaiting_evidence", "evidence required");
    await deps.createClarification({
      financial_event_id,
      company_id: src.company_id,
      missing_fields: ["receipt"],
      message: buildClarificationMessage(x, ["receipt"]),
    });
    await audit(deps, src, financial_event_id, "requested_evidence", {});
    return result(src, financial_event_id, "awaiting_evidence", true);
  }

  // action === "create_draft_awaiting_approval" — run the deterministic policy engine.
  await deps.transitionState(financial_event_id, "draft", "awaiting_approval", "ready for policy");

  if (!ctx.policy || !src.company_id) {
    // No company/policy resolved → fail-safe to human approval (never auto-approve).
    await deps.createApprovalRequest({
      financial_event_id,
      company_id: src.company_id ?? "",
      approvals_required: 1,
      submitted_by: ctx.submitterUserId,
    });
    await audit(deps, src, financial_event_id, "approval_required_no_policy", {});
    return result(src, financial_event_id, "awaiting_approval", true);
  }

  const evaluatable = toEvaluatable(x, x.evidence_document_ids.length > 0);
  const decision = evaluatePolicy(evaluatable, ctx.policy);
  await deps.recordPolicyEvaluation(financial_event_id, src.company_id, decision);

  if (decision.outcome === "reject") {
    await deps.transitionState(financial_event_id, "awaiting_approval", "rejected", "policy reject");
    await audit(deps, src, financial_event_id, "policy_rejected", { reasons: decision.reasons });
    return result(src, financial_event_id, "rejected", true);
  }

  if (decision.outcome === "auto_approve") {
    await deps.transitionState(financial_event_id, "awaiting_approval", "approved", "policy auto-approve");
    await audit(deps, src, financial_event_id, "policy_auto_approved", {
      matched_rule_id: decision.matched_rule_id,
    });
    // NOTE: approved ≠ posted. No journal is written here (financial controls); the
    // separately-gated posting step turns an approved draft into a balanced journal.
    return result(src, financial_event_id, "approved", true);
  }

  // require_approval → open an approval request for the required approvers.
  await deps.createApprovalRequest({
    financial_event_id,
    company_id: src.company_id,
    approvals_required: decision.approvals_required,
    submitted_by: ctx.submitterUserId,
  });
  await audit(deps, src, financial_event_id, "approval_requested", {
    roles: decision.required_approver_roles,
    approvals_required: decision.approvals_required,
  });
  return result(src, financial_event_id, "awaiting_approval", true);
}

/** One scored resemblance, with the evidence that produced it. */
export interface DuplicateMatch {
  matched_event_id: string;
  score: number;
  reasons: string[];
  contributions?: { amount: number; date: number; counterparty: number };
  evidence_present?: string[];
  evidence_missing?: string[];
}

async function findDuplicates(
  companyId: string | null,
  x: AiExtraction,
  deps: ConsumerDeps,
): Promise<DuplicateMatch[]> {
  if (!companyId) return [];
  const candidate: DuplicateCandidateInput = {
    company_id: companyId,
    amount: x.amount,
    currency: x.currency ?? "LKR",
    transaction_date: x.transaction_date,
    counterparty_name: x.counterparty_name,
  };
  const recent = await deps.recentEventsForDedup(companyId, candidate);
  const matches: DuplicateMatch[] = [];
  for (const r of recent) {
    const s = scoreDuplicate(candidate, r.candidate);
    if (s.isLikelyDuplicate) {
      // Carry the EVIDENCE, not just the number — a reviewer needs to see why, and a past decision
      // must be readable against the rule version that produced it.
      matches.push({
        matched_event_id: r.id,
        score: s.score,
        reasons: s.reasons,
        contributions: s.contributions,
        evidence_present: s.evidencePresent,
        evidence_missing: s.evidenceMissing,
      });
    }
  }
  return matches;
}

async function createReviewDraftForInvalidExtraction(
  src: LoadedSourceEvent,
  deps: ConsumerDeps,
): Promise<ProcessResult> {
  const { financial_event_id } = await deps.createDraft({
    source_event_id: src.id,
    company_id: src.company_id,
    correlation_id: src.correlation_id,
    extraction: null,
    missing_fields: ["all"],
    recommended_action: "flag_for_review",
  });
  await deps.transitionState(financial_event_id, "detected", "draft", "invalid extraction");
  await deps.transitionState(financial_event_id, "draft", "awaiting_information", "invalid extraction");
  await audit(deps, src, financial_event_id, "flagged_for_review_invalid_extraction", {});
  return result(src, financial_event_id, "awaiting_information", false);
}

function audit(
  deps: ConsumerDeps,
  src: LoadedSourceEvent,
  financialEventId: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<void> {
  return deps.appendAudit({
    company_id: src.company_id,
    action,
    entity_type: "financial_event",
    entity_id: financialEventId,
    correlation_id: src.correlation_id,
    source_event_id: src.id,
    payload,
  });
}

function result(
  src: LoadedSourceEvent,
  financialEventId: string,
  outcome: ProcessOutcome,
  aiOk: boolean,
): ProcessResult {
  return { source_event_id: src.id, financial_event_id: financialEventId, outcome, ai_ok: aiOk };
}

/**
 * Map a persisted financial-event state back to the pipeline's outcome vocabulary, for a resumed
 * run that has no work left to do.
 */
function outcomeForState(state: string): ProcessOutcome {
  switch (state) {
    case "awaiting_information": return "awaiting_information";
    case "awaiting_evidence": return "awaiting_evidence";
    case "awaiting_approval": return "awaiting_approval";
    case "approved": return "approved";
    case "rejected": return "rejected";
    case "duplicate": return "duplicate";
    // Anything further along (posted, reconciled, locked…) is finished as far as ingestion cares.
    default: return "approved";
  }
}

/** Re-export so the DB layer can validate transitions the same way the pipeline does. */
export { assertTransition };
