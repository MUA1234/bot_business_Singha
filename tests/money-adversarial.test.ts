/**
 * Completion-program Phase 1A — adversarial money tests (owner mandate: fractional values, very
 * large values, mixed currencies, negative values, rounding boundaries, authority limits).
 * These pin the Decimal-exact behavior that replaced JS-float money math.
 */
import { describe, it, expect } from "vitest";
import { dec, decSub, decSum, decGtZero, fmtMoney, Money, parseMoneyInput } from "@/lib/money";
import { routeDecision } from "@/management/policy/route-decision";
import { positiveDecimalString } from "@/schemas/common";
import { taxAmount, netFromGross, grossFromNet } from "@/accounting/tax";
import { computeCostUsd } from "@/ai/pricing";

describe("dec/decSub/decSum/decGtZero — DB money-column helpers", () => {
  it("fractional: 0.1 + 0.2 sums to exactly 0.3", () => {
    expect(decSum(["0.1", "0.2"]).toFixed()).toBe("0.3");
  });

  it("very large: beyond 2^53 minor units stays exact", () => {
    // Number("90071992547409.93") - Number("0.01") loses the cent; Decimal must not.
    expect(decSub("90071992547409.93", "0.01").toFixed()).toBe("90071992547409.92");
    expect(decGtZero(decSub("90071992547409.93", "90071992547409.93").toFixed())).toBe(false);
  });

  it("negative: outstanding can be negative (over-settled) and compares correctly", () => {
    expect(decSub("100.00", "150.00").toFixed()).toBe("-50");
    expect(decGtZero("-0.01")).toBe(false);
    expect(decGtZero("0.00")).toBe(false);
    expect(decGtZero("0.01")).toBe(true);
  });

  it("NULL/empty DB columns are 0; malformed values throw (fail closed, never silent zero)", () => {
    expect(dec(null).toFixed()).toBe("0");
    expect(dec(undefined).toFixed()).toBe("0");
    expect(dec("").toFixed()).toBe("0");
    expect(() => dec("12,500")).toThrow();
    expect(() => dec("1e5")).toThrow();
    expect(() => dec("NaN")).toThrow();
  });

  it("tiny sub-float values are not collapsed to zero", () => {
    const tiny = "0." + "0".repeat(30) + "1";
    expect(decGtZero(tiny)).toBe(true);
  });
});

describe("fmtMoney — the one display formatter", () => {
  it("groups thousands, keeps currency scale, never floats", () => {
    expect(fmtMoney("14500", "LKR")).toBe("LKR 14,500.00");
    expect(fmtMoney("14500.5", "LKR")).toBe("LKR 14,500.50");
    expect(fmtMoney("-1234567.891", "USD")).toBe("USD -1,234,567.89");
    expect(fmtMoney("1500", "JPY")).toBe("JPY 1,500"); // zero-decimal currency
    expect(fmtMoney("12.3456", "BHD")).toBe("BHD 12.346"); // three-decimal currency (banker's rounding)
    expect(fmtMoney("0.1")).toBe("0.10"); // bare amount, default 2dp
  });

  it("very large values render exactly (a float formatter would corrupt them)", () => {
    expect(fmtMoney("90071992547409.93", "LKR")).toBe("LKR 90,071,992,547,409.93");
  });

  it("rounding boundary: half-even (banker's) at the currency scale", () => {
    expect(fmtMoney("2.005", "LKR")).toBe("LKR 2.00"); // 0.5 rounds to even neighbour 0
    expect(fmtMoney("2.015", "LKR")).toBe("LKR 2.02");
  });
});

