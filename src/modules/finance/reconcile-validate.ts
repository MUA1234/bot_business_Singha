/**
 * Server-side reconciliation match validation (NEXT_PHASE_DEVELOPER_BRIEF §WP2.7).
 * Pure and deterministic. The browser proposes a match (target id/type/amount); the
 * server must independently validate the target record, company, direction, currency
 * and remaining amount before recording it — never trust the submitted values.
 *
 * Direction rule: a bank CREDIT (money in, amount ≥ 0) reconciles to a RECEIPT; a
 * bank DEBIT (money out, amount < 0) reconciles to a PAYMENT. Money is decimal.
 */
import Decimal from "decimal.js";

export type ReconTargetType = "payment" | "receipt" | "journal_line";

export interface ReconInput {
  callerCompanyId: string;
  bankTxn: { companyId: string; currency: string; amount: string }; // signed decimal
  target: {
    type: ReconTargetType;
    companyId: string;
    currency?: string; // known for payment/receipt
    amount?: string; // target's own amount (positive)
    direction?: "in" | "out";
  };
  matchAmount: string; // proposed match amount (positive decimal)
}

export interface ReconResult {
  ok: boolean;
  reason?: string;
}

const fail = (reason: string): ReconResult => ({ ok: false, reason });

export interface ReconOptions {
  /** Enforce credit↔receipt / debit↔payment. Requires a trusted signed bank amount. */
  checkDirection?: boolean;
}

export function validateReconciliation(i: ReconInput, opts: ReconOptions = {}): ReconResult {
  const checkDirection = opts.checkDirection !== false;
  // Company scope — both sides must belong to the acting company.
  if (i.bankTxn.companyId !== i.callerCompanyId) return fail("bank transaction not in company");
  if (i.target.companyId !== i.callerCompanyId) return fail("target not in company");

  // Amount must be positive and within both the bank transaction and the target.
  let m: Decimal, bank: Decimal;
  try {
    m = new Decimal(i.matchAmount);
    bank = new Decimal(i.bankTxn.amount);
  } catch {
    return fail("invalid amount");
  }
  if (m.lte(0)) return fail("match amount must be positive");
  if (m.gt(bank.abs())) return fail("match amount exceeds the bank transaction amount");
  if (i.target.amount !== undefined) {
    const tgt = new Decimal(i.target.amount);
    if (m.gt(tgt.abs())) return fail("match amount exceeds the target's remaining amount");
  }

  // Currency must match when the target's currency is known.
  if (i.target.currency !== undefined && i.target.currency !== i.bankTxn.currency) {
    return fail(`currency mismatch: bank ${i.bankTxn.currency} vs target ${i.target.currency}`);
  }

  // Direction: credit (≥0) ↔ receipt/in ; debit (<0) ↔ payment/out.
  if (checkDirection) {
    const bankIsCredit = bank.gte(0);
    const expected: "in" | "out" | null =
      i.target.type === "receipt" ? "in" : i.target.type === "payment" ? "out" : i.target.direction ?? null;
    if (expected === "in" && !bankIsCredit) return fail("a receipt must reconcile to a credit (money in)");
    if (expected === "out" && bankIsCredit) return fail("a payment must reconcile to a debit (money out)");
  }

  return { ok: true };
}
