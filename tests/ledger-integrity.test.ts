import { describe, it, expect } from "vitest";
import { findUnbalancedJournals } from "@/modules/finance/ledger-integrity";

describe("findUnbalancedJournals (§WP6.5)", () => {
  it("returns nothing when every journal balances", () => {
    const lines = [
      { journal_id: "j1", debit: "100.00", credit: "0" },
      { journal_id: "j1", debit: "0", credit: "100.00" },
      { journal_id: "j2", debit: "50", credit: null },
      { journal_id: "j2", debit: null, credit: "50" },
    ];
    expect(findUnbalancedJournals(lines)).toEqual([]);
  });

  it("flags an unbalanced journal", () => {
    const lines = [
      { journal_id: "bad", debit: "100.00", credit: "0" },
      { journal_id: "bad", debit: "0", credit: "90.00" },
      { journal_id: "ok", debit: "10", credit: "0" },
      { journal_id: "ok", debit: "0", credit: "10" },
    ];
    expect(findUnbalancedJournals(lines)).toEqual(["bad"]);
  });

  it("uses decimal math (no float drift)", () => {
    const lines = [
      { journal_id: "j", debit: "0.10", credit: "0" },
      { journal_id: "j", debit: "0.20", credit: "0" },
      { journal_id: "j", debit: "0", credit: "0.30" },
    ];
    expect(findUnbalancedJournals(lines)).toEqual([]);
  });

  it("tolerates malformed values as zero", () => {
    const lines = [
      { journal_id: "j", debit: "abc" as any, credit: "0" },
      { journal_id: "j", debit: "0", credit: "0" },
    ];
    expect(findUnbalancedJournals(lines)).toEqual([]); // both sides 0
  });
});
