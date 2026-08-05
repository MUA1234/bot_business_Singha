import { describe, it, expect } from "vitest";
import { remaining, settlementStatus, canSettle } from "@/accounting/settlement";

describe("settlement (change plan §8.3, decimal §8)", () => {
  it("computes remaining, floored at zero", () => {
    expect(remaining("1000.00", "300.00", "LKR")).toBe("700.00");
    expect(remaining("1000.00", "0", "LKR")).toBe("1000.00");
    expect(remaining("1000.00", "1200.00", "LKR")).toBe("0.00");
  });

  it("derives status", () => {
    expect(settlementStatus("1000", "0", "LKR")).toBe("unpaid");
    expect(settlementStatus("1000", "400", "LKR")).toBe("part_paid");
    expect(settlementStatus("1000", "1000", "LKR")).toBe("paid");
  });

  it("guards a settlement amount", () => {
    expect(canSettle("1000", "0", "1000", "LKR")).toBe(true);
    expect(canSettle("1000", "700", "300", "LKR")).toBe(true);
    expect(canSettle("1000", "700", "301", "LKR")).toBe(false); // exceeds outstanding
    expect(canSettle("1000", "0", "0", "LKR")).toBe(false); // non-positive
    expect(canSettle("1000", "0", "abc", "LKR")).toBe(false); // not a number
  });
});
