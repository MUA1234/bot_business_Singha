import { describe, it, expect } from "vitest";
import { Money, sumMoney, currencyScale } from "@/lib/money";

describe("Money — fixed precision (guide invariant #11)", () => {
  it("adds without floating-point error", () => {
    // 0.1 + 0.2 !== 0.3 in float; must be exact here.
    const total = Money.of("0.10", "USD").plus(Money.of("0.20", "USD"));
    expect(total.toString()).toBe("0.30");
  });

  it("rejects a JS number / float-y input string", () => {
    // @ts-expect-error numbers are not accepted as money
    expect(() => Money.of(0.1, "USD")).toThrow();
    expect(() => Money.of("1e3", "USD")).toThrow();
    expect(() => Money.of("NaN", "USD")).toThrow();
  });

  it("rejects mixing currencies", () => {
    expect(() => Money.of("1.00", "USD").plus(Money.of("1.00", "LKR"))).toThrow(/mismatch/i);
  });

  it("honours currency scale (LKR=2, JPY=0, KWD=3)", () => {
    expect(currencyScale("LKR")).toBe(2);
    expect(currencyScale("JPY")).toBe(0);
    expect(currencyScale("KWD")).toBe(3);
    expect(Money.of("1000", "JPY").toString()).toBe("1000");
    expect(Money.of("14500", "LKR").toString()).toBe("14500.00");
  });

  it("uses banker's rounding at the currency scale", () => {
    expect(Money.of("2.125", "USD").round().toString()).toBe("2.12"); // half-even
    expect(Money.of("2.135", "USD").round().toString()).toBe("2.14");
  });

  it("sums a list", () => {
    const s = sumMoney([Money.of("10.00", "LKR"), Money.of("5.50", "LKR"), Money.of("0.50", "LKR")]);
    expect(s.toString()).toBe("16.00");
  });
});
