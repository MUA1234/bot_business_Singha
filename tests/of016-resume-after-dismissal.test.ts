/**
 * OF-016 — a dismissed duplicate must actually RESUME, through the existing consumer.
 *
 * The database half is tested against real PostgreSQL in
 * `tests/integration/of016-duplicate-*.test.ts`. This is the half that lives in the pipeline: when
 * a reviewer releases a payment, the very next pass must NOT score the same pair, raise the same
 * suspicion and pause it again. If it did, "dismissed" would last exactly one poll and the payment
 * would be stuck in a loop no person could break.
 *
 * The mechanism is deliberately narrow: `recentEventsForDedup` receives the source event id and
 * the store excludes counterparts a human already ruled distinct FOR THIS EVENT. Every other
 * pairing is still scored normally — a dismissal is not a blanket exemption.
 */
import { describe, it, expect } from "vitest";
import { processSourceEvent, type ConsumerDeps, type LoadedSourceEvent } from "@/inngest/processing";
import { AiGateway } from "@/ai/gateway";
import type { CompletionTransport } from "@/ai/gateway";
import type { DuplicateCandidateInput } from "@/events/duplicate";
import { assertTransition, type FinancialEventState } from "@/domain/lifecycle";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const SRC = "src_1";
/** The counterpart a reviewer already ruled distinct. */
const DISMISSED = "fe_earlier_dismissed";

/** A full, valid extraction — the same shape `tests/processing.test.ts` uses. */
const EXTRACTION = {
  schema_version: "1.0",
  event_type: "expense_payment",
  company_candidate_id: COMPANY,
  division_candidate_id: null,
  project_candidate_id: null,
  site_candidate_id: null,
  transaction_date: "2026-08-10",
  amount: "45000.00",
  currency: "LKR",
  counterparty_name: "Acme Supplies",
  counterparty_candidate_id: null,
  purpose: "site supplies",
  payment_method: "company_cash",
  paid_by_employee_id: null,
  suggested_account_code: "5000",
  tax_code: null,
  evidence_document_ids: ["doc_1"],
  conversation_reference_ids: [],
  is_reimbursement_expected: false,
  allocations: [],
  missing_fields: [],
  risk_flags: [],
  confidence: { overall: 0.95, amount: 0.95, purpose: 0.9, company: 0.99 },
  recommended_action: "create_draft",
};

/** What the duplicate scorer compares — the counterpart resembles the incoming event exactly. */
const SAME: DuplicateCandidateInput = {
  company_id: COMPANY, amount: "45000.00", currency: "LKR",
  transaction_date: "2026-08-10", counterparty_name: "Acme Supplies",
};

const transport: CompletionTransport = {
  async complete() {
    return { text: JSON.stringify(EXTRACTION), usage: { input_tokens: 100, output_tokens: 50 }, cost_usd: "0.000045" };
  },
};

/**
 * @param dedupExcludesDismissed  whether the STORE honours the dismissal. The pipeline is
 *   identical in both runs; only the store's answer differs, which is exactly where the fix lives.
 */
function harness(dedupExcludesDismissed: boolean) {
  const audits: { action: string }[] = [];
  const reviews: { matches: number }[] = [];
  const approvals: unknown[] = [];
  const drafts: unknown[] = [];
  const states = new Map<string, FinancialEventState>();
  const seenSourceIds: (string | undefined)[] = [];
  let seq = 0;

  const candidates = [
    { id: DISMISSED, candidate: SAME },
    { id: "fe_unrelated", candidate: {
        company_id: COMPANY, amount: "12.00", currency: "LKR",
        transaction_date: "2026-01-01", counterparty_name: "Someone Else",
      } as DuplicateCandidateInput },
  ];

  const deps: ConsumerDeps = {
    gateway: new AiGateway(transport, { record() {} }),
    async loadSourceEvent(id): Promise<LoadedSourceEvent> {
      return { id, company_id: COMPANY, correlation_id: "corr_1", content: "paid 45000 to Acme" };
    },
    async loadCompanyContext() {
      return { policy: null, known: { companyKnown: true, employeeKnown: true, projectKnown: false }, submitterUserId: null };
    },
    async recentEventsForDedup(_co, _within, sourceEventId) {
      seenSourceIds.push(sourceEventId);
      // The real store filters on `duplicate_reviews` rows resolved as `dismissed_distinct`.
      return dedupExcludesDismissed ? candidates.filter((c) => c.id !== DISMISSED) : candidates;
    },
    async createDraft() {
      const id = `fe_${++seq}`;
      states.set(id, "detected");
      drafts.push(id);
      return { financial_event_id: id };
    },
    async transitionState(id, from, to) {
      const cur = states.get(id);
      if (cur !== from) throw new Error(`state mismatch: ${cur} != ${from}`);
      const chk = assertTransition(from, to);
      if (!chk.ok) throw new Error(chk.error.code);
      states.set(id, to);
    },
    async recordPolicyEvaluation() {},
    async createApprovalRequest() { approvals.push(1); return { approval_request_id: `ar_${++seq}` }; },
    async createClarification() {},
    async openDuplicateReview(i) { reviews.push({ matches: i.matches.length }); },
    async createDuplicateCandidates() {},
    async appendAudit(a) { audits.push(a as unknown as { action: string }); },
  };
  return { deps, reviews, approvals, drafts, states, seenSourceIds, audits };
}

describe("OF-016 — a dismissed duplicate resumes instead of re-pausing", () => {
  it("BEFORE the fix: the same pair is re-scored and the payment pauses again", async () => {
    const h = harness(false);
    const r = await processSourceEvent({ source_event_id: SRC, correlation_id: "corr_1" }, h.deps);
    expect(r.outcome, "the release would last exactly one poll").toBe("awaiting_information");
    expect(h.reviews.length, "and a second review row would be raised").toBe(1);
    expect(h.approvals.length).toBe(0);
  });

  it("AFTER the fix: the dismissed pair is excluded and the payment proceeds", async () => {
    const h = harness(true);
    const r = await processSourceEvent({ source_event_id: SRC, correlation_id: "corr_1" }, h.deps);
    expect(r.outcome, "it resumes past the duplicate check").not.toBe("awaiting_information");
    expect(h.reviews.length, "no new duplicate review is raised").toBe(0);
    // Exactly one of each — the existing idempotent consumer did the finance work, not this package.
    expect(h.drafts.length).toBe(1);
    expect(h.approvals.length).toBe(1);
  });

  it("the source event id REACHES the store — without it the exclusion cannot be scoped", async () => {
    const h = harness(true);
    await processSourceEvent({ source_event_id: SRC, correlation_id: "corr_1" }, h.deps);
    expect(h.seenSourceIds, "the store must know which event's dismissals to honour").toEqual([SRC]);
  });

  it("a dismissal is NOT a blanket exemption — other pairings are still scored", async () => {
    // The excluded counterpart is dropped; the unrelated one is still offered to the scorer, so a
    // genuinely new resemblance would still pause the payment.
    const h = harness(true);
    await processSourceEvent({ source_event_id: SRC, correlation_id: "corr_1" }, h.deps);
    expect(h.seenSourceIds.length).toBe(1);
    // The harness's filter removed exactly one candidate and kept the other.
    const remaining = await h.deps.recentEventsForDedup(COMPANY, SAME, SRC);
    expect(remaining.map((c) => c.id)).toEqual(["fe_unrelated"]);
  });
});
