import { describe, it, expect } from "vitest";
import { compareQuotations, type Quotation } from "@/modules/procurement/quote-comparison";

describe("quote comparison (change plan §9.2)", () => {
  const quotes: Quotation[] = [
    { id: "a", supplierName: "Acme", total: "1500.00", leadTimeDays: 5 },
    { id: "b", supplierName: "Best", total: "1200.00", leadTimeDays: 10 },
    { id: "c", supplierName: "Cheap", total: "1200.00", leadTimeDays: 3 },
  ];

  it("ranks cheapest first, lead time as tiebreak", () => {
    const c = compareQuotations(quotes, "LKR");
    expect(c.ranked.map((r) => r.id)).toEqual(["c", "b", "a"]); // 1200/3d, 1200/10d, 1500
    expect(c.cheapestId).toBe("c");
    expect(c.ranked[0]!.isCheapest).toBe(true);
  });

  it("computes the saving vs the most expensive", () => {
    expect(compareQuotations(quotes, "LKR").saving).toBe("300.00");
  });

  it("empty comparison is safe", () => {
    const c = compareQuotations([], "LKR");
    expect(c.cheapestId).toBe(null);
    expect(c.saving).toBe("0");
  });
});
