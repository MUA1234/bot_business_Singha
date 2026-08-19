import { describe, it, expect } from "vitest";
import { AiGateway, type CompletionResponse, type CompletionTransport, type CostLedger, type AiRunRecord } from "@/ai/gateway";
import { approvalPolicy, type ApprovalPolicy } from "@/schemas/approval-policy";
import { assertTransition, type FinancialEventState } from "@/domain/lifecycle";
import {
  processSourceEvent,
  RetryableExtractionError,
  type ConsumerDeps,
  type LoadedSourceEvent,
} from "@/inngest/processing";
import type { DuplicateCandidateInput } from "@/events/duplicate";

const COMPANY = "11111111-1111-1111-1111-111111111111";

/** A full, valid AiExtraction JSON string, with per-test overrides. */
function extractionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: "1.0",
    event_type: "expense_payment",
    company_candidate_id: COMPANY,
    division_candidate_id: null,
    project_candidate_id: null,
    site_candidate_id: null,
    transaction_date: "2026-07-15",
    amount: "14500.00",
    currency: "LKR",
    counterparty_name: "Lanka Filling Station",
    counterparty_candidate_id: null,
    purpose: "fuel for the site pickup",
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
    ...overrides,
  });
}

/** Transport that returns a fixed body. */
function fakeTransport(body: string): CompletionTransport {
  return {
    async complete(): Promise<CompletionResponse> {
      return { text: body, usage: { input_tokens: 100, output_tokens: 50 }, cost_usd: "0.000045" };
    },
  };
}

/** Transport that throws, to simulate a provider outage. */
function throwingTransport(): CompletionTransport {
  return {
    async complete(): Promise<CompletionResponse> {
      throw new Error("ECONNRESET");
    },
  };
}

interface Harness {
  deps: ConsumerDeps;
  audits: { action: string }[];
  drafts: { extraction: unknown; missing_fields: string[] }[];
  approvals: { approvals_required: number; submitted_by: string | null }[];
  reviews: { matches: number; version: string }[];
  clarifications: { missing_fields: string[]; message: string }[];
  dupes: { matches: { matched_event_id: string }[] }[];
  policyEvals: { outcome: string }[];
  ledger: { runs: AiRunRecord[] };
  states: Map<string, FinancialEventState>;
}

function makeHarness(opts: {
  transport: CompletionTransport;
  companyId?: string | null;
  policy?: ApprovalPolicy | null;
  recent?: { id: string; candidate: DuplicateCandidateInput }[];
  content?: string;
}): Harness {
  const audits: { action: string }[] = [];
  const drafts: { extraction: unknown; missing_fields: string[] }[] = [];
  const approvals: { approvals_required: number; submitted_by: string | null }[] = [];
  const reviews: { matches: number; version: string }[] = [];
  const clarifications: { missing_fields: string[]; message: string }[] = [];
  const dupes: { matches: { matched_event_id: string }[] }[] = [];
  const policyEvals: { outcome: string }[] = [];
  const states = new Map<string, FinancialEventState>();
  const ledger: CostLedger & { runs: AiRunRecord[] } = {
    runs: [],
    record(r) {
      this.runs.push(r);
    },
  };
  const companyId = opts.companyId === undefined ? COMPANY : opts.companyId;
  let seq = 0;

  const deps: ConsumerDeps = {
    gateway: new AiGateway(opts.transport, ledger),
    async loadSourceEvent(id): Promise<LoadedSourceEvent> {
      return { id, company_id: companyId, correlation_id: "corr_1", content: opts.content ?? "I paid 14500 for fuel" };
    },
    async loadCompanyContext() {
      return {
        policy: opts.policy ?? null,
        known: { companyKnown: !!companyId, employeeKnown: true, projectKnown: false },
        submitterUserId: "user_submitter",
      };
    },
    async recentEventsForDedup() {
      return opts.recent ?? [];
    },
    async createDraft(d) {
      const id = `fe_${++seq}`;
      states.set(id, "detected");
      drafts.push({ extraction: d.extraction, missing_fields: d.missing_fields });
      return { financial_event_id: id };
    },
    async transitionState(id, from, to) {
      const cur = states.get(id);
      if (cur !== from) throw new Error(`state mismatch: ${cur} != ${from}`);
      const chk = assertTransition(from, to);
      if (!chk.ok) throw new Error(chk.error.code);
      states.set(id, to);
    },
    async recordPolicyEvaluation(_id, _co, decision) {
      policyEvals.push({ outcome: decision.outcome });
    },
    async createApprovalRequest(i) {
      approvals.push({ approvals_required: i.approvals_required, submitted_by: i.submitted_by });
      return { approval_request_id: `ar_${++seq}` };
    },
    async createClarification(i) {
      clarifications.push({ missing_fields: i.missing_fields, message: i.message });
    },
    async openDuplicateReview(i) {
      reviews.push({ matches: i.matches.length, version: i.algorithm_version });
    },
    async createDuplicateCandidates(i) {
      dupes.push({ matches: i.matches });
    },
    async appendAudit(a) {
      audits.push({ action: a.action });
    },
  };
  return { deps, audits, drafts, approvals, reviews, clarifications, dupes, policyEvals, ledger, states };
}

function policyWith(ruleOverrides: Record<string, unknown>): ApprovalPolicy {
  return approvalPolicy.parse({
    company_id: COMPANY,
    currency: "LKR",
    version: 1,
    rules: [
      {
        id: "r1",
        description: "test rule",
        priority: 1,
        event_types: ["expense_payment"],
        max_amount: "50000.00",
        require_evidence: true,
        ...ruleOverrides,
      },
    ],
  });
}

const RUN = { source_event_id: "se_1", correlation_id: "corr_1" };

