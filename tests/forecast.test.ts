import { describe, it, expect } from "vitest";
import { projectCash } from "@/management/ai-manager/forecast";

const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("cash forecast (change plan §6.2 / §8.5, decimal money §8)", () => {
  it("applies inflows and outflows to the opening balance", () => {
    const r = projectCash({
      currency: "LKR",
      openingCash: "10000.00",
      inflows: [{ date: iso(5), amount: "5000.00" }],
      outflows: [{ date: iso(10), amount: "3000.00" }],
      horizonDays: 30,
    });
    expect(r.closingBalance).toBe("12000.00");
    expect(r.goesNegative).toBe(false);
  });

  it("detects a negative cash trough", () => {
    const r = projectCash({
      currency: "LKR",
      openingCash: "1000.00",
      inflows: [{ date: iso(20), amount: "5000.00" }],
      outflows: [{ date: iso(5), amount: "3000.00" }],
      horizonDays: 30,
    });
    expect(r.goesNegative).toBe(true);
    expect(Number(r.lowest.balance)).toBeLessThan(0);
    expect(r.closingBalance).toBe("3000.00"); // 1000 - 3000 + 5000
  });

  it("ignores events outside the horizon", () => {
    const r = projectCash({
      currency: "LKR",
      openingCash: "100.00",
      inflows: [{ date: iso(500), amount: "9999.00" }],
      outflows: [],
      horizonDays: 30,
    });
    expect(r.closingBalance).toBe("100.00");
  });

  it("FIN-004 — commitment outflows lower the trough", () => {
    const r = projectCash({
      currency: "LKR",
      openingCash: "10000.00",
      inflows: [{ date: iso(20), amount: "5000.00" }],
      outflows: [
        { date: iso(5), amount: "3000.00" },
        { date: iso(10), amount: "8000.00" }, // commitment-style outflow
      ],
      horizonDays: 30,
    });
    expect(r.goesNegative).toBe(true);
    expect(r.lowest.balance).toBe("-1000.00"); // 10000 - 3000 - 8000
    expect(r.closingBalance).toBe("4000.00"); // -1000 + 5000
  });
});
