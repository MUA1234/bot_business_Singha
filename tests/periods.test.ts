import { describe, it, expect } from "vitest";
import { monthlyPeriods } from "@/accounting/periods";

describe("accounting periods (change plan §8.1)", () => {
  it("generates twelve monthly periods", () => {
    const ps = monthlyPeriods(2026);
    expect(ps).toHaveLength(12);
    expect(ps[0]).toEqual({ name: "2026-01", start_date: "2026-01-01", end_date: "2026-01-31" });
    expect(ps[11]).toEqual({ name: "2026-12", start_date: "2026-12-01", end_date: "2026-12-31" });
  });

  it("handles month-end lengths (Feb non-leap)", () => {
    expect(monthlyPeriods(2026)[1]!.end_date).toBe("2026-02-28");
    expect(monthlyPeriods(2028)[1]!.end_date).toBe("2028-02-29"); // leap year
  });
});
