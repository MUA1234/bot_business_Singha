/**
 * Bank reconciliation matcher (Architecture V2 change plan §8.3). Pure and
 * deterministic: suggests which payment/receipt clears each unmatched bank
 * transaction, by equal amount (decimal, Constitution §8) and nearest date within a
 * window. It only SUGGESTS — a human confirms a match; nothing posts here.
 */
import { Money } from "@/lib/money";

export interface BankTxn {
  id: string;
  date: string; // ISO date
  amount: string; // decimal string (sign indicates in/out)
  currency: string;
  description?: string | null;
}

export interface ReconCandidate {
  id: string;
  kind: "payment" | "receipt";
  date: string;
  amount: string;
  currency: string;
}

export interface ReconSuggestion {
  bankTxnId: string;
  candidateId: string | null;
  candidateKind: "payment" | "receipt" | null;
  confidence: "high" | "medium" | "none";
  reason: string;
}

const DAY = 86_400_000;
/** Absolute canonical amount, e.g. "-1500.00" → "1500.00". */
const absStr = (amount: string, currency: string) => Money.of(amount, currency).toString().replace(/^-/, "");

export function suggestMatches(
  txns: BankTxn[],
  candidates: ReconCandidate[],
  dayWindow = 5,
): ReconSuggestion[] {
  const used = new Set<string>();

  return txns.map((txn): ReconSuggestion => {
    const txnAbs = absStr(txn.amount, txn.currency);
    const txnTime = new Date(txn.date).getTime();

    // Same currency + equal absolute amount + not already used, nearest date.
    const matches = candidates
      .filter((c) => !used.has(c.id) && c.currency === txn.currency && absStr(c.amount, c.currency) === txnAbs)
      .map((c) => ({ c, days: Math.abs((new Date(c.date).getTime() - txnTime) / DAY) }))
      .filter((m) => Number.isFinite(m.days) && m.days <= dayWindow)
      .sort((a, b) => a.days - b.days);

    const best = matches[0];
    if (!best) {
      return { bankTxnId: txn.id, candidateId: null, candidateKind: null, confidence: "none", reason: "no candidate with equal amount in window" };
    }
    used.add(best.c.id);
    const confidence = best.days <= 1 ? "high" : "medium";
    return {
      bankTxnId: txn.id,
      candidateId: best.c.id,
      candidateKind: best.c.kind,
      confidence,
      reason: `${best.c.kind} of equal amount, ${Math.round(best.days)}d apart`,
    };
  });
}
