/**
 * Posting templates (Architecture V2 change plan §8.3). Pure: turn an operational
 * document (customer invoice, supplier bill) into balanced draft journal lines that
 * the atomic RPC then posts. Decimal money via the draft-line strings (Constitution
 * §8). Finance chooses the accounts; these helpers only build the balanced pair.
 */
import type { DraftLine } from "./manual-entry";

/** A single balanced Dr/Cr pair for `amount`. */
export function balancedPair(debitCode: string, creditCode: string, amount: string, memo?: string): DraftLine[] {
  const m = memo ?? null;
  return [
    { account_code: debitCode, debit: amount, credit: "", description: m },
    { account_code: creditCode, debit: "", credit: amount, description: m },
  ];
}

/** Customer invoice: Dr Receivables, Cr Income. */
export function invoicePostingLines(receivableCode: string, incomeCode: string, total: string, memo?: string): DraftLine[] {
  return balancedPair(receivableCode, incomeCode, total, memo);
}

/** Supplier bill: Dr Expense, Cr Payables. */
export function billPostingLines(expenseCode: string, payableCode: string, total: string, memo?: string): DraftLine[] {
  return balancedPair(expenseCode, payableCode, total, memo);
}
