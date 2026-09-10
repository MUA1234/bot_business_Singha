/**
 * F-005 — money must be exact at every boundary, never approximate.
 *
 * The defect: PostgREST serialises `numeric` as an unquoted JSON number, so money read
 * through it arrives as a double. Realistic amounts survive exactly, because JS prints
 * the shortest string that round-trips — but beyond ~15 significant digits they do not,
 * and `dec()` accepted the corrupted value silently via `String(value)`.
 *
 * These tests assert EXACT equality throughout. Nowhere is `toBeCloseTo` used: an
 * approximate assertion about money is the same mistake as a float, moved into the test
 * suite.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { Money, dec, decSum, decSub, currencyScale, parseMoneyInput, lineTotal, fmtMoney } from "@/lib/money";

describe("F-005 — the JS number boundary", () => {
  it("accepts numbers only where the double round-trip is provably lossless", () => {
    // These all have <= 15 significant digits, so String() recovers them exactly.
    const safe: [number, string][] = [
      [0, "0"],
      [1234.56, "1234.56"],
      [0.0001, "0.0001"],
      [999999999.99, "999999999.99"],
      [1840000, "1840000"],
      [-48250.25, "-48250.25"],
    ];
    for (const [input, expected] of safe) {
      expect(dec(input).toString(), `dec(${input})`).toBe(expected);
    }
  });

  it("REFUSES a number beyond the exact range instead of silently truncating it", () => {
    // The measured failure: 99999999999999.9999 is read back from a double as
    // 100000000000000, losing 0.9999. Accepting it is how a wrong number reaches a ledger.
    expect(() => dec(1e14)).toThrow(/too large to be exact/);
    expect(() => dec(99999999999999.9999)).toThrow(/too large to be exact/);
    expect(() => dec(1e12)).toThrow(/too large to be exact/);
    // And the error says what to do about it.
    expect(() => dec(1e15)).toThrow(/::text/);
  });

  it("REFUSES a number with more than 15 significant digits", () => {
    expect(() => dec(1.234567890123456789)).toThrow(/too large to be exact/);
  });

  it("refuses non-finite numbers", () => {
    expect(() => dec(Number.NaN)).toThrow();
    expect(() => dec(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("a decimal STRING of any size is still exact — the recommended path", () => {
    // `select("amount::text")` produces exactly this, and it has no ceiling.
    expect(dec("99999999999999.9999").toString()).toBe("99999999999999.9999");
    // 20 significant digits — far beyond a double, exact as a string.
    expect(dec("12345678901234.567890").toString()).toBe("12345678901234.56789");
  });

  it("Money.of still refuses a raw JS number outright", () => {
    // The stricter primitive stays strict; dec() is the lenient read path.
    expect(() => Money.of(1234.56 as unknown as string, "LKR")).toThrow(/Invalid decimal money string/);
  });
});

describe("F-005 — arithmetic is exact, never floating point", () => {
  it("addition that a float would get wrong", () => {
    // 0.1 + 0.2 === 0.30000000000000004 as doubles.
    expect(decSum(["0.1", "0.2"]).toString()).toBe("0.3");
    expect(Money.of("0.1", "USD").plus(Money.of("0.2", "USD")).toString()).toBe("0.30");
  });

  it("subtraction that a float would get wrong", () => {
    // 1.005 - 1.00 === 0.004999999999999893 as doubles.
    expect(decSub("1.005", "1.00").toString()).toBe("0.005");
    expect(decSub("0.3", "0.1").toString()).toBe("0.2");
  });

  it("a long chain of additions does not drift", () => {
    // 1000 × 0.01 is exactly 10 in decimal and demonstrably not in binary floating point.
    const parts = Array.from({ length: 1000 }, () => "0.01");
    expect(decSum(parts).toString()).toBe("10");

    let float = 0;
    for (let i = 0; i < 1000; i += 1) float += 0.01;
    expect(float).not.toBe(10); // the very drift this suite exists to prevent
  });

  it("sums a realistic ledger exactly", () => {
    const lines = ["1840000.0000", "48250.0000", "265000.0000", "0.0001", "-113250.5000"];
    expect(decSum(lines).toString()).toBe("2039999.5001");
  });

  it("many decimal positions are preserved through addition", () => {
    expect(decSum(["0.000001", "0.000002", "0.000003"]).toString()).toBe("0.000006");
  });
});

describe("F-005 — currency scale and rounding", () => {
  it("applies the right scale per currency class", () => {
    expect(currencyScale("LKR")).toBe(2);
    expect(currencyScale("USD")).toBe(2);
    expect(currencyScale("JPY")).toBe(0); // zero-decimal
    expect(currencyScale("KWD")).toBe(3); // three-decimal
  });

  it("formats to the currency's scale, not a fixed 2", () => {
    expect(Money.of("14500", "LKR").toString()).toBe("14500.00");
    expect(Money.of("1000", "JPY").toString()).toBe("1000");
    expect(Money.of("1.5", "KWD").toString()).toBe("1.500");
  });

  it("rounds half-to-even (bankers'), so repeated rounding does not drift upward", () => {
    expect(Money.of("2.125", "USD").round().toString()).toBe("2.12");
    expect(Money.of("2.135", "USD").round().toString()).toBe("2.14");
    expect(Money.of("2.145", "USD").round().toString()).toBe("2.14");
    expect(Money.of("2.155", "USD").round().toString()).toBe("2.16");
  });

  it("a zero-decimal currency does not acquire cents", () => {
    expect(Money.of("1000", "JPY").plus(Money.of("1", "JPY")).toString()).toBe("1001");
  });
});

describe("F-005 — parsing and line totals", () => {
  it("parses a user-entered amount exactly, and rejects float-y input", () => {
    expect(parseMoneyInput("1234.56", "LKR")?.toString()).toBe("1234.56");
    expect(parseMoneyInput("1e5", "LKR")).toBeNull();
    expect(parseMoneyInput("abc", "LKR")).toBeNull();
    expect(parseMoneyInput("", "LKR")).toBeNull();
  });

  it("computes a line total exactly at awkward quantities", () => {
    // 0.1 × 3 is 0.30000000000000004 in binary floating point.
    expect(lineTotal(Money.of("0.1", "USD"), 3).toString()).toBe("0.30");
    expect(lineTotal(Money.of("19.99", "USD"), 7).toString()).toBe("139.93");
    expect(lineTotal(Money.of("1840000.00", "LKR"), 1).toString()).toBe("1840000.00");
  });

  it("formats for the UI without going through a float", () => {
    expect(fmtMoney("1840000.00", "LKR")).toContain("1,840,000");
    expect(fmtMoney("0.0001", "LKR")).not.toContain("e");
  });
});

describe("F-005 — the value is identical at every stage of the path", () => {
  it("parse -> validate -> persist-shape -> read-shape -> calculate -> format", () => {
    // One value carried through the whole finance path, compared EXACTLY at each stage.
    const entered = "1840000.5001";

    const parsed = parseMoneyInput(entered, "LKR");
    expect(parsed).not.toBeNull();

    // What would be written to a `numeric` column.
    const persisted = parsed!.toRawString();
    expect(new Decimal(persisted).eq(new Decimal(entered))).toBe(true);

    // What PostgREST hands back when the column is read AS TEXT (the recommended path).
    const readBack = dec(persisted);
    expect(readBack.eq(new Decimal(entered))).toBe(true);

    // Arithmetic on it.
    const doubled = readBack.plus(readBack);
    expect(doubled.toString()).toBe("3680001.0002");

    // And the rounded, presented value.
    expect(Money.of(readBack, "LKR").round().toString()).toBe("1840000.50");
  });

  it("the SAME value routed through a double is refused, not quietly degraded", () => {
    // This is the difference the fix makes. Before, the corrupted double was accepted.
    const lossy = Number("99999999999999.9999");
    expect(String(lossy)).toBe("100000000000000"); // the loss, demonstrated
    expect(() => dec(lossy)).toThrow(/too large to be exact/);
  });
});
