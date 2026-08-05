import { describe, it, expect } from "vitest";
import { bucketFor, ageItems, type AgingItem } from "@/modules/finance/aging";

const ASOF = new Date("2026-08-05T00:00:00Z");
const iso = (days: number) => new Date(ASOF.getTime() + days * 86_400_000).toISOString().slice(0, 10);

describe("AR/AP ageing (change plan §8.3, decimal money §8)", () => {
  it("buckets by days overdue", () => {
    expect(bucketFor(null, ASOF)).toBe("current");
    expect(bucketFor(iso(5), ASOF)).toBe("current"); // future due
    expect(bucketFor(iso(-10), ASOF)).toBe("d1_30");
    expect(bucketFor(iso(-45), ASOF)).toBe("d31_60");
    expect(bucketFor(iso(-75), ASOF)).toBe("d61_90");
    expect(bucketFor(iso(-120), ASOF)).toBe("d90_plus");
  });

  it("sums outstanding into buckets with exact decimals", () => {
    const items: AgingItem[] = [
      { dueDate: iso(10), outstanding: "1000.00" }, // current
      { dueDate: iso(-5), outstanding: "250.50" }, // 1-30
      { dueDate: iso(-40), outstanding: "99.49" }, // 31-60
      { dueDate: iso(-200), outstanding: "500.00" }, // 90+
    ];
    const r = ageItems(items, "LKR", ASOF);
    expect(r.buckets.current).toBe("1000.00");
    expect(r.buckets.d1_30).toBe("250.50");
    expect(r.buckets.d31_60).toBe("99.49");
    expect(r.buckets.d90_plus).toBe("500.00");
    expect(r.total).toBe("1849.99");
    expect(r.overdue).toBe("849.99");
  });

  it("ignores zero/negative (settled) balances", () => {
    const r = ageItems(
      [
        { dueDate: iso(-10), outstanding: "0" },
        { dueDate: iso(-10), outstanding: "-5.00" },
        { dueDate: iso(-10), outstanding: "10.00" },
      ],
      "LKR",
      ASOF,
    );
    expect(r.total).toBe("10.00");
  });

  it("empty list totals zero, not a throw", () => {
    const r = ageItems([], "LKR", ASOF);
    expect(r.total).toBe("0.00");
    expect(r.overdue).toBe("0.00");
  });
});