describe("Consumer pipeline (guide: extract → detect → dedup → draft → policy → approve/clarify → audit)", () => {
  it("routes a complete, in-policy event to human approval and records a policy evaluation", async () => {
    const h = makeHarness({ transport: fakeTransport(extractionJson()), policy: policyWith({ auto_approve: false }) });
    const r = await processSourceEvent(RUN, h.deps);

    expect(r.outcome).toBe("awaiting_approval");
    expect(r.ai_ok).toBe(true);
    expect(h.approvals).toHaveLength(1);
    expect(h.policyEvals[0]!.outcome).toBe("require_approval");
    expect([...h.states.values()][0]).toBe("awaiting_approval");
    expect(h.approvals[0]!.submitted_by).toBe("user_submitter");
    // The AI run was cost-logged (guide §13).
    expect(h.ledger.runs).toHaveLength(1);
    expect(h.ledger.runs[0]!.validation_ok).toBe(true);
  });

  it("auto-approves a small, low-risk event when the policy allows it — but never posts", async () => {
    const h = makeHarness({ transport: fakeTransport(extractionJson()), policy: policyWith({ auto_approve: true }) });
    const r = await processSourceEvent(RUN, h.deps);

    expect(r.outcome).toBe("approved");
    expect(h.policyEvals[0]!.outcome).toBe("auto_approve");
    expect(h.approvals).toHaveLength(0);
    expect([...h.states.values()][0]).toBe("approved"); // approved ≠ posted
  });

  it("asks a focused clarification when a required field is missing", async () => {
    const h = makeHarness({
      transport: fakeTransport(extractionJson({ purpose: null })),
      policy: policyWith({ auto_approve: false }),
    });
    const r = await processSourceEvent(RUN, h.deps);

    expect(r.outcome).toBe("awaiting_information");
    expect(h.approvals).toHaveLength(0);
    expect(h.clarifications).toHaveLength(1);
    expect(h.clarifications[0]!.missing_fields).toContain("purpose");
  });

  it("requests evidence when only the receipt is missing", async () => {
    const h = makeHarness({
      transport: fakeTransport(extractionJson({ evidence_document_ids: [] })),
      policy: policyWith({ auto_approve: false }),
    });
    const r = await processSourceEvent(RUN, h.deps);

    expect(r.outcome).toBe("awaiting_evidence");
    expect(h.clarifications[0]!.missing_fields).toEqual(["receipt"]);
    expect([...h.states.values()][0]).toBe("awaiting_evidence");
  });

  it("SUSPECTS a duplicate — pauses reversibly for a person, never auto-merges and never terminally discards", async () => {
    const recent = [
      {
        id: "fe_prior",
        candidate: {
          company_id: COMPANY,
          amount: "14500.00",
          currency: "LKR",
          transaction_date: "2026-07-15",
          counterparty_name: "Lanka Filling Station",
        },
      },
    ];
    const h = makeHarness({ transport: fakeTransport(extractionJson()), policy: policyWith({ auto_approve: true }), recent });
    const r = await processSourceEvent(RUN, h.deps);

    // A SCORE may ask a person to look; it may not discard a payment. `duplicate` is terminal with
    // no transition out, so writing it from a heuristic silently lost a second genuine payment.
    expect(r.outcome).toBe("awaiting_information");
    expect([...h.states.values()][0]).toBe("awaiting_information");
    expect(h.dupes[0]!.matches[0]!.matched_event_id).toBe("fe_prior");
    expect(h.approvals).toHaveLength(0);                 // no approval while it is unresolved
    // …and a reviewable record exists, stamped with the rule version that produced it.
    expect(h.reviews).toHaveLength(1);
    expect(h.reviews[0]!.matches).toBe(1);
    expect(h.reviews[0]!.version).toBe("dup/v2-evidence-required");
    expect(h.audits.map((a) => a.action)).toContain("duplicate_suspected");
  });

  it("routes a prompt-injection-flagged event to human review", async () => {
    const h = makeHarness({
      transport: fakeTransport(extractionJson({ risk_flags: ["prompt_injection_detected"] })),
      policy: policyWith({ auto_approve: true }),
    });
    const r = await processSourceEvent(RUN, h.deps);

    expect(r.outcome).toBe("awaiting_information");
    expect(h.approvals).toHaveLength(0);
    expect(h.audits.some((a) => a.action === "flag_for_review")).toBe(true);
  });

  it("fails safe to human approval when no policy is configured (never auto-approves)", async () => {
    const h = makeHarness({ transport: fakeTransport(extractionJson()), policy: null });
    const r = await processSourceEvent(RUN, h.deps);

    expect(r.outcome).toBe("awaiting_approval");
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]!.approvals_required).toBe(1);
    expect(h.policyEvals).toHaveLength(0); // no policy to evaluate
  });

  it("creates a review draft (ai_ok=false) when the model output fails schema validation", async () => {
    const h = makeHarness({ transport: fakeTransport("{}"), policy: policyWith({ auto_approve: false }) });
    const r = await processSourceEvent(RUN, h.deps);

    expect(r.ai_ok).toBe(false);
    expect(r.outcome).toBe("awaiting_information");
    expect(h.drafts[0]!.extraction).toBeNull();
    expect([...h.states.values()][0]).toBe("awaiting_information");
  });

  it("throws a retryable error on a transport outage so the job is retried, not lost", async () => {
    const h = makeHarness({
      transport: throwingTransport(),
      policy: policyWith({ auto_approve: false }),
    });
    await expect(processSourceEvent(RUN, h.deps)).rejects.toBeInstanceOf(RetryableExtractionError);
    // Nothing downstream was created — the event stays for a clean retry.
    expect(h.drafts).toHaveLength(0);
    expect(h.approvals).toHaveLength(0);
  });
});
