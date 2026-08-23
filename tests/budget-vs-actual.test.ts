import { describe, it, expect } from "vitest";
import { computeBudgetVsActual, aggregateActuals } from "@/modules/finance/budget-vs-actual";
import { projectScenarios, DEFAULT_KIND_MULTIPLIER } from "@/modules/finance/scenario-analysis";

const currency = "LKR";

const periods = [
  { id: "p1", start_date: "2026-01-01", end_date: "2026-01-31" },
  { id: "p2", start_date: "2026-02-01", end_date: "2026-02-28" },
];

describe("FIN-006 — budget vs actual", () => {
  it("matches journal activity by period, account and project", () => {
    const budgetLines = [
      { id: "bl-1", account_code: "EXP-001", project_id: "prj-1", period_id: "p1", amount: "10000.00" },
      { id: "bl-2", account_code: "EXP-001", project_id: "prj-1", period_id: "p2", amount: "12000.00" },
    ];
    const journalLines = [
      { id: "jl-1", account_code: "EXP-001", project_id: "prj-1", debit: "3000.00", credit: "0", posting_date: "2026-01-15" },
      { id: "jl-2", account_code: "EXP-001", project_id: "prj-1", debit: "2000.00", credit: "0", posting_date: "2026-02-10" },
    ];

    const r = computeBudgetVsActual({ budgetLines, journalLines, periods, currency });

    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]!.actual).toBe("3000.00");
    expect(r.lines[0]!.variance).toBe("-7000.00");
    expect(r.lines[1]!.actual).toBe("2000.00");
    expect(r.lines[1]!.variance).toBe("-10000.00");
  });

  it("sums multiple journal lines and subtracts credits", () => {
    const budgetLines = [{ id: "bl-1", account_code: "EXP-002", project_id: null, period_id: "p1", amount: "5000.00" }];
    const journalLines = [
      { id: "jl-1", account_code: "EXP-002", project_id: null, debit: "2000.00", credit: "0", posting_date: "2026-01-10" },
      { id: "jl-2", account_code: "EXP-002", project_id: null, debit: "1500.00", credit: "500.00", posting_date: "2026-01-20" },
    ];

    const r = computeBudgetVsActual({ budgetLines, journalLines, periods, currency });

    expect(r.lines[0]!.actual).toBe("3000.00");
    expect(r.lines[0]!.variance).toBe("-2000.00");
    expect(r.lines[0]!.variancePercent).toBe("-40.00");
  });

  it("ignores journal lines outside the period", () => {
    const budgetLines = [{ id: "bl-1", account_code: "EXP-003", project_id: null, period_id: "p1", amount: "1000.00" }];
    const journalLines = [
      { id: "jl-1", account_code: "EXP-003", project_id: null, debit: "500.00", credit: "0", posting_date: "2025-12-31" },
      { id: "jl-2", account_code: "EXP-003", project_id: null, debit: "400.00", credit: "0", posting_date: "2026-01-15" },
    ];

    const r = computeBudgetVsActual({ budgetLines, journalLines, periods, currency });

    expect(r.lines[0]!.actual).toBe("400.00");
  });

  it("groups results by period, project and account", () => {
    const budgetLines = [
      { id: "bl-1", account_code: "EXP-001", project_id: "prj-1", period_id: "p1", amount: "1000.00" },
      { id: "bl-2", account_code: "EXP-002", project_id: "prj-2", period_id: "p1", amount: "2000.00" },
    ];
    const journalLines: any[] = [];

    const r = computeBudgetVsActual({ budgetLines, journalLines, periods, currency });

    expect(Object.keys(r.byPeriod)).toHaveLength(1);
    expect(Object.keys(r.byProject)).toHaveLength(2);
    expect(Object.keys(r.byAccount)).toHaveLength(2);
  });

  it("returns zero totals when there are no budget lines", () => {
    const r = computeBudgetVsActual({ budgetLines: [], journalLines: [], periods, currency });

    expect(r.totals.budgeted).toBe("0.00");
    expect(r.totals.actual).toBe("0.00");
    expect(r.totals.variancePercent).toBeNull();
  });

  it("aggregates actuals by chosen dimensions", () => {
    const journalLines = [
      { id: "jl-1", account_code: "EXP-001", project_id: "prj-1", debit: "1000.00", credit: "0", posting_date: "2026-01-10" },
      { id: "jl-2", account_code: "EXP-001", project_id: "prj-1", debit: "500.00", credit: "0", posting_date: "2026-01-15" },
      { id: "jl-3", account_code: "EXP-002", project_id: "prj-2", debit: "300.00", credit: "0", posting_date: "2026-01-20" },
    ];

    const r = aggregateActuals({ journalLines, periods, currency, groupBy: ["account"] });

    expect(r).toHaveLength(2);
    expect(r.find((x) => x.keys.accountCode === "EXP-001")!.actual).toBe("1500.00");
    expect(r.find((x) => x.keys.accountCode === "EXP-002")!.actual).toBe("300.00");
  });
});

