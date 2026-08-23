/**
 * FIN-007 — Funding gap and investment economics (pure module).
 */
import { describe, it, expect } from "vitest";
import { computeFundingGap, computeInvestmentEconomics, suggestFundingRequirementName } from "@/modules/finance/funding";
import { projectCash } from "@/management/ai-manager/forecast";

describe("computeFundingGap", () => {
  it("returns zero when the forecast never goes negative", () => {
    const fc = projectCash({
      currency: "LKR",
      openingCash: "100000",
      inflows: [{ date: "2099-01-05", amount: "50000" }],
      outflows: [{ date: "2099-01-10", amount: "30000" }],
      horizonDays: 30,
    });
    const gap = computeFundingGap(fc);
    expect(gap.goesNegative).toBe(false);
    expect(gap.amount).toBe("0.00");
    expect(gap.currency).toBe("LKR");
  });

  it("returns the negative trough as the required funding amount", () => {
    const d = (offset: number) => {
      const dt = new Date();
      dt.setDate(dt.getDate() + offset);
      return dt.toISOString().slice(0, 10);
    };
    const fc = projectCash({
      currency: "LKR",
      openingCash: "10000",
      inflows: [],
      outflows: [
        { date: d(3), amount: "15000" },
        { date: d(5), amount: "10000" },
      ],
      horizonDays: 30,
    });
    const gap = computeFundingGap(fc);
    expect(gap.goesNegative).toBe(true);
    expect(gap.amount).toBe("15000.00");
    expect(gap.date).toBe(fc.lowest.date);
  });

  it("names a requirement from the gap date", () => {
    expect(suggestFundingRequirementName("2099-03-15")).toBe("Funding requirement — 2099-03-15");
  });
});

describe("computeInvestmentEconomics", () => {
  it("active investment with current value above cost shows unrealized gain", () => {
    const econ = computeInvestmentEconomics({
      cost_basis: "100000",
      current_value: "125000",
      disposal_proceeds: null,
      status: "active",
      currency: "LKR",
    });
    expect(econ.costBasis).toBe("100000.00");
    expect(econ.currentValue).toBe("125000.00");
    expect(econ.unrealizedGainOrLoss).toBe("25000.00");
    expect(econ.realizedGainOrLoss).toBeNull();
  });

  it("active investment with current value below cost shows unrealized loss", () => {
    const econ = computeInvestmentEconomics({
      cost_basis: "100000",
      current_value: "75000",
      disposal_proceeds: null,
      status: "active",
      currency: "LKR",
    });
    expect(econ.unrealizedGainOrLoss).toBe("-25000.00");
  });

  it("disposed investment uses disposal proceeds for realized gain/loss", () => {
    const econ = computeInvestmentEconomics({
      cost_basis: "100000",
      current_value: null,
      disposal_proceeds: "90000",
      status: "disposed",
      currency: "LKR",
    });
    expect(econ.realizedGainOrLoss).toBe("-10000.00");
    expect(econ.unrealizedGainOrLoss).toBe("0.00");
  });
});
