/**
 * FIN-006 — Scenario analysis.
 * Pure deterministic helper that projects budget lines under best/expected/worst
 * assumptions and compares the projection to both budgeted and actual amounts.
 * Exact decimal `Money` only.
 */
import { Money, dec } from "@/lib/money";
import {
  computeBudgetVsActual,
  type BudgetLineInput,
  type JournalLineInput,
  type PeriodInput,
} from "./budget-vs-actual";

export type ScenarioKind = "best" | "expected" | "worst";

export interface ScenarioAssumption {
  /** Relative adjustment as a decimal, e.g. "0.10" for +10%. Applied before kind multiplier. */
  percent?: string;
  /** Absolute adjustment added after percent. */
  amount?: string;
}

export interface ScenarioAssumptions {
  /** account_code -> assumption. A null/missing account_code key uses the "__none__" key. */
  byAccount: Record<string, ScenarioAssumption>;
  /** Global multiplier applied per scenario kind after account adjustments. */
  kindMultiplier: Record<ScenarioKind, string>;
}

export const DEFAULT_KIND_MULTIPLIER: Record<ScenarioKind, string> = {
  best: "1.10",
  expected: "1.00",
  worst: "0.90",
};

export interface ScenarioLineProjection {
  budgetLineId: string;
  accountCode: string | null;
  projectId: string | null;
  periodId: string;
  budgeted: string;
  actual: string;
  projected: Record<ScenarioKind, string>;
  vsBudget: Record<ScenarioKind, string>;
  vsActual: Record<ScenarioKind, string>;
}

export interface ScenarioTotals {
  budgeted: string;
  actual: string;
  projected: Record<ScenarioKind, string>;
  vsBudget: Record<ScenarioKind, string>;
  vsActual: Record<ScenarioKind, string>;
}

export interface ScenarioAnalysisResult {
  lines: ScenarioLineProjection[];
  totals: ScenarioTotals;
}

function accountKey(accountCode: string | null): string {
  return accountCode ?? "__none__";
}

function applyAssumption(base: Money, assumption: ScenarioAssumption | undefined): Money {
  if (!assumption) return base;
  let adjusted = base;
  if (assumption.percent !== undefined) {
    const multiplier = dec(1).plus(dec(assumption.percent));
    adjusted = Money.of(adjusted.amount.times(multiplier), adjusted.currency);
  }
  if (assumption.amount !== undefined) {
    adjusted = adjusted.plus(Money.of(assumption.amount, adjusted.currency));
  }
  return adjusted;
}

function sumToMoney(values: Money[]): Money {
  if (values.length === 0) throw new Error("sumToMoney requires at least one value");
  return values.reduce((acc, v) => acc.plus(v));
}

/**
 * Project budget lines under best/expected/worst scenarios.
 *
 * Rules:
 * - For each budget line, start from the budgeted amount.
 * - Apply an account-specific percent/amount adjustment if present.
 * - Apply the scenario kind multiplier.
 * - Compare projected to budgeted (vsBudget) and to actual (vsActual).
 *
 * `kindMultiplier` defaults to best=1.10, expected=1.00, worst=0.90.
 */
export function projectScenarios(options: {
  budgetLines: BudgetLineInput[];
  journalLines: JournalLineInput[];
  periods: PeriodInput[];
  assumptions: Partial<ScenarioAssumptions>;
  currency: string;
}): ScenarioAnalysisResult {
  const { budgetLines, journalLines, periods, assumptions, currency } = options;
  const kindMultiplier: Record<ScenarioKind, string> = {
    best: assumptions.kindMultiplier?.best ?? DEFAULT_KIND_MULTIPLIER.best,
    expected: assumptions.kindMultiplier?.expected ?? DEFAULT_KIND_MULTIPLIER.expected,
    worst: assumptions.kindMultiplier?.worst ?? DEFAULT_KIND_MULTIPLIER.worst,
  };
  const byAccount = assumptions.byAccount ?? {};

  const bva = computeBudgetVsActual({ budgetLines, journalLines, periods, currency });
  const bvaByLineId = new Map(bva.lines.map((l) => [l.budgetLineId, l]));

  const kinds: ScenarioKind[] = ["best", "expected", "worst"];

  const lines: ScenarioLineProjection[] = budgetLines.map((bl) => {
    const actualLine = bvaByLineId.get(bl.id);
    const base = Money.of(String(bl.amount), currency);
    const adjusted = applyAssumption(base, byAccount[accountKey(bl.account_code)]);
    const actual = actualLine ? Money.of(actualLine.actual, currency) : Money.zero(currency);

    const projected: Record<ScenarioKind, string> = { best: "", expected: "", worst: "" };
    const vsBudget: Record<ScenarioKind, string> = { best: "", expected: "", worst: "" };
    const vsActual: Record<ScenarioKind, string> = { best: "", expected: "", worst: "" };

    for (const kind of kinds) {
      const p = Money.of(adjusted.amount.times(dec(kindMultiplier[kind])), currency).round();
      projected[kind] = p.toString();
      vsBudget[kind] = p.minus(base).toString();
      vsActual[kind] = p.minus(actual).toString();
    }

    return {
      budgetLineId: bl.id,
      accountCode: bl.account_code,
      projectId: bl.project_id,
      periodId: bl.period_id,
      budgeted: base.toString(),
      actual: actual.toString(),
      projected,
      vsBudget,
      vsActual,
    };
  });

  const totals = computeScenarioTotals(lines, currency);

  return { lines, totals };
}

function computeScenarioTotals(lines: ScenarioLineProjection[], currency: string): ScenarioTotals {
  if (lines.length === 0) {
    const zero = Money.zero(currency).toString();
    return {
      budgeted: zero,
      actual: zero,
      projected: { best: zero, expected: zero, worst: zero },
      vsBudget: { best: zero, expected: zero, worst: zero },
      vsActual: { best: zero, expected: zero, worst: zero },
    };
  }

  const budgeted = sumToMoney(lines.map((l) => Money.of(l.budgeted, currency)));
  const actual = sumToMoney(lines.map((l) => Money.of(l.actual, currency)));

  const projected: Record<ScenarioKind, string> = { best: "", expected: "", worst: "" };
  const vsBudget: Record<ScenarioKind, string> = { best: "", expected: "", worst: "" };
  const vsActual: Record<ScenarioKind, string> = { best: "", expected: "", worst: "" };

  for (const kind of ["best", "expected", "worst"] as ScenarioKind[]) {
    const p = sumToMoney(lines.map((l) => Money.of(l.projected[kind], currency)));
    projected[kind] = p.toString();
    vsBudget[kind] = p.minus(budgeted).toString();
    vsActual[kind] = p.minus(actual).toString();
  }

  return {
    budgeted: budgeted.toString(),
    actual: actual.toString(),
    projected,
    vsBudget,
    vsActual,
  };
}
