/**
 * Manual journal draft validation (Architecture V2 change plan §8.2). Pure: checks a
 * set of draft lines before they are posted by the atomic RPC — at least two lines,
 * non-negative single-sided amounts, and debit == credit. Decimal money throughout
 * (Constitution §8). The RPC re-validates authoritatively; this gives instant UX.
 */
import { Money, sumMoney } from "@/lib/money";

export interface DraftLine {
  account_code: string;
  debit: string; // decimal string ("" treated as 0)
  credit: string;
  description?: string | null;
}

export interface DraftCheck {
  balanced: boolean;
  ready: boolean; // balanced, ≥2 lines, non-zero, no issues
  totalDebit: string;
  totalCredit: string;
  issues: string[];
}

const dec = (v: string) => (/^\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : "0");

export function checkDraftJournal(lines: DraftLine[], currency: string): DraftCheck {
  const issues: string[] = [];
  const priced = lines.filter((l) => l.account_code.trim() !== "" && (Number(dec(l.debit)) > 0 || Number(dec(l.credit)) > 0));

  if (priced.length < 2) issues.push("A journal needs at least two lines with amounts.");

  const debits: Money[] = [];
  const credits: Money[] = [];
  for (const l of priced) {
    const d = Money.of(dec(l.debit), currency);
    const c = Money.of(dec(l.credit), currency);
    if (!d.isZero() && !c.isZero()) issues.push(`Line "${l.account_code}" has both a debit and a credit.`);
    debits.push(d);
    credits.push(c);
  }

  const totalDebit = debits.length ? sumMoney(debits).round() : Money.zero(currency);
  const totalCredit = credits.length ? sumMoney(credits).round() : Money.zero(currency);
  const balanced = totalDebit.equals(totalCredit);
  if (!balanced) issues.push(`Unbalanced: debit ${totalDebit.toString()} ≠ credit ${totalCredit.toString()}.`);
  if (totalDebit.isZero()) issues.push("Journal total is zero.");

  return {
    balanced,
    ready: issues.length === 0,
    totalDebit: totalDebit.toString(),
    totalCredit: totalCredit.toString(),
    issues,
  };
}
