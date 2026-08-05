import { describe, it, expect } from "vitest";
import { amortizationSchedule } from "@/accounting/amortization";
import Decimal from "decimal.js";

describe("loan amortization (change plan §8.3, decimal §8)", () => {
  it("produces one row per month and clears the balance", () => {
    const sched = amortizationSchedule("100000", 12, 12, "2026-01-01");
    expect(sched).toHaveLength(12);
    expect(sched[11]!.balance).toBe("0.00");
    expect(sched[0]!.dueDate).toBe("2026-02-01");
  });

  it("total principal repaid equals the loan", () => {
    const sched = amortizationSchedule("100000", 12, 12, "2026-01-01");
    const totalPrincipal = sched.reduce((s, i) => s.plus(new Decimal(i.principal)), new Decimal(0));
    expect(totalPrincipal.toFixed(2)).toBe("100000.00");
  });

  it("interest-free loan splits principal evenly, zero interest", () => {
    const sched = amortizationSchedule("1200", 0, 12, "2026-01-01");
    expect(sched[0]!.interest).toBe("0.00");
    expect(sched[0]!.principal).toBe("100.00");
    expect(sched[11]!.balance).toBe("0.00");
  });

  it("first-month interest is balance × monthly rate", () => {
    // 12% annual ⇒ 1% monthly ⇒ first interest on 100000 = 1000.00
    const sched = amortizationSchedule("100000", 12, 24, "2026-01-01");
    expect(sched[0]!.interest).toBe("1000.00");
  });
});
