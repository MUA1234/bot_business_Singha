/**
 * PRJ-003 — Project budget, forecast and resource requirements.
 *
 * Pure deterministic helper that computes a single project's budget versus actual
 * and a forecast curve by accounting period. Reuses FIN-006 exact-decimal logic.
 */
import { Money, sumMoney } from "@/lib/money";
import {
  computeBudgetVsActual,
  type BudgetLineInput,
  type JournalLineInput,
  type PeriodInput,
} from "@/modules/finance/budget-vs-actual";

export interface ProjectJournalEntryInput {
  id: string;
  posting_date: string; // ISO date
  journal_lines: Array<{
    id: string;
    account_code: string;
    debit: string | number;
    credit: string | number;
    project_id: string | null;
  }>;
}

export interface ProjectPeriodInput extends PeriodInput {
  name?: string;
}

export interface ProjectBudgetForecastInput {
  projectId: string;
  budgetLines: BudgetLineInput[];
  journalEntries: ProjectJournalEntryInput[];
  periods: ProjectPeriodInput[];
  currency: string;
}

export interface ProjectForecastPoint {
  periodId: string;
  periodName: string | null;
  startDate: string;
  endDate: string;
  budgeted: string;
  actual: string;
  variance: string;
}

export interface ProjectBudgetForecastResult {
  projectId: string;
  currency: string;
  budgetVsActual: ReturnType<typeof computeBudgetVsActual>;
  forecastCurve: ProjectForecastPoint[];
}

function flattenJournalEntries(entries: ProjectJournalEntryInput[]): JournalLineInput[] {
  const out: JournalLineInput[] = [];
  for (const entry of entries) {
    for (const line of entry.journal_lines ?? []) {
      out.push({
        id: line.id,
        account_code: line.account_code,
        debit: line.debit,
        credit: line.credit,
        project_id: line.project_id ?? null,
        posting_date: entry.posting_date,
      });
    }
  }
  return out;
}

function periodName(period: ProjectPeriodInput): string | null {
  return period.name != null ? String(period.name) : null;
}

/**
 * Compute budget vs actual and a per-period forecast curve for one project.
 *
 * Only budget lines and journal lines tied to the given project are included.
 * Variance = actual − budgeted, exact decimal. The forecast curve contains one
 * point per provided period, sorted by period start date.
 */
export function computeProjectBudgetForecast(
  input: ProjectBudgetForecastInput,
): ProjectBudgetForecastResult {
  const { projectId, budgetLines, journalEntries, periods, currency } = input;

  const projectBudgetLines = budgetLines.filter((bl) => bl.project_id === projectId);
  const projectJournalLines = flattenJournalEntries(journalEntries).filter(
    (jl) => jl.project_id === projectId,
  );

  const budgetVsActual = computeBudgetVsActual({
    budgetLines: projectBudgetLines,
    journalLines: projectJournalLines,
    periods,
    currency,
  });

  const sortedPeriods = [...periods].sort((a, b) => a.start_date.localeCompare(b.start_date));

  const forecastCurve: ProjectForecastPoint[] = sortedPeriods.map((period) => {
    const lines = budgetVsActual.byPeriod[period.id] ?? [];
    const budgeted =
      lines.length === 0
        ? Money.zero(currency)
        : sumMoney(lines.map((l) => Money.of(l.budgeted, currency)));
    const actual =
      lines.length === 0
        ? Money.zero(currency)
        : sumMoney(lines.map((l) => Money.of(l.actual, currency)));
    const variance = actual.minus(budgeted);

    return {
      periodId: period.id,
      periodName: periodName(period),
      startDate: period.start_date,
      endDate: period.end_date,
      budgeted: budgeted.toString(),
      actual: actual.toString(),
      variance: variance.toString(),
    };
  });

  return { projectId, currency, budgetVsActual, forecastCurve };
}