describe("FIN-006 — scenario analysis", () => {
  it("projects best/expected/worst using default multipliers", () => {
    const budgetLines = [{ id: "bl-1", account_code: "EXP-001", project_id: null, period_id: "p1", amount: "10000.00" }];
    const r = projectScenarios({ budgetLines, journalLines: [], periods, currency, assumptions: {} });

    expect(r.totals.projected.best).toBe("11000.00");
    expect(r.totals.projected.expected).toBe("10000.00");
    expect(r.totals.projected.worst).toBe("9000.00");
    expect(r.totals.vsBudget.best).toBe("1000.00");
    expect(r.totals.vsBudget.expected).toBe("0.00");
    expect(r.totals.vsBudget.worst).toBe("-1000.00");
  });

  it("applies account-specific percent and amount adjustments", () => {
    const budgetLines = [
      { id: "bl-1", account_code: "EXP-001", project_id: null, period_id: "p1", amount: "10000.00" },
      { id: "bl-2", account_code: "REV-001", project_id: null, period_id: "p1", amount: "20000.00" },
    ];
    const r = projectScenarios({
      budgetLines,
      journalLines: [],
      periods,
      currency,
      assumptions: {
        byAccount: {
          "EXP-001": { percent: "0.10" },
          "REV-001": { amount: "-2000.00" },
        },
      },
    });

    // EXP-001: 10000 * 1.10 = 11000
    // REV-001: (20000 - 2000) = 18000
    expect(r.totals.projected.expected).toBe("29000.00");
    expect(r.totals.projected.best).toBe("31900.00"); // 11000*1.1 + 18000*1.1
  });

  it("compares projections to actual activity", () => {
    const budgetLines = [{ id: "bl-1", account_code: "EXP-001", project_id: null, period_id: "p1", amount: "10000.00" }];
    const journalLines = [
      { id: "jl-1", account_code: "EXP-001", project_id: null, debit: "8000.00", credit: "0", posting_date: "2026-01-15" },
    ];
    const r = projectScenarios({ budgetLines, journalLines, periods, currency, assumptions: {} });

    expect(r.totals.actual).toBe("8000.00");
    expect(r.totals.vsActual.expected).toBe("2000.00");
    expect(r.totals.vsActual.worst).toBe("1000.00");
  });

  it("supports custom kind multipliers", () => {
    const budgetLines = [{ id: "bl-1", account_code: "EXP-001", project_id: null, period_id: "p1", amount: "10000.00" }];
    const r = projectScenarios({
      budgetLines,
      journalLines: [],
      periods,
      currency,
      assumptions: { kindMultiplier: { best: "1.25", expected: "1.00", worst: "0.75" } },
    });

    expect(r.totals.projected.best).toBe("12500.00");
    expect(r.totals.projected.worst).toBe("7500.00");
  });

  it("rounds projections to the currency scale", () => {
    const budgetLines = [{ id: "bl-1", account_code: "EXP-001", project_id: null, period_id: "p1", amount: "1000.00" }];
    const r = projectScenarios({
      budgetLines,
      journalLines: [],
      periods,
      currency,
      assumptions: { kindMultiplier: { best: "1.105", expected: "1.00", worst: "0.905" } },
    });

    expect(r.totals.projected.best).toBe("1105.00");
    expect(r.totals.projected.worst).toBe("905.00");
  });
});
