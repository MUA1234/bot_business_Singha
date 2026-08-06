import { describe, it, expect } from "vitest";
import { parseMoneyInput, lineTotal, Money } from "@/lib/money";

describe("parseMoneyInput", () => {
  it("parses a canonical decimal string", () => {
    expect(parseMoneyInput("1250.50", "LKR")?.toString()).toBe("1250.50");
    expect(parseMoneyInput("0", "LKR")?.toString()).toBe("0.00");
  });

  it("returns null for empty or malformed input", () => {
    for (const bad of ["", "abc", "1.2.3", "1,000", "  ", "1e5", "NaN", null, undefined]) {
      expect(parseMoneyInput(bad as unknown, "LKR")).toBeNull();
    }
  });

  it("preserves precision a JS float would corrupt", () => {
    // 0.1 + 0.2 !== 0.3 in float; decimal money must be exact.
    const a = parseMoneyInput("0.10", "LKR")!;
    const b = parseMoneyInput("0.20", "LKR")!;
    expect(a.plus(b).toString()).toBe("0.30");
  });
});

describe("lineTotal", () => {
  it("multiplies unit price by an integer quantity, rounded to currency", () => {
    expect(lineTotal(Money.of("19.99", "LKR"), 3).toString()).toBe("59.97");
  });

  it("truncates fractional/negative quantities to a safe integer", () => {
    expect(lineTotal(Money.of("10.00", "LKR"), 2.9).toString()).toBe("20.00");
    expect(lineTotal(Money.of("10.00", "LKR"), -5).toString()).toBe("0.00");
  });

  it("handles a large price exactly (no float drift)", () => {
    expect(lineTotal(Money.of("999999.99", "LKR"), 7).toString()).toBe("6999999.93");
  });
});
