/**
 * FIN-006 — Budget versus actual.
 * Pure deterministic helper that pairs budget lines with journal activity in the
 * matching period/account/project. No float math; exact decimal `Money` only.
 */
import { Money, dec } from "@/lib/money";

export interface BudgetLineInput {
  id: string;
  account_code: string | null;
  project_id: string | null;
  period_id: string;
  amount: string | number;
}

export interface JournalLineInput {
  id: string;
  account_code: string;
  debit: string | number;
  credit: string | number;
  project_id: string | null;
  posting_date: string; // ISO date from journal_entries
}

export interface PeriodInput {
  id: string;
  start_date: string; // ISO date
  end_date: string;   // ISO date
}

export interface BudgetVsActualLine {
  budgetLineId: string;
  accountCode: string | null;
  projectId: string | null;
  periodId: string;
  budgeted: string;
  actual: string;
  variance: string;
  variancePercent: string | null;
}

export interface BudgetVsActualTotals {
  budgeted: string;
  actual: string;
  variance: string;
  variancePercent: string | null;
}

export interface BudgetVsActualResult {
  lines: BudgetVsActualLine[];
  byPeriod: Record<string, BudgetVsActualLine[]>;
  byProject: Record<string, BudgetVsActualLine[]>;
  byAccount: Record<string, BudgetVsActualLine[]>;
  totals: BudgetVsActualTotals;
}

function inPeriod(dateStr: string, start: string, end: string): boolean {
  return dateStr >= start && dateStr <= end;
}

function matchKey(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true; // null = wildcard
  return a === b;
}

function computeVariancePercent(budgeted: Money, variance: Money): string | null {
  if (budgeted.isZero()) return null;
  return variance.amount.dividedBy(budgeted.amount).times(100).toFixed(2);
}

function sumToMoney(values: Money[]): Money {
  if (values.length === 0) throw new Error("sumToMoney requires at least one value");
  return values.reduce((acc, v) => acc.plus(v));
}

/**
 * Compute budget vs actual for every budget line.
 *
 * Matching rules:
 * - A journal line contributes when its posting_date falls inside the budget line's period.
 * - account_code must match (a null budget account_code acts as a wildcard).
 * - project_id must match when both sides have one (a null budget project_id acts as a wildcard).
 * - actual = sum(debit) - sum(credit).
 * - variance = actual - budgeted.
 * - variancePercent = (variance / budgeted) * 100; null when budgeted is zero.
 */
export function computeBudgetVsActual(options: {
  budgetLines: BudgetLineInput[];
  journalLines: JournalLineInput[];
  periods: PeriodInput[];
  currency: string;
}): BudgetVsActualResult {
  const { budgetLines, journalLines, periods, currency } = options;
  const periodById = new Map(periods.map((p) => [p.id, p]));

  const lines: BudgetVsActualLine[] = budgetLines.map((bl) => {
    const period = periodById.get(bl.period_id);
    const budgeted = Money.of(String(bl.amount), currency);

    const actualDecimal = journalLines
      .filter((jl) => {
        if (!period) return false;
        if (!inPeriod(jl.posting_date, period.start_date, period.end_date)) return false;
        if (!matchKey(bl.account_code, jl.account_code)) return false;
        if (!matchKey(bl.project_id, jl.project_id)) return false;
        return true;
      })
      .reduce((acc, jl) => acc.plus(dec(jl.debit)).minus(dec(jl.credit)), dec(0));

    const actual = Money.of(actualDecimal, currency);
    const variance = actual.minus(budgeted);
    const variancePercent = computeVariancePercent(budgeted, variance);

    return {
      budgetLineId: bl.id,
      accountCode: bl.account_code,
      projectId: bl.project_id,
      periodId: bl.period_id,
      budgeted: budgeted.toString(),
      actual: actual.toString(),
      variance: variance.toString(),
      variancePercent,
    };
  });

  const byPeriod: Record<string, BudgetVsActualLine[]> = {};
  const byProject: Record<string, BudgetVsActualLine[]> = {};
  const byAccount: Record<string, BudgetVsActualLine[]> = {};

  for (const line of lines) {
    (byPeriod[line.periodId] ??= []).push(line);
    const projKey = line.projectId ?? "__none__";
    (byProject[projKey] ??= []).push(line);
    const acctKey = line.accountCode ?? "__none__";
    (byAccount[acctKey] ??= []).push(line);
  }

  const totals = computeTotals(lines, currency);

  return { lines, byPeriod, byProject, byAccount, totals };
}

function computeTotals(lines: BudgetVsActualLine[], currency: string): BudgetVsActualTotals {
  if (lines.length === 0) {
    const zero = Money.zero(currency).toString();
    return { budgeted: zero, actual: zero, variance: zero, variancePercent: null };
  }
  const budgeted = sumToMoney(lines.map((l) => Money.of(l.budgeted, currency)));
  const actual = sumToMoney(lines.map((l) => Money.of(l.actual, currency)));
  const variance = actual.minus(budgeted);
  const variancePercent = computeVariancePercent(budgeted, variance);
  return {
    budgeted: budgeted.toString(),
    actual: actual.toString(),
    variance: variance.toString(),
    variancePercent,
  };
}

/**
 * Aggregate actual activity by period/account/project without requiring a budget line.
 * Useful when you want to see actuals for dimensions that were not budgeted.
 */
export function aggregateActuals(options: {
  journalLines: JournalLineInput[];
  periods: PeriodInput[];
  currency: string;
  groupBy: ("period" | "account" | "project")[];
}): Array<{ keys: Record<string, string | null>; actual: string }> {
  const { journalLines, periods, currency, groupBy } = options;

  const buckets = new Map<string, { keys: Record<string, string | null>; amount: Money }>();

  for (const jl of journalLines) {
    const period = periods.find((p) => inPeriod(jl.posting_date, p.start_date, p.end_date));
    if (!period) continue;

    const keys: Record<string, string | null> = {};
    if (groupBy.includes("period")) keys.periodId = period.id;
    if (groupBy.includes("account")) keys.accountCode = jl.account_code;
    if (groupBy.includes("project")) keys.projectId = jl.project_id;

    const key = JSON.stringify(keys);
    const net = Money.of(dec(jl.debit).minus(dec(jl.credit)), currency);
    const existing = buckets.get(key);
    if (existing) {
      buckets.set(key, { keys, amount: existing.amount.plus(net) });
    } else {
      buckets.set(key, { keys, amount: net });
    }
  }

  return Array.from(buckets.values())
    .sort((a, b) => JSON.stringify(a.keys).localeCompare(JSON.stringify(b.keys)))
    .map((b) => ({ keys: b.keys, actual: b.amount.toString() }));
}
