/**
 * FIN-006 — Budget versus actual and scenario analysis.
 *
 * Verifies the new budgets pages, server actions and pure helper modules exist
 * and surface the expected finance concepts without requiring a live database.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { computeBudgetVsActual } from "@/modules/finance/budget-vs-actual";
import { projectScenarios } from "@/modules/finance/scenario-analysis";

const LIST = "src/app/app/finance/budgets/page.tsx";
const DETAIL = "src/app/app/finance/budgets/[id]/page.tsx";
const ACTIONS = "src/app/app/finance/budgets/actions.ts";
const HOME = "src/app/app/finance/page.tsx";
const BVA = "src/modules/finance/budget-vs-actual.ts";
const SCENARIO = "src/modules/finance/scenario-analysis.ts";

describe("FIN-006 — budget vs actual surface", () => {
  const list = readFileSync(LIST, "utf8");
  const detail = readFileSync(DETAIL, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const home = readFileSync(HOME, "utf8");
  const bva = readFileSync(BVA, "utf8");
  const scenario = readFileSync(SCENARIO, "utf8");

  it("exports pure deterministic helper modules", () => {
    expect(bva).toContain("export function computeBudgetVsActual");
    expect(bva).toContain("Money");
    expect(scenario).toContain("export function projectScenarios");
    expect(scenario).toContain("ScenarioKind");
  });

  it("has real runtime entrypoints under /app/finance/budgets", () => {
    expect(list).toContain("export default async function BudgetsPage");
    expect(detail).toContain("export default async function BudgetDetailPage");
  });

  it("lists budgets with fiscal year and line count", () => {
    expect(list).toContain('from("budgets")');
    expect(list).toContain("company_id");
    expect(list).toContain("fiscal_year_id");
    expect(list).toContain("budget_lines");
  });

  it("provides gated server actions for budget, line and scenario creation", () => {
    expect(actions).toContain('"use server"');
    expect(actions).toContain("export async function createBudget");
    expect(actions).toContain("export async function createBudgetLine");
    expect(actions).toContain("export async function createScenario");
    expect(actions).toContain("requireFinance");
    expect(actions).toContain("budget.created");
    expect(actions).toContain("budget_line.created");
    expect(actions).toContain("forecast_scenario.created");
  });

  it("uses the pure modules on the detail page", () => {
    expect(detail).toContain("computeBudgetVsActual");
    expect(detail).toContain("projectScenarios");
  });

  it("shows budgeted, actual, variance and variance %", () => {
    expect(detail).toContain("Budgeted");
    expect(detail).toContain("Actual");
    expect(detail).toContain("Variance");
    expect(detail).toContain("variancePercent");
  });

  it("shows scenario selector with best/expected/worst", () => {
    expect(detail).toContain("Scenario");
    expect(detail).toContain('"best"');
    expect(detail).toContain('"expected"');
    expect(detail).toContain('"worst"');
  });

  it("includes create forms for budget lines and scenarios", () => {
    expect(detail).toContain("createBudgetLine");
    expect(detail).toContain("createScenario");
    expect(detail).toContain("assumptions");
    expect(detail).toContain("account_code");
    expect(detail).toContain("period_id");
  });

  it("links the budgets page from the finance home", () => {
    expect(home).toContain('/app/finance/budgets');
    expect(home).toMatch(/Budgets vs actual|Budget vs actual/i);
  });

  it("computes budget vs actual with exact decimals", () => {
    const r = computeBudgetVsActual({
      budgetLines: [{ id: "bl-1", account_code: "EXP-001", project_id: null, period_id: "p1", amount: "1000.00" }],
      journalLines: [{ id: "jl-1", account_code: "EXP-001", project_id: null, debit: "300.00", credit: "0", posting_date: "2026-01-15" }],
      periods: [{ id: "p1", start_date: "2026-01-01", end_date: "2026-01-31" }],
      currency: "LKR",
    });
    expect(r.lines[0]!.actual).toBe("300.00");
    expect(r.lines[0]!.variance).toBe("-700.00");
    expect(r.lines[0]!.variancePercent).toBe("-70.00");
  });

  it("projects scenarios with default multipliers", () => {
    const r = projectScenarios({
      budgetLines: [{ id: "bl-1", account_code: "EXP-001", project_id: null, period_id: "p1", amount: "10000.00" }],
      journalLines: [],
      periods: [{ id: "p1", start_date: "2026-01-01", end_date: "2026-01-31" }],
      currency: "LKR",
      assumptions: {},
    });
    expect(r.totals.projected.best).toBe("11000.00");
    expect(r.totals.projected.expected).toBe("10000.00");
    expect(r.totals.projected.worst).toBe("9000.00");
  });
});