describe("authority limits — routeDecision exceeds() is Decimal-exact", () => {
  const proposal = (amount: string, currency = "LKR") =>
    ({
      action: "record_expense",
      reason: "t",
      expectedOutcome: "t",
      evidenceRefs: [],
      confidence: 0.9,
      risk: "low",
      policyVersion: "v1",
      requiredPermission: "finance.expense.record",
      requiredApprovers: [],
      limit: { amount, currency },
      expiresAt: "2027-01-01",
      conditions: [],
    }) as never;

  it("one cent over the ceiling escalates even at float-breaking magnitudes", () => {
    const max = { amount: "90071992547409.92", currency: "LKR" };
    // At this magnitude Number() cannot represent the cent: a float compare sees equality.
    const over = routeDecision(proposal("90071992547409.93"), { actorAuthorityMax: max });
    const at = routeDecision(proposal("90071992547409.92"), { actorAuthorityMax: max });
    expect(over.reasons.join(" ")).toMatch(/exceeds the actor's delegated authority/i);
    expect(at.reasons.join(" ")).not.toMatch(/exceeds the actor's delegated authority/i);
  });

  it("fractional boundary: 100.001 exceeds a 100.00 ceiling", () => {
    const max = { amount: "100.00", currency: "LKR" };
    const r = routeDecision(proposal("100.001"), { actorAuthorityMax: max });
    expect(r.reasons.join(" ")).toMatch(/exceeds the actor's delegated authority/i);
  });

  it("mixed currencies always escalate (fail-safe), never numeric-compare", () => {
    const r = routeDecision(proposal("1.00", "USD"), { actorAuthorityMax: { amount: "1000000.00", currency: "LKR" } });
    expect(r.reasons.join(" ")).toMatch(/exceeds the actor's delegated authority/i);
  });
});

describe("positiveDecimalString — string-exact zero test", () => {
  it("rejects all-zero spellings and negatives; accepts sub-float tiny values", () => {
    expect(positiveDecimalString.safeParse("0").success).toBe(false);
    expect(positiveDecimalString.safeParse("0.00").success).toBe(false);
    expect(positiveDecimalString.safeParse("000").success).toBe(false);
    expect(positiveDecimalString.safeParse("-5").success).toBe(false);
    expect(positiveDecimalString.safeParse("0.01").success).toBe(true);
    // Number("0.0000...1") with 400 zeros collapses to 0 — the string test must still accept it.
    expect(positiveDecimalString.safeParse("0." + "0".repeat(400) + "1").success).toBe(true);
  });
});

describe("tax — Decimal rate factors (no float division)", () => {
  it("netFromGross inverts grossFromNet at awkward rates", () => {
    const gross = grossFromNet("100.00", 15, "LKR"); // 115.00
    expect(gross).toBe("115.00");
    expect(netFromGross(gross, 15, "LKR")).toBe("100.00");
  });

  it("taxAmount at a repeating-decimal rate stays at currency scale via banker's rounding", () => {
    expect(taxAmount("100.00", "7.5", "LKR")).toBe("7.50");
    expect(taxAmount("0.10", 15, "LKR")).toBe("0.02"); // 0.015 → half-even → 0.02
  });
});

describe("AI cost — Decimal token math", () => {
  it("large token counts times fractional $/Mtok stay exact to 6dp", () => {
    const prices = { m: { input: 0.15, output: 0.6 } };
    // 1_234_567 * 0.15 = 185185.05 (float gives 185185.04999999999...)
    expect(computeCostUsd("m", 1_234_567, 0, prices)).toBe("0.185185");
    expect(computeCostUsd("m", 0, 1_234_567, prices)).toBe("0.740740");
  });
});

describe("Money + parseMoneyInput regression pins", () => {
  it("mixed-currency arithmetic throws (explicitness invariant)", () => {
    const a = Money.of("10.00", "LKR");
    const b = Money.of("10.00", "USD");
    expect(() => a.plus(b)).toThrow(/mismatch/i);
  });

  it("parseMoneyInput refuses float-ish and grouped input", () => {
    expect(parseMoneyInput("1e5", "LKR")).toBeNull();
    expect(parseMoneyInput("12,500", "LKR")).toBeNull();
    expect(parseMoneyInput("  1450.50 ", "LKR")?.toString()).toBe("1450.50");
  });
});
