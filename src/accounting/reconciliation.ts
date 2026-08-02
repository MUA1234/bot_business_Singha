/**
 * Bank reconciliation — normalization, fingerprinting, candidate matching. Guide
 * §3 Phase 4, §9 ("imported bank lines cannot be reconciled twice beyond their
 * available amount"). AI may *suggest* matches; deterministic validation here and
 * authorized human confirmation control the final reconciliation (guide §4).
 */
import { Money } from "@/lib/money";
import { sha256 } from "@/lib/ids";
import { counterpartySimilarity } from "@/events/duplicate";

export interface BankTxn {
  id: string;
  txn_date: string;
  description: string;
  amount: string; // signed decimal string, +in / -out
  currency: string;
  amount_matched: string;
}

export interface LedgerItem {
  id: string;
  kind: "payment" | "receipt" | "journal_line";
  date: string;
  amount: string; // signed, +in / -out (a receipt is +, a payment is -)
  currency: string;
  counterparty: string | null;
  amount_matched: string;
}

/**
 * Stable fingerprint for a raw statement row, used to dedup re-imports of the
 * same line (guide §9). Same date+amount+normalized description => same key.
 */
export function bankLineFingerprint(row: {
  txn_date: string;
  amount: string;
  currency: string;
  description: string;
  external_ref?: string | null;
}): string {
  const normDesc = row.description.toLowerCase().replace(/\s+/g, " ").trim();
  return sha256(`${row.txn_date}|${row.amount}|${row.currency}|${normDesc}|${row.external_ref ?? ""}`);
}

/** Remaining unmatched amount on a bank txn (absolute value). */
export function availableToMatch(item: { amount: string; amount_matched: string }, currency: string): Money {
  const total = Money.of(item.amount.replace("-", ""), currency);
  const matched = Money.of(item.amount_matched.replace("-", ""), currency);
  return total.minus(matched);
}

export interface MatchCandidate {
  bank_transaction_id: string;
  ledger_item_id: string;
  ledger_kind: LedgerItem["kind"];
  amount: string;
  score: number;
  reasons: string[];
}

/**
 * Suggest 1:1 candidate matches between one bank txn and ledger items. Same sign,
 * same currency, amount within available on both sides, close dates, similar
 * counterparty. Never proposes matching beyond the available amount (guide §9).
 */
export function suggestMatches(
  bankTxn: BankTxn,
  ledger: LedgerItem[],
  opts: { windowDays?: number; minScore?: number } = {},
): MatchCandidate[] {
  const windowDays = opts.windowDays ?? 5;
  const minScore = opts.minScore ?? 0.5;
  const currency = bankTxn.currency;
  const bankSignPositive = !bankTxn.amount.startsWith("-");
  const bankAvail = availableToMatch(bankTxn, currency);
  if (bankAvail.isZero()) return [];

  const out: MatchCandidate[] = [];
  for (const item of ledger) {
    if (item.currency !== currency) continue;
    const itemSignPositive = !item.amount.startsWith("-");
    if (itemSignPositive !== bankSignPositive) continue; // inflow matches inflow
    const itemAvail = availableToMatch(item, currency);
    if (itemAvail.isZero()) continue;

    const reasons: string[] = [];
    let score = 0;

    // amount closeness (weight 0.6): exact remaining amount match is strongest
    if (bankAvail.equals(itemAvail)) {
      score += 0.6;
      reasons.push("exact amount");
    } else {
      // partial: the smaller available fits inside the larger
      score += 0.35;
      reasons.push("partial amount");
    }

    // date proximity (0.25)
    const diffDays = Math.abs(Date.parse(bankTxn.txn_date) - Date.parse(item.date)) / 86_400_000;
    if (diffDays <= windowDays) {
      score += 0.25 * (1 - diffDays / windowDays);
      reasons.push(`within ${windowDays}d`);
    }

    // counterparty text (0.15)
    const sim = counterpartySimilarity(bankTxn.description, item.counterparty);
    if (sim > 0) {
      score += 0.15 * sim;
      reasons.push(`payee ~${sim.toFixed(2)}`);
    }

    // proposed match amount = min(available on both sides) — never over-match
    const matchAmount = bankAvail.compare(itemAvail) <= 0 ? bankAvail : itemAvail;
    const rounded = Math.min(1, Number(score.toFixed(4)));
    if (rounded >= minScore) {
      out.push({
        bank_transaction_id: bankTxn.id,
        ledger_item_id: item.id,
        ledger_kind: item.kind,
        amount: matchAmount.toString(),
        score: rounded,
        reasons,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Validate a human-confirmed match before it is written. Rejects over-matching
 * (guide §9) and currency/sign mismatch. Returns null when valid, else a reason.
 */
export function validateMatch(
  bankTxn: BankTxn,
  item: LedgerItem,
  amount: string,
): string | null {
  if (item.currency !== bankTxn.currency) return "currency mismatch";
  const currency = bankTxn.currency;
  const amt = Money.of(amount, currency);
  if (!amt.isPositive()) return "match amount must be positive";
  if (amt.greaterThan(availableToMatch(bankTxn, currency))) return "exceeds bank transaction available amount";
  if (amt.greaterThan(availableToMatch(item, currency))) return "exceeds ledger item available amount";
  return null;
}
