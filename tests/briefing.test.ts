import { describe, it, expect } from "vitest";
import { buildBriefing } from "@/management/ai-manager/briefing";

describe("executive briefing (change plan §6.2)", () => {
  it("leads with critical count and cash risk", () => {
    const lines = buildBriefing({
      criticalCount: 3, warnCount: 2, currency: "LKR", cash: "50000",
      arOverdue: "12000", apOverdue: "8000",
      forecastGoesNegative: true, forecastLowest: { date: "2026-09-01", balance: "-4000" },
    });
    expect(lines[0]).toMatch(/3 critical/);
    expect(lines.some((l) => /negative/.test(l))).toBe(true);
    expect(lines.some((l) => /receivables is overdue/.test(l))).toBe(true);
    expect(lines.some((l) => /Cash on hand/.test(l))).toBe(true);
  });

  it("all-clear when nothing is wrong", () => {
    const lines = buildBriefing({
      criticalCount: 0, warnCount: 0, currency: "LKR", cash: "50000",
      arOverdue: "0", apOverdue: "0",
    });
    expect(lines.some((l) => /on track/.test(l))).toBe(true);
  });

  it("always returns at least one line", () => {
    expect(buildBriefing({ criticalCount: 0, warnCount: 0, currency: "LKR", cash: "0", arOverdue: "0", apOverdue: "0" }).length).toBeGreaterThan(0);
  });
});
