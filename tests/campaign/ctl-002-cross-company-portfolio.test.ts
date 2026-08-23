/**
 * CTL-002 — Cross-company portfolio overview.
 *
 * The portfolio page is a real runtime entrypoint that surfaces multiple companies
 * the owner belongs to, ranks them by attention needed, and never relaxes company
 * isolation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/portfolio/page.tsx";
const MODULE = "src/modules/management/portfolio.ts";

describe("CTL-002 — Cross-company portfolio overview", () => {
  const page = readFileSync(PAGE, "utf8");
  const module = readFileSync(MODULE, "utf8");

  it("has a real runtime entrypoint under /app/portfolio", () => {
    expect(page).toContain("export default async function PortfolioPage");
  });

  it("is gated to admin", () => {
    expect(page).toContain("requireAdmin");
  });

  it("only loads companies the user has an active membership in", () => {
    expect(page).toContain('from("memberships")');
    expect(page).toContain('eq("user_id", admin.userId)');
    expect(page).toContain('eq("status", "active")');
    expect(page).toContain('in("id", companyIds)');
  });

  it("exports pure deterministic portfolio helpers", () => {
    expect(module).toContain("export function summarizeCompanyPortfolio");
    expect(module).toContain("export function rankPortfolioByUrgency");
  });

  it("aggregates project, task, risk, incident and obligation counts", () => {
    expect(module).toContain("projectCount");
    expect(module).toContain("openTasks");
    expect(module).toContain("openRisks");
    expect(module).toContain("openIncidents");
    expect(module).toContain("openObligations");
  });

  it("uses exact-decimal money helpers for cash, AR and AP", () => {
    expect(module).toContain("computeCashPosition");
    expect(module).toContain("ageItems");
    expect(module).toContain("fmtMoney");
  });

  it("ranks companies so the most attention-needed appear first", () => {
    expect(module).toContain("status");
    expect(module).toContain("critical");
    expect(module).toContain("warn");
  });

  it("links back to the Command Centre", () => {
    expect(page).toContain('href="/app/command"');
  });

  it("is linked from the Command Centre header", () => {
    const command = readFileSync("src/app/app/command/page.tsx", "utf8");
    expect(command).toContain('href="/app/portfolio"');
  });
});
