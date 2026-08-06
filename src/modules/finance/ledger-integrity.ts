/**
 * Ledger integrity check (NEXT_PHASE_DEVELOPER_BRIEF §WP6.5 "accounting integrity
 * exceptions"). Pure and deterministic: every posted journal must have debits == credits.
 * The atomic posting RPC enforces this on write; this is a defence-in-depth read check
 * that surfaces any journal that is nonetheless unbalanced, so it raises an alert
 * instead of silently corrupting the accounts. Money is compared as decimals.
 */
import Decimal from "decimal.js";

export interface JournalLineLite {
  journal_id: string;
  debit: string | number | null;
  credit: string | number | null;
}

const dec = (v: string | number | null): Decimal => {
  try {
    return new Decimal(v ?? 0);
  } catch {
    return new Decimal(0);
  }
};

/** Journal ids whose lines do not balance (debits ≠ credits). */
export function findUnbalancedJournals(lines: JournalLineLite[]): string[] {
  const totals = new Map<string, { debit: Decimal; credit: Decimal }>();
  for (const l of lines) {
    const t = totals.get(l.journal_id) ?? { debit: new Decimal(0), credit: new Decimal(0) };
    t.debit = t.debit.plus(dec(l.debit));
    t.credit = t.credit.plus(dec(l.credit));
    totals.set(l.journal_id, t);
  }
  const unbalanced: string[] = [];
  for (const [journalId, t] of totals) {
    if (!t.debit.equals(t.credit)) unbalanced.push(journalId);
  }
  return unbalanced;
}
