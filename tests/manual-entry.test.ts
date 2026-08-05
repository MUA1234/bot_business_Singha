import { describe, it, expect } from "vitest";
import { checkDraftJournal, type DraftLine } from "@/accounting/manual-entry";

describe("manual journal draft check (change plan §8.2, decimal §8)", () => {
  it("accepts a balanced two-line entry", () => {
    const lines: DraftLine[] = [
      { account_code: "1000", debit: "1500.00", credit: "" },
      { account_code: "4000", debit: "", credit: "1500.00" },
    ];
    const r = checkDraftJournal(lines, "LKR");
    expect(r.balanced).toBe(true);
    expect(r.ready).toBe(true);
    expect(r.totalDebit).toBe("1500.00");
    expect(r.issues).toEqual([]);
  });

  it("rejects an unbalanced entry", () => {
    const r = checkDraftJournal([
      { account_code: "1000", debit: "1000", credit: "" },
      { account_code: "4000", debit: "", credit: "900" },
    ], "LKR");
    expect(r.balanced).toBe(false);
    expect(r.ready).toBe(false);
  });

  it("rejects a line with both debit and credit", () => {
    const r = checkDraftJournal([
      { account_code: "1000", debit: "100", credit: "100" },
      { account_code: "4000", debit: "", credit: "100" },
    ], "LKR");
    expect(r.issues.join(" ")).toMatch(/both a debit and a credit/);
  });

  it("requires at least two priced lines", () => {
    const r = checkDraftJournal([{ account_code: "1000", debit: "100", credit: "" }], "LKR");
    expect(r.ready).toBe(false);
    expect(r.issues.join(" ")).toMatch(/at least two lines/);
  });
});
