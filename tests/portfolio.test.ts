/**
 * CTL-002 — Cross-company portfolio overview helpers.
 */
import { describe, it, expect } from "vitest";
import { summarizeCompanyPortfolio, rankPortfolioByUrgency, type PortfolioCompanyInput } from "@/modules/management/portfolio";

const baseInput = (over: Partial<PortfolioCompanyInput> = {}): PortfolioCompanyInput => ({
  companyId: "c1",
  name: "Acme",
  currency: "LKR",
  projects: [],
  tasks: [],
  risks: [],
  incidents: [],
  obligations: [],
  cashAccounts: [],
  payments: [],
  invoices: [],
  bills: [],
  capacitySnapshots: [],
  ...over,
});

describe("summarizeCompanyPortfolio", () => {
  it("returns ok for an empty company", () => {
    const s = summarizeCompanyPortfolio(baseInput(), "2026-08-23");
    expect(s.status).toBe("ok");
    expect(s.projectCount).toBe(0);
    expect(s.openTasks).toBe(0);
    expect(s.cashOnHand).toBe("0");
  });

  it("counts active projects and open/overdue tasks", () => {
    const s = summarizeCompanyPortfolio(
      baseInput({
        projects: [{ status: "active" }, { status: "completed" }, { status: "on_hold" }],
        tasks: [
          { status: "in_progress", due_date: "2026-08-23" },
          { status: "in_progress", due_date: "2026-08-20" },
          { status: "completed", due_date: null },
        ],
      }),
      "2026-08-23",
    );
    expect(s.activeProjectCount).toBe(1);
    expect(s.projectCount).toBe(3);
    expect(s.openTasks).toBe(2);
    expect(s.overdueTasks).toBe(1);
  });

  it("flags critical when there are open incidents", () => {
    const s = summarizeCompanyPortfolio(baseInput({ incidents: [{ status: "open" }] }), "2026-08-23");
    expect(s.status).toBe("critical");
    expect(s.issues.some((i) => i.type === "open_incidents")).toBe(true);
  });

  it("flags warn when there are open risks", () => {
    const s = summarizeCompanyPortfolio(baseInput({ risks: [{ status: "open" }] }), "2026-08-23");
    expect(s.status).toBe("warn");
  });

  it("flags critical when overdue receivables exist", () => {
    const s = summarizeCompanyPortfolio(
      baseInput({
        invoices: [{ dueDate: "2026-08-01", outstanding: "100000" }],
      }),
      "2026-08-23",
    );
    expect(s.status).toBe("critical");
    expect(s.arOverdue).toBe("100000.00");
  });

  it("computes cash on hand from accounts and payments", () => {
    const s = summarizeCompanyPortfolio(
      baseInput({
        cashAccounts: [{ id: "b1", name: "Bank", currency: "LKR", openingBalance: "5000" }],
        payments: [{ accountId: "b1", direction: "in", amount: "2000" }],
      }),
      "2026-08-23",
    );
    expect(s.cashOnHand).toBe("7000.00");
  });
});

describe("rankPortfolioByUrgency", () => {
  it("ranks critical before warn before ok", () => {
    const a = summarizeCompanyPortfolio(baseInput({ companyId: "a", name: "A" }), "2026-08-23");
    const b = summarizeCompanyPortfolio(baseInput({ companyId: "b", name: "B", incidents: [{ status: "open" }] }), "2026-08-23");
    const c = summarizeCompanyPortfolio(baseInput({ companyId: "c", name: "C", risks: [{ status: "open" }] }), "2026-08-23");
    const ranked = rankPortfolioByUrgency([a, b, c]);
    expect(ranked.map((x) => x.name)).toEqual(["B", "C", "A"]);
  });

  it("ties are broken by highest overdue receivables", () => {
    const a = summarizeCompanyPortfolio(
      baseInput({ companyId: "a", name: "A", invoices: [{ dueDate: "2026-08-01", outstanding: "1000" }] }),
      "2026-08-23",
    );
    const b = summarizeCompanyPortfolio(
      baseInput({ companyId: "b", name: "B", invoices: [{ dueDate: "2026-08-01", outstanding: "5000" }] }),
      "2026-08-23",
    );
    const ranked = rankPortfolioByUrgency([a, b]);
    expect(ranked.map((x) => x.name)).toEqual(["B", "A"]);
  });
});
