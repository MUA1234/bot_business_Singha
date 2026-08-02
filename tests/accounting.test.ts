import { describe, it, expect } from "vitest";
import { buildPostedJournal, buildReversal, type PostedJournal } from "@/accounting/journal";
import { trialBalance, profitAndLoss, balanceSheet } from "@/accounting/trial-balance";
import { journalPostingInput, type JournalPostingInput } from "@/schemas/posting";
import { makeLedgerContext } from "./helpers/ledger";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const ctx = makeLedgerContext({
  companyId: COMPANY,
  accounts: [
    { code: "1100", type: "asset" }, // Bank
    { code: "2100", type: "liability" }, // Reimbursements payable
    { code: "3000", type: "equity" }, // Equity
    { code: "4000", type: "income" }, // Sales
    { code: "5000", type: "expense" }, // Fuel
    { code: "9999", type: "expense", active: false }, // inactive
  ],
  closedBefore: "2026-01-01", // anything in 2025 or earlier is closed
});

function post(input: Partial<JournalPostingInput> & { lines: JournalPostingInput["lines"] }): JournalPostingInput {
  return journalPostingInput.parse({
    contract_version: "1.0",
    company_id: COMPANY,
    currency: "LKR",
    posting_date: "2026-07-30",
    correlation_id: "corr_test",
    idempotency_key: `idem_${Math.random()}`,
    ...input,
  });
}

describe("Accounting Core — posting invariants (guide §9)", () => {
  it("posts a balanced journal", () => {
    const r = buildPostedJournal(
      post({ lines: [
        { account_code: "1100", debit: "100000.00", credit: "0" } as never,
        { account_code: "3000", debit: "0", credit: "100000.00" } as never,
      ] }),
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.total_debit).toBe("100000.00");
      expect(r.value.immutable).toBe(true);
    }
  });

  it("rejects an unbalanced journal", () => {
    const r = buildPostedJournal(
      post({ lines: [
        { account_code: "1100", debit: "100.00", credit: "0" } as never,
        { account_code: "3000", debit: "0", credit: "99.00" } as never,
      ] }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("UNBALANCED");
  });

  it("rejects posting into a closed period", () => {
    const r = buildPostedJournal(
      post({ posting_date: "2025-12-31", lines: [
        { account_code: "1100", debit: "10.00", credit: "0" } as never,
        { account_code: "3000", debit: "0", credit: "10.00" } as never,
      ] }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PERIOD_CLOSED");
  });

  it("rejects an unknown or inactive account", () => {
    const unknown = buildPostedJournal(
      post({ lines: [
        { account_code: "0000", debit: "10.00", credit: "0" } as never,
        { account_code: "3000", debit: "0", credit: "10.00" } as never,
      ] }),
      ctx,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("ACCOUNT_NOT_FOUND");

    const inactive = buildPostedJournal(
      post({ lines: [
        { account_code: "9999", debit: "10.00", credit: "0" } as never,
        { account_code: "3000", debit: "0", credit: "10.00" } as never,
      ] }),
      ctx,
    );
    expect(inactive.ok).toBe(false);
    if (!inactive.ok) expect(inactive.error.code).toBe("ACCOUNT_INACTIVE");
  });

  it("builds a reversal that swaps debit/credit and references the original", () => {
    const orig = buildPostedJournal(
      post({ lines: [
        { account_code: "5000", debit: "14500.00", credit: "0" } as never,
        { account_code: "2100", debit: "0", credit: "14500.00" } as never,
      ] }),
      ctx,
    );
    expect(orig.ok).toBe(true);
    if (!orig.ok) return;
    const rev = buildReversal(
      orig.value,
      { reversalDate: "2026-07-31", correlationId: "corr_rev", idempotencyKey: "idem_rev", originalJournalId: "J-ORIG" },
      ctx,
    );
    expect(rev.ok).toBe(true);
    if (rev.ok) {
      expect(rev.value.reversal_of_journal_id).toBe("J-ORIG");
      expect(rev.value.lines[0]?.credit).toBe("14500.00"); // was a debit
      expect(rev.value.lines[1]?.debit).toBe("14500.00"); // was a credit
    }
  });
});

describe("Accounting golden dataset — statements reconcile to the ledger (guide §15)", () => {
  const journals: PostedJournal[] = [];
  const scenarios: [string, JournalPostingInput["lines"]][] = [
    ["opening balance", [
      { account_code: "1100", debit: "100000.00", credit: "0" } as never,
      { account_code: "3000", debit: "0", credit: "100000.00" } as never,
    ]],
    ["cash sale", [
      { account_code: "1100", debit: "50000.00", credit: "0" } as never,
      { account_code: "4000", debit: "0", credit: "50000.00" } as never,
    ]],
    ["employee-paid fuel → reimbursement payable", [
      { account_code: "5000", debit: "14500.00", credit: "0" } as never,
      { account_code: "2100", debit: "0", credit: "14500.00" } as never,
    ]],
    ["pay the reimbursement from bank", [
      { account_code: "2100", debit: "14500.00", credit: "0" } as never,
      { account_code: "1100", debit: "0", credit: "14500.00" } as never,
    ]],
  ];

  it("posts every golden journal", () => {
    for (const [, lines] of scenarios) {
      const r = buildPostedJournal(post({ lines }), ctx);
      expect(r.ok).toBe(true);
      if (r.ok) journals.push(r.value);
    }
    expect(journals).toHaveLength(4);
  });

  it("produces a balanced trial balance", () => {
    const tb = trialBalance(journals, "LKR");
    expect(tb.balanced).toBe(true);
    expect(tb.total_debit).toBe("150000.00");
    expect(tb.total_credit).toBe("150000.00");
  });

  it("computes P&L", () => {
    const pnl = profitAndLoss(trialBalance(journals, "LKR"));
    expect(pnl.income).toBe("50000.00");
    expect(pnl.expense).toBe("14500.00");
    expect(pnl.net_profit).toBe("35500.00");
  });

  it("balance sheet balances (A = L + E incl. retained profit)", () => {
    const bs = balanceSheet(trialBalance(journals, "LKR"));
    expect(bs.assets).toBe("135500.00");
    expect(bs.liabilities).toBe("0.00");
    expect(bs.equity).toBe("135500.00");
    expect(bs.balances).toBe(true);
  });
});
