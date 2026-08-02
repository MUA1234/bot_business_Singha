import { describe, it, expect } from "vitest";
import { parseAiExtraction, AI_EXTRACTION_SCHEMA_VERSION } from "@/schemas/ai-extraction";

function base(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: AI_EXTRACTION_SCHEMA_VERSION,
    event_type: "expense_payment",
    company_candidate_id: null,
    division_candidate_id: null,
    project_candidate_id: null,
    site_candidate_id: null,
    transaction_date: "2026-07-29",
    amount: "14500.00",
    currency: "LKR",
    counterparty_name: "Electrician",
    purpose: "Fuel for electrician",
    payment_method: "unknown",
    paid_by_employee_id: null,
    suggested_account_code: null,
    tax_code: null,
    evidence_document_ids: [],
    conversation_reference_ids: [],
    is_reimbursement_expected: null,
    allocations: [],
    missing_fields: ["company", "project", "payment_method", "receipt"],
    risk_flags: [],
    confidence: { overall: 0.62, amount: 0.97, purpose: 0.91, company: 0.2 },
    recommended_action: "request_clarification",
    ...overrides,
  };
}

describe("AI extraction contract validation (guide §7)", () => {
  it("accepts the canonical §7 example", () => {
    const r = parseAiExtraction(base());
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown schema version", () => {
    const r = parseAiExtraction(base({ schema_version: "9.9" }));
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown enum value (event_type)", () => {
    const r = parseAiExtraction(base({ event_type: "wire_fraud" }));
    expect(r.ok).toBe(false);
  });

  it("rejects a numeric (float) amount — money must be a decimal string", () => {
    const r = parseAiExtraction(base({ amount: 14500.0 }));
    expect(r.ok).toBe(false);
  });

  it("rejects confidence outside [0,1]", () => {
    const r = parseAiExtraction(base({ confidence: { overall: 1.4 } }));
    expect(r.ok).toBe(false);
  });

  it("passes through a prompt-injection risk flag without executing it", () => {
    const r = parseAiExtraction(base({ risk_flags: ["prompt_injection_detected"] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.risk_flags).toContain("prompt_injection_detected");
  });

  it("strips unknown top-level keys rather than trusting them", () => {
    const r = parseAiExtraction(base({ execute_payment: true, admin: "grant" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as Record<string, unknown>).execute_payment).toBeUndefined();
  });
});
