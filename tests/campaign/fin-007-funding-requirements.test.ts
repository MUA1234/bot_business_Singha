/**
 * FIN-007 — Funding requirements and investments surface.
 *
 * Verifies the funding gap computation, the funding/investment register pages,
 * server actions and the finance home link exist and surface the right concepts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { computeFundingGap, computeInvestmentEconomics } from "@/modules/finance/funding";
import { projectCash } from "@/management/ai-manager/forecast";

const PAGE = "src/app/app/finance/funding/page.tsx";
const ACTIONS = "src/app/app/finance/funding/actions.ts";
const HOME = "src/app/app/finance/page.tsx";
const MODULE = "src/modules/finance/funding.ts";
const MIGRATION = "src/db/migrations/0105_funding_requirements_and_investments.sql";

describe("FIN-007 — funding requirements and investments surface", () => {
  const page = readFileSync(PAGE, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const home = readFileSync(HOME, "utf8");
  const mod = readFileSync(MODULE, "utf8");
  const migration = readFileSync(MIGRATION, "utf8");

  it("adds funding_requirements and investments tables with company scope and capability RLS", () => {
    expect(migration).toContain("create table if not exists funding_requirements");
    expect(migration).toContain("create table if not exists investments");
    expect(migration).toContain("company_id uuid not null references companies(id)");
    expect(migration).toContain("'finance.funding.manage'");
    expect(migration).toContain("funding_requirements_cap_ins");
    expect(migration).toContain("investments_cap_ins");
  });

  it("exports pure deterministic funding helpers", () => {
    expect(mod).toContain("export function computeFundingGap");
    expect(mod).toContain("export function computeInvestmentEconomics");
    expect(mod).toContain("Money");
  });

  it("has a real runtime entrypoint under /app/finance/funding", () => {
    expect(page).toContain("export default async function FundingPage");
    expect(page).toContain('from("funding_requirements")');
    expect(page).toContain('from("investments")');
    expect(page).toContain("computeFundingGap");
    expect(page).toContain("computeInvestmentEconomics");
  });

  it("computes the funding gap from a cash forecast", () => {
    const d = (offset: number) => {
      const dt = new Date();
      dt.setDate(dt.getDate() + offset);
      return dt.toISOString().slice(0, 10);
    };
    const fc = projectCash({
      currency: "LKR",
      openingCash: "5000",
      inflows: [],
      outflows: [{ date: d(4), amount: "12000" }],
      horizonDays: 30,
    });
    const gap = computeFundingGap(fc);
    expect(gap.goesNegative).toBe(true);
    expect(gap.amount).toBe("7000.00");
  });

  it("computes active investment economics deterministically", () => {
    const econ = computeInvestmentEconomics({
      cost_basis: "200000",
      current_value: "250000",
      disposal_proceeds: null,
      status: "active",
      currency: "LKR",
    });
    expect(econ.unrealizedGainOrLoss).toBe("50000.00");
  });

  it("provides gated server actions for funding requirements and investments", () => {
    expect(actions).toContain('"use server"');
    expect(actions).toContain("export async function createFundingRequirement");
    expect(actions).toContain("export async function updateFundingRequirementStatus");
    expect(actions).toContain("export async function createInvestment");
    expect(actions).toContain("export async function disposeInvestment");
    expect(actions).toContain("funding_requirement.created");
    expect(actions).toContain("investment.created");
    expect(actions).toContain("investment.disposed");
  });

  it("shows funding gap and forecast lowest on the page", () => {
    expect(page).toContain("Derived funding gap");
    expect(page).toContain("90-day cash forecast lowest");
    expect(page).toContain("forecast.goesNegative");
    expect(page).toContain("gap.goesNegative");
  });

  it("includes create forms for funding requirements and investments", () => {
    expect(page).toContain("createFundingRequirement");
    expect(page).toContain("createInvestment");
    expect(page).toContain('name="required_amount"');
    expect(page).toContain('name="cost_basis"');
  });

  it("allows status updates and disposal through the page", () => {
    expect(page).toContain("updateFundingRequirementStatus");
    expect(page).toContain("disposeInvestment");
    expect(page).toContain('name="status"');
    expect(page).toContain('name="disposal_proceeds"');
  });

  it("links the funding page from the finance home", () => {
    expect(home).toContain('/app/finance/funding');
    expect(home).toMatch(/Funding & investments/i);
  });
});
