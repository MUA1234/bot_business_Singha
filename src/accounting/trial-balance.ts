/**
 * Trial balance + statement roll-ups derived from posted journals. Guide §15:
 * the system must produce a trial balance, P&L and balance sheet that reconcile
 * to the ledger. This is the pure derivation used by both the reports and the
 * golden-dataset CI test.
 */
import { Money, sumMoney } from "@/lib/money";
import type { AccountType } from "@/domain/accounts";
import { isBalanceSheet } from "@/domain/accounts";
import type { PostedJournal } from "./journal";

export interface TrialBalanceRow {
  account_code: string;
  account_type: AccountType;
  debit: string;
  credit: string;
}

export interface TrialBalance {
  currency: string;
  rows: TrialBalanceRow[];
  total_debit: string;
  total_credit: string;
  balanced: boolean;
}

/**
 * Compute a trial balance across posted journals for a single company + currency.
 * Each account nets its debits/credits and is shown on whichever side its net
 * balance falls.
 */
export function trialBalance(journals: readonly PostedJournal[], currency: string): TrialBalance {
  const netByAccount = new Map<string, { type: AccountType; net: Money }>();

  for (const j of journals) {
    if (j.currency !== currency) continue;
    for (const line of j.lines) {
      const current = netByAccount.get(line.account_code)?.net ?? Money.zero(currency);
      const delta = Money.of(line.debit, currency).minus(Money.of(line.credit, currency));
      netByAccount.set(line.account_code, {
        type: line.account_type,
        net: current.plus(delta), // debit-positive
      });
    }
  }

  const rows: TrialBalanceRow[] = [];
  const debits: Money[] = [];
  const credits: Money[] = [];
  for (const [code, { type, net }] of [...netByAccount.entries()].sort()) {
    const rounded = net.round();
    if (rounded.isZero()) continue;
    if (rounded.isPositive()) {
      rows.push({ account_code: code, account_type: type, debit: rounded.toString(), credit: "0" });
      debits.push(rounded);
    } else {
      const credit = Money.zero(currency).minus(rounded);
      rows.push({ account_code: code, account_type: type, debit: "0", credit: credit.toString() });
      credits.push(credit);
    }
  }

  const totalDebit = debits.length ? sumMoney(debits) : Money.zero(currency);
  const totalCredit = credits.length ? sumMoney(credits) : Money.zero(currency);

  return {
    currency,
    rows,
    total_debit: totalDebit.toString(),
    total_credit: totalCredit.toString(),
    balanced: totalDebit.equals(totalCredit),
  };
}

export interface ProfitAndLoss {
  currency: string;
  income: string;
  expense: string;
  net_profit: string;
}

/** P&L from a trial balance: income (credit-normal) less expense (debit-normal). */
export function profitAndLoss(tb: TrialBalance): ProfitAndLoss {
  const currency = tb.currency;
  let income = Money.zero(currency);
  let expense = Money.zero(currency);
  for (const row of tb.rows) {
    if (row.account_type === "income") {
      income = income.plus(Money.of(row.credit, currency)).minus(Money.of(row.debit, currency));
    } else if (row.account_type === "expense") {
      expense = expense.plus(Money.of(row.debit, currency)).minus(Money.of(row.credit, currency));
    }
  }
  return {
    currency,
    income: income.toString(),
    expense: expense.toString(),
    net_profit: income.minus(expense).toString(),
  };
}

export interface BalanceSheet {
  currency: string;
  assets: string;
  liabilities: string;
  equity: string;
  /** equity + retained profit; balances when assets == liabilities + equity_total. */
  balances: boolean;
}

/**
 * Balance sheet with the period's net profit rolled into equity (retained
 * earnings), which is what makes A = L + E hold before a formal year-end close.
 */
export function balanceSheet(tb: TrialBalance): BalanceSheet {
  const currency = tb.currency;
  let assets = Money.zero(currency);
  let liabilities = Money.zero(currency);
  let equity = Money.zero(currency);
  for (const row of tb.rows) {
    if (!isBalanceSheet(row.account_type)) continue;
    const debit = Money.of(row.debit, currency);
    const credit = Money.of(row.credit, currency);
    if (row.account_type === "asset") assets = assets.plus(debit).minus(credit);
    else if (row.account_type === "liability") liabilities = liabilities.plus(credit).minus(debit);
    else equity = equity.plus(credit).minus(debit);
  }
  const pnl = profitAndLoss(tb);
  const equityWithProfit = equity.plus(Money.of(pnl.net_profit, currency));
  return {
    currency,
    assets: assets.toString(),
    liabilities: liabilities.toString(),
    equity: equityWithProfit.toString(),
    balances: assets.equals(liabilities.plus(equityWithProfit)),
  };
}
