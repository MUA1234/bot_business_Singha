import { describe, it, expect } from "vitest";
import { expandRecurring } from "@/modules/finance/recurring";

const NOW = new Date("2026-08-05T00:00:00Z");
const iso = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10);

describe("recurring obligations (change plan §8.5)", () => {
  it("expands monthly occurrences within the horizon", () => {
    const occ = expandRecurring("monthly", "50000.00", iso(5), 90, NOW);
    expect(occ.length).toBe(3); // ~days 5, 35, 66 within 90
    expect(occ[0]!.amount).toBe("50000.00");
  });

  it("expands weekly occurrences", () => {
    const occ = expandRecurring("weekly", "1000", iso(1), 30, NOW);
    expect(occ.length).toBeGreaterThanOrEqual(4);
    expect(occ.length).toBeLessThanOrEqual(5);
  });

  it("fast-forwards past occurrences and stops at the horizon", () => {
    const occ = expandRecurring("monthly", "100", iso(-40), 60, NOW); // started in the past
    expect(occ.every((o) => o.date >= iso(0))).toBe(true);
    expect(occ.length).toBeGreaterThanOrEqual(1);
  });

  it("annual within a short horizon yields at most one", () => {
    expect(expandRecurring("annual", "9", iso(10), 90, NOW).length).toBe(1);
  });
});
