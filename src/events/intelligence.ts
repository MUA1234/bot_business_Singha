/**
 * Financial Event Intelligence — missing-information detection, clarification
 * generation, and the recommended next action. Guide §7 (missing_fields), §8
 * (focused clarification questions, "don't ask for fields already known").
 *
 * Pure functions over a *validated* AiExtraction. They never post; they decide
 * what the pipeline should do next and what to ask the human.
 */
import type { AiExtraction, AiEventType } from "@/schemas/ai-extraction";

/** Fields the backend requires before an event of each type can be posted. */
const REQUIRED_BY_TYPE: Record<AiEventType, string[]> = {
  expense_payment: ["company", "amount", "currency", "purpose", "payment_method"],
  expense_claim: ["company", "amount", "currency", "purpose", "paid_by_employee"],
  supplier_bill: ["company", "amount", "currency", "counterparty", "transaction_date"],
  customer_invoice: ["company", "amount", "currency", "counterparty", "transaction_date"],
  customer_receipt: ["company", "amount", "currency", "counterparty", "payment_method"],
  supplier_payment: ["company", "amount", "currency", "counterparty", "payment_method"],
  employee_advance: ["company", "amount", "currency", "paid_by_employee"],
  advance_settlement: ["company", "amount", "currency", "paid_by_employee"],
  reimbursement: ["company", "amount", "currency", "paid_by_employee"],
  refund: ["company", "amount", "currency", "counterparty"],
  credit_note: ["company", "amount", "currency", "counterparty"],
  bank_transfer: ["company", "amount", "currency"],
  unknown: ["company", "amount", "currency", "purpose"],
};

/** Known context we already have — never ask for these (guide §8). */
export interface KnownContext {
  companyKnown: boolean;
  employeeKnown: boolean; // authenticated user is the payer
  projectKnown: boolean;
}

/**
 * Compute the set of still-missing required fields, subtracting anything we
 * already know from the authenticated user / conversation / project assignment.
 */
export function detectMissingFields(x: AiExtraction, known: KnownContext): string[] {
  const required = REQUIRED_BY_TYPE[x.event_type] ?? REQUIRED_BY_TYPE.unknown;
  const missing = new Set<string>();

  for (const field of required) {
    switch (field) {
      case "company":
        if (!x.company_candidate_id && !known.companyKnown) missing.add("company");
        break;
      case "amount":
        if (!x.amount) missing.add("amount");
        break;
      case "currency":
        if (!x.currency) missing.add("currency");
        break;
      case "purpose":
        if (!x.purpose) missing.add("purpose");
        break;
      case "payment_method":
        if (x.payment_method === "unknown") missing.add("payment_method");
        break;
      case "counterparty":
        if (!x.counterparty_name && !x.counterparty_candidate_id) missing.add("counterparty");
        break;
      case "transaction_date":
        if (!x.transaction_date) missing.add("transaction_date");
        break;
      case "paid_by_employee":
        if (!x.paid_by_employee_id && !known.employeeKnown) missing.add("paid_by_employee");
        break;
    }
  }

  // Evidence is generally required for a real posting; surface it as "receipt".
  if (x.evidence_document_ids.length === 0) missing.add("receipt");

  return [...missing];
}

const QUESTION_FOR_FIELD: Record<string, string> = {
  company: "Which company is this for?",
  amount: "What was the exact amount?",
  currency: "Which currency?",
  purpose: "What was it for?",
  payment_method: "Was it paid from company cash, a company bank account, or your own money?",
  counterparty: "Who was it paid to / received from?",
  transaction_date: "What date did this happen?",
  paid_by_employee: "Who paid for this?",
  project: "Which project was it for?",
  receipt: "Please attach the receipt or payment proof.",
};

/**
 * Build a single focused clarification message. Guide §8 example format. Leads
 * with what we DID understand so the human can confirm quickly, then asks only
 * for the missing pieces.
 */
export function buildClarificationMessage(x: AiExtraction, missing: string[]): string {
  const parts: string[] = [];
  const summaryBits: string[] = [];
  if (x.amount && x.currency) summaryBits.push(`${x.currency} ${x.amount}`);
  if (x.purpose) summaryBits.push(`for ${x.purpose}`);
  if (x.counterparty_name) summaryBits.push(`(${x.counterparty_name})`);
  if (summaryBits.length) {
    parts.push(`I found a possible ${prettyType(x.event_type)} of ${summaryBits.join(" ")}.`);
  } else {
    parts.push(`I found a possible ${prettyType(x.event_type)}, but I need more detail.`);
  }
  const questions = missing.map((f) => QUESTION_FOR_FIELD[f] ?? `Please provide: ${f}.`);
  if (questions.length) parts.push(questions.join(" "));
  return parts.join(" ");
}

function prettyType(t: AiEventType): string {
  return t.replace(/_/g, " ");
}

export type PipelineAction =
  | "request_clarification"
  | "request_evidence"
  | "flag_duplicate"
  | "create_draft_awaiting_approval"
  | "flag_for_review";

/**
 * Deterministic recommendation — the backend's own decision, NOT the AI's
 * `recommended_action` (which is advisory). Low confidence or missing required
 * fields force a clarification/evidence path before anything can be approved.
 */
export function derivePipelineAction(
  x: AiExtraction,
  missing: string[],
  opts: { minConfidence?: number; possibleDuplicate?: boolean } = {},
): PipelineAction {
  const minConfidence = opts.minConfidence ?? 0.75;
  if (opts.possibleDuplicate || x.risk_flags.includes("possible_duplicate")) return "flag_duplicate";
  if (x.risk_flags.includes("prompt_injection_detected")) return "flag_for_review";
  const onlyReceiptMissing = missing.length === 1 && missing[0] === "receipt";
  if (missing.length > 0 && !onlyReceiptMissing) return "request_clarification";
  if (onlyReceiptMissing) return "request_evidence";
  if (x.confidence.overall < minConfidence) return "flag_for_review";
  return "create_draft_awaiting_approval";
}
