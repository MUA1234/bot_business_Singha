/**
 * AI extraction contract. Guide §7. This is the ONLY shape the AI gateway is
 * allowed to return for a financial-event extraction. `schema_version` is pinned;
 * an unknown version is rejected by the gateway (guide §7 "reject invalid schema
 * versions").
 *
 * Nothing here touches business state. The output is advisory; the backend
 * re-validates every id against real rows and re-derives risk before anything
 * is posted (guide §1, §7 backend rejection list).
 */
import { z } from "zod";
import {
  confidence01,
  currencyCode,
  decimalString,
  isoDate,
  nullableUuid,
} from "./common";

export const AI_EXTRACTION_SCHEMA_VERSION = "1.0" as const;

export const eventType = z.enum([
  "expense_payment",
  "expense_claim",
  "supplier_bill",
  "customer_invoice",
  "customer_receipt",
  "supplier_payment",
  "employee_advance",
  "advance_settlement",
  "reimbursement",
  "refund",
  "credit_note",
  "bank_transfer",
  "unknown",
]);
export type AiEventType = z.infer<typeof eventType>;

export const paymentMethod = z.enum([
  "company_cash",
  "company_bank",
  "employee_own_money",
  "supplier_credit",
  "card",
  "cheque",
  "unknown",
]);

/** What the AI recommends the human/pipeline do next. Advisory only. */
export const recommendedAction = z.enum([
  "create_draft",
  "request_clarification",
  "request_evidence",
  "flag_duplicate",
  "flag_for_review",
  "ignore",
]);

/** A single dimensional allocation line (split allocations supported — guide §5). */
export const allocation = z.object({
  amount: decimalString,
  project_candidate_id: nullableUuid,
  division_candidate_id: nullableUuid,
  site_candidate_id: nullableUuid,
  cost_centre_candidate_id: nullableUuid,
  account_code: z.string().nullable(),
  note: z.string().max(500).nullable().default(null),
});

export const confidenceBlock = z
  .object({ overall: confidence01 })
  .catchall(confidence01); // per-field confidences (amount, purpose, company, …)

export const riskFlag = z.enum([
  "large_amount",
  "unusual",
  "foreign_currency",
  "tax_related",
  "related_party",
  "multi_company",
  "possible_duplicate",
  "prompt_injection_detected",
  "missing_evidence",
  "low_confidence",
]);

/**
 * The canonical AI extraction object. Additional keys are stripped (`.strict()`
 * would reject; we prefer strip so a slightly chatty model still validates, but
 * unknown ENUM values inside known fields still fail — guide §7).
 */
export const aiExtraction = z
  .object({
    schema_version: z.literal(AI_EXTRACTION_SCHEMA_VERSION),
    event_type: eventType,
    company_candidate_id: nullableUuid,
    division_candidate_id: nullableUuid,
    project_candidate_id: nullableUuid,
    site_candidate_id: nullableUuid,
    transaction_date: isoDate.nullable(),
    amount: decimalString.nullable(),
    currency: currencyCode.nullable(),
    counterparty_name: z.string().max(300).nullable(),
    counterparty_candidate_id: nullableUuid.default(null),
    purpose: z.string().max(1000).nullable(),
    payment_method: paymentMethod,
    paid_by_employee_id: nullableUuid,
    suggested_account_code: z.string().nullable(),
    tax_code: z.string().nullable(),
    evidence_document_ids: z.array(z.string()).default([]),
    conversation_reference_ids: z.array(z.string()).default([]),
    is_reimbursement_expected: z.boolean().nullable(),
    allocations: z.array(allocation).default([]),
    missing_fields: z.array(z.string()).default([]),
    risk_flags: z.array(riskFlag).default([]),
    confidence: confidenceBlock,
    recommended_action: recommendedAction,
  })
  .strip();

export type AiExtraction = z.infer<typeof aiExtraction>;

/**
 * Parse untrusted AI output. Returns a discriminated result so the gateway can
 * record a validation failure rather than throwing into business logic.
 */
export function parseAiExtraction(raw: unknown):
  | { ok: true; value: AiExtraction }
  | { ok: false; issues: z.ZodIssue[] } {
  const parsed = aiExtraction.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: parsed.error.issues };
}
