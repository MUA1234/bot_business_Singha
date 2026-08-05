import { describe, it, expect } from "vitest";
import { taxAmount, grossFromNet, netFromGross } from "@/accounting/tax";
import { cashVariance } from "@/modules/finance/petty-cash";

describe("tax (change plan §8.3, decimal §8)", () => {
  it("computes tax on a net amount", () => {
    expect(taxAmount("1000.00", 15, "LKR")).toBe("150.00");
    expect(taxAmount("200.00", 7.5, "LKR")).toBe("15.00");
  });

  it("gross = net + tax; net back-calculates from gross", () => {
    expect(grossFromNet("1000.00", 15, "LKR")).toBe("1150.00");
    expect(netFromGross("1150.00", 15, "LKR")).toBe("1000.00");
  });
});

describe("petty cash variance (§8.3)", () => {
  it("surplus and shortage", () => {
    expect(cashVariance("1050.00", "1000.00", "LKR")).toBe("50.00");
    expect(cashVariance("950.00", "1000.00", "LKR")).toBe("-50.00");
    expect(cashVariance("1000.00", "1000.00", "LKR")).toBe("0.00");
  });
});
