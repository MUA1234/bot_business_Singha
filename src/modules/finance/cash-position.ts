/**
 * Cash position (Architecture V2 change plan §8.5). Pure and deterministic:
 * current balance per bank/cash account = opening balance + money in − money out.
 * All amounts are fixed-precision decimal strings via Money (Constitution §8).
 */
import { Money } from "@/lib/money";

export interface CashAccount {
  id: string;
  name: string;
  currency: string;
  openingBalance: string; // decimal string
}

export interface CashMovement {
  accountId: string;
  direction: "in" | "out";
  amount: string; // decimal string, > 0
}

export interface AccountBalance {
  id: string;
  name: string;
  currency: string;
  balance: string;
}

export interface CashPosition {
  accounts: AccountBalance[];
  totalsByCurrency: Record<string, string>;
}

export function computeCashPosition(accounts: CashAccount[], movements: CashMovement[]): CashPosition {
  const byAccount = new Map<string, Money>();
  const meta = new Map<string, CashAccount>();

  for (const a of accounts) {
    byAccount.set(a.id, Money.of(a.openingBalance || "0", a.currency));
    meta.set(a.id, a);
  }

  for (const m of movements) {
    const cur = byAccount.get(m.accountId);
    const a = meta.get(m.accountId);
    if (!cur || !a) continue; // movement for an unknown account is ignored
    const amt = Money.of(m.amount || "0", a.currency);
    byAccount.set(m.accountId, m.direction === "in" ? cur.plus(amt) : cur.minus(amt));
  }

  const balances: AccountBalance[] = [];
  const totals = new Map<string, Money>();
  for (const [id, bal] of byAccount) {
    const a = meta.get(id)!;
    balances.push({ id, name: a.name, currency: a.currency, balance: bal.toString() });
    const t = totals.get(a.currency);
    totals.set(a.currency, t ? t.plus(bal) : bal);
  }

  const totalsByCurrency: Record<string, string> = {};
  for (const [cur, m] of totals) totalsByCurrency[cur] = m.toString();

  return { accounts: balances, totalsByCurrency };
}
