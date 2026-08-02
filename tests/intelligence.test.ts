import { describe, it, expect } from "vitest";
import type { AiExtraction } from "@/schemas/ai-extraction";
import {
  detectMissingFields,
  buildClarificationMessage,
  derivePipelineAction,
} from "@/events/intelligence";
import { scoreDuplicate, counterpartySimilarity } from "@/events/duplicate";

const extraction = (o: Partial<AiExtraction> = {}): AiExtraction => ({
  schema_version: "1.0",
  event_type: "expense_payment",
  company_candidate_id: null,
  division_candidate_id: null,
  project_candidate_id: null,
  site_candidate_id: null,
  transaction_date: "2026-07-29",
  amount: "14500.00",
  currency: "LKR",
  counterparty_name: "Electrician",
  counterparty_candidate_id: null,
  purpose: "Fuel for electrician",
  payment_method: "unknown",
  paid_by_employee_id: null,
  suggested_account_code: null,
  tax_code: null,
  evidence_document_ids: [],
  conversation_reference_ids: [],
  is_reimbursement_expected: null,
  allocations: [],
  missing_fields: [],
  risk_flags: [],
  confidence: { overall: 0.62 },
  recommended_action: "request_clarification",
  ...o,
});

describe("Missing-information detection (guide §8)", () => {
  it("finds missing company, payment method and receipt", () => {
    const missing = detectMissingFields(extraction(), {
      companyKnown: false,
      employeeKnown: true,
      projectKnown: false,
    });
    expect(missing).toContain("company");
    expect(missing).toContain("payment_method");
    expect(missing).toContain("receipt");
  });

  it("does NOT ask for fields already known from context", () => {
    const missing = detectMissingFields(
      extraction({ payment_method: "company_cash", evidence_document_ids: ["doc1"] }),
      { companyKnown: true, employeeKnown: true, projectKnown: true },
    );
    expect(missing).not.toContain("company");
    expect(missing).not.toContain("payment_method");
    expect(missing).not.toContain("receipt");
  });

  it("builds a focused clarification message like the §8 example", () => {
    const missing = detectMissingFields(extraction(), {
      companyKnown: false,
      employeeKnown: true,
      projectKnown: false,
    });
    const msg = buildClarificationMessage(extraction(), missing);
    expect(msg).toMatch(/LKR 14500\.00/);
    expect(msg).toMatch(/company cash/i);
    expect(msg).toMatch(/receipt/i);
  });
});

describe("Deterministic pipeline action (backend decides, not the AI)", () => {
  it("requests clarification when required fields are missing", () => {
    const x = extraction();
    const missing = detectMissingFields(x, { companyKnown: false, employeeKnown: true, projectKnown: false });
    expect(derivePipelineAction(x, missing)).toBe("request_clarification");
  });

  it("requests evidence when only the receipt is missing", () => {
    const x = extraction({ company_candidate_id: "c1", payment_method: "company_cash", confidence: { overall: 0.9 } });
    const missing = detectMissingFields(x, { companyKnown: true, employeeKnown: true, projectKnown: true });
    expect(missing).toEqual(["receipt"]);
    expect(derivePipelineAction(x, missing)).toBe("request_evidence");
  });

  it("creates a draft for a complete, confident event", () => {
    const x = extraction({
      company_candidate_id: "c1",
      payment_method: "company_cash",
      evidence_document_ids: ["doc1"],
      confidence: { overall: 0.95 },
    });
    const missing = detectMissingFields(x, { companyKnown: true, employeeKnown: true, projectKnown: true });
    expect(derivePipelineAction(x, missing)).toBe("create_draft_awaiting_approval");
  });

  it("flags a possible duplicate ahead of anything else", () => {
    const x = extraction({ risk_flags: ["possible_duplicate"] });
    expect(derivePipelineAction(x, [], { possibleDuplicate: true })).toBe("flag_duplicate");
  });

  it("sends a prompt-injection to human review", () => {
    const x = extraction({ risk_flags: ["prompt_injection_detected"] });
    expect(derivePipelineAction(x, [])).toBe("flag_for_review");
  });
});

describe("Duplicate detection (guide §14)", () => {
  it("flags same company + amount + close date + similar payee", () => {
    const s = scoreDuplicate(
      { company_id: "c1", amount: "14500.00", currency: "LKR", transaction_date: "2026-07-29", counterparty_name: "Electrician fuel" },
      { company_id: "c1", amount: "14500.00", currency: "LKR", transaction_date: "2026-07-30", counterparty_name: "Electrician" },
    );
    expect(s.isLikelyDuplicate).toBe(true);
  });

  it("does not flag across companies", () => {
    const s = scoreDuplicate(
      { company_id: "c1", amount: "14500.00", currency: "LKR", transaction_date: "2026-07-29", counterparty_name: "X" },
      { company_id: "c2", amount: "14500.00", currency: "LKR", transaction_date: "2026-07-29", counterparty_name: "X" },
    );
    expect(s.isLikelyDuplicate).toBe(false);
  });

  it("scores counterparty similarity", () => {
    expect(counterpartySimilarity("ABC Traders", "ABC Traders")).toBe(1);
    expect(counterpartySimilarity("ABC Traders", "XYZ Corp")).toBe(0);
  });
});
