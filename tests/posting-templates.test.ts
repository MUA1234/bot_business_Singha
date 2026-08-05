import { describe, it, expect } from "vitest";
import { balancedPair, invoicePostingLines, billPostingLines } from "@/accounting/posting-templates";
import { checkDraftJournal } from "@/accounting/manual-entry";

describe("posting templates (change plan §8.3)", () => {
  it("balancedPair produces a balanced, postable pair", () => {
    const lines = balancedPair("1100", "4000", "1500.00", "Invoice INV-1");
    const check = checkDraftJournal(lines, "LKR");
    expect(check.ready).toBe(true);
    expect(check.balanced).toBe(true);
    expect(check.totalDebit).toBe("1500.00");
  });

  it("invoice: debit receivable, credit income", () => {
    const [dr, cr] = invoicePostingLines("1100", "4000", "999.00");
    expect(dr!.account_code).toBe("1100");
    expect(dr!.debit).toBe("999.00");
    expect(cr!.account_code).toBe("4000");
    expect(cr!.credit).toBe("999.00");
  });

  it("bill: debit expense, credit payable", () => {
    const [dr, cr] = billPostingLines("6000", "2100", "250.00");
    expect(dr!.account_code).toBe("6000");
    expect(cr!.account_code).toBe("2100");
    expect(checkDraftJournal(billPostingLines("6000", "2100", "250.00"), "LKR").balanced).toBe(true);
  });
});
