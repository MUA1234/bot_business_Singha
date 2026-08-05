import { describe, it, expect } from "vitest";
import { parseBankLines } from "@/modules/finance/bank-import";

describe("bank import parser (change plan §8.3)", () => {
  it("parses valid lines, keeping commas in the description", () => {
    const { rows, errors } = parseBankLines("2026-08-05, -1500.00, Payment to Acme, Ltd\n2026-08-06, 2000, Receipt");
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ date: "2026-08-05", amount: "-1500.00", description: "Payment to Acme, Ltd" });
    expect(rows[1]!.amount).toBe("2000");
  });

  it("reports bad dates and amounts per line", () => {
    const { rows, errors } = parseBankLines("05/08/2026, 100, x\n2026-08-06, abc, y");
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/bad date/);
    expect(errors[1]).toMatch(/bad amount/);
  });

  it("flags lines missing fields and ignores blanks", () => {
    const { rows, errors } = parseBankLines("2026-08-05 100 no-commas\n\n   \n2026-08-05, 100, ok");
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});
