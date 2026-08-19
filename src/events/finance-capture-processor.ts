/**
 * The production consumer for a captured finance event (remediation R1 §4, OF-002).
 *
 * WHY IT EXISTS. `/api/cron/inbound-sweeper` returned `no_processor` for everything, so a captured
 * finance message was released back to the queue every cycle and never processed. The pipeline it
 * needed already existed and was already wired to Inngest (`processSourceEvent`): extraction →
 * missing-field detection → duplicate candidates → a DETERMINISTIC action → a drafted financial
 * event with an immutable snapshot → policy evaluation → approval request → audit. This connects
 * the sweeper to THAT pipeline rather than growing a second one beside it.
 *
 * WHAT THIS MODULE ADDS, and why each guard is here rather than downstream:
 *
 *   * COMPANY SCOPE. A capture with no company cannot be processed at all. Migration 0077 makes
 *     such a row impossible to create, and this refuses one anyway — duplicate scoring, policy and
 *     approval all key on the company, and a null one silently disables every one of them.
 *   * NO PROVIDER, NO PRETENDING. Extraction needs a model provider the owner has not configured.
 *     Rather than throwing in a retry loop or inventing a result, the message becomes an ACTIONABLE
 *     REVIEW ITEM and the receipt stays outstanding. Nothing is reported as processed.
 *   * A TRANSPORT failure is transient and retried; a CONTRACT failure is a real outcome the
 *     pipeline already turns into a review draft.
 *
 * What it deliberately does NOT do: choose a company, an authority level, a ledger account, or a
 * permission to pay. Those are the pipeline's deterministic decisions, and none of them is taken
 * from model output.
 */
import { RetryableExtractionError, type ProcessResult } from "@/inngest/processing";
import type { ProcessOutcome, SweepableEvent } from "@/events/inbound-sweeper";
import { log } from "@/lib/log";

export interface FinanceCaptureDeps {
  /** True when a model provider is configured. Checked, never assumed. */
  extractionConfigured(): boolean;
  /** The EXISTING pipeline. Not re-implemented here. */
  process(input: { source_event_id: string; correlation_id: string }): Promise<ProcessResult>;
  /** Company scope for a receipt, read from the row rather than from anything a model said. */
  companyOf(sourceEventId: string): Promise<string | null>;
  /** Put an actionable item in front of a person. Idempotent per message. */
  queueForReview(input: {
    sourceEventId: string;
    companyId: string;
    reasonCode: string;
    reasonDetail: string;
  }): Promise<void>;
}

/** The reason code a person sees when a capture is waiting on configuration rather than on work. */
export const AWAITING_CLASSIFIER = "finance_capture_awaiting_classifier";

export function makeFinanceCaptureProcessor(deps: FinanceCaptureDeps) {
  return async function processFinanceCapture(event: SweepableEvent): Promise<ProcessOutcome> {
    // ── company scope ─────────────────────────────────────────────────────────────────────────
    const companyId = await deps.companyOf(event.id);
    if (!companyId) {
      // Not retryable and not releasable: a capture without a company is a corrupt row, and every
      // control downstream (duplicates, policy, approval) is company-scoped.
      return {
        ok: false,
        code: "capture_without_company",
        message: `source event ${event.id} is a finance capture with no company scope`,
        retryable: false,
      };
    }

    // ── provider ──────────────────────────────────────────────────────────────────────────────
    if (!deps.extractionConfigured()) {
      // Truthful and actionable: a person gets a queue item naming what is missing, and the receipt
      // stays outstanding rather than being marked processed.
      await deps.queueForReview({
        sourceEventId: event.id,
        companyId,
        reasonCode: AWAITING_CLASSIFIER,
        reasonDetail:
          "A staff finance message was captured, but no model provider is configured to extract it. " +
          "It is waiting for configuration, not for work.",
      });
      return {
        ok: false,
        code: "extraction_not_configured",
        message: "no model provider is configured for finance extraction",
        unprocessable: true, // released, uncharged — see inbound-sweeper
      };
    }

    // ── the existing pipeline ─────────────────────────────────────────────────────────────────
    try {
      const result = await deps.process({
        source_event_id: event.id,
        correlation_id: `sweep_${event.id}`,
      });
      log("info", "finance capture processed", {
        event: "finance.capture_processed",
        sourceEventId: event.id,
        companyId,
        outcome: result.outcome,
        financialEventId: result.financial_event_id,
      });
      // Every pipeline outcome — approved, awaiting approval, awaiting information, duplicate,
      // rejected — is a REAL outcome with a durable record and an audit trail. The receipt is done;
      // what happens next belongs to the financial event, not to the ingestion.
      return { ok: true };
    } catch (e) {
      if (e instanceof RetryableExtractionError) {
        return { ok: false, code: "extraction_transport", message: e.message, retryable: true };
      }
      // Anything else is retried under the sweeper's bounded budget rather than being swallowed.
      return { ok: false, code: "processor_error", message: (e as Error).message, retryable: true };
    }
  };
}
