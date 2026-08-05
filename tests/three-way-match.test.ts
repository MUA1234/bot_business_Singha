import { describe, it, expect } from "vitest";
import { threeWayMatch } from "@/modules/procurement/three-way-match";

describe("three-way match (change plan §9.2)", () => {
  it("clean match passes", () => {
    const r = threeWayMatch({
      currency: "LKR", poQuantity: 10, poAmount: "1000.00",
      receivedQuantity: 10, billedQuantity: 10, billedAmount: "1000.00",
    });
    expect(r.matched).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("flags over-receipt", () => {
    const r = threeWayMatch({
      currency: "LKR", poQuantity: 10, poAmount: "1000.00",
      receivedQuantity: 12, billedQuantity: 10, billedAmount: "1000.00",
    });
    expect(r.matched).toBe(false);
    expect(r.issues.join(" ")).toMatch(/over-receipt/);
  });

  it("flags over-billing beyond received", () => {
    const r = threeWayMatch({
      currency: "LKR", poQuantity: 10, poAmount: "1000.00",
      receivedQuantity: 6, billedQuantity: 10, billedAmount: "1000.00",
    });
    expect(r.matched).toBe(false);
    expect(r.issues.join(" ")).toMatch(/over-billing/);
  });

  it("flags price variance over tolerance", () => {
    const r = threeWayMatch({
      currency: "LKR", poQuantity: 10, poAmount: "1000.00",
      receivedQuantity: 10, billedQuantity: 10, billedAmount: "1100.00",
      amountTolerancePct: 0.05,
    });
    expect(r.matched).toBe(false);
    expect(r.issues.join(" ")).toMatch(/price variance/);
  });

  it("accepts price within tolerance", () => {
    const r = threeWayMatch({
      currency: "LKR", poQuantity: 10, poAmount: "1000.00",
      receivedQuantity: 10, billedQuantity: 10, billedAmount: "1020.00",
      amountTolerancePct: 0.05,
    });
    expect(r.matched).toBe(true);
  });
});
