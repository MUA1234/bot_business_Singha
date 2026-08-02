import { describe, it, expect } from "vitest";
import {
  bankLineFingerprint,
  suggestMatches,
  validateMatch,
  availableToMatch,
  type BankTxn,
  type LedgerItem,
} from "@/accounting/reconciliation";

describe("Bank reconciliation (guide §9, §14)", () => {
  const bankTxn: BankTxn = {
    id: "b1",
    txn_date: "2026-07-30",
    description: "PAYMENT ABC TRADERS",
    amount: "-14500.00", // outflow
    currency: "LKR",
    amount_matched: "0",
  };

  const ledger: LedgerItem[] = [
    { id: "p1", kind: "payment", date: "2026-07-29", amount: "-14500.00", currency: "LKR", counterparty: "ABC Traders", amount_matched: "0" },
    { id: "p2", kind: "payment", date: "2026-07-01", amount: "-9000.00", currency: "LKR", counterparty: "Other", amount_matched: "0" },
    { id: "r1", kind: "receipt", date: "2026-07-30", amount: "14500.00", currency: "LKR", counterparty: "ABC Traders", amount_matched: "0" }, // wrong sign
  ];

  it("suggests the correct 1:1 match highest", () => {
    const matches = suggestMatches(bankTxn, ledger);
    expect(matches[0]?.ledger_item_id).toBe("p1");
    expect(matches[0]?.amount).toBe("14500.00");
    // opposite-sign receipt must never be suggested
    expect(matches.find((m) => m.ledger_item_id === "r1")).toBeUndefined();
  });

  it("computes available-to-match after a partial", () => {
    const partial = { amount: "-14500.00", amount_matched: "-4500.00" };
    expect(availableToMatch(partial, "LKR").toString()).toBe("10000.00");
  });

  it("rejects a match that exceeds available amount (no double reconcile)", () => {
    const err = validateMatch(bankTxn, ledger[0]!, "20000.00");
    expect(err).toMatch(/exceeds/i);
    expect(validateMatch(bankTxn, ledger[0]!, "14500.00")).toBeNull();
  });

  it("rejects a currency mismatch", () => {
    const usd: LedgerItem = { ...ledger[0]!, currency: "USD" };
    expect(validateMatch(bankTxn, usd, "10.00")).toMatch(/currency/i);
  });

  it("fingerprints identical statement lines the same (re-import dedup)", () => {
    const row = { txn_date: "2026-07-30", amount: "-14500.00", currency: "LKR", description: "PAYMENT  ABC   TRADERS" };
    const row2 = { txn_date: "2026-07-30", amount: "-14500.00", currency: "LKR", description: "payment abc traders" };
    expect(bankLineFingerprint(row)).toBe(bankLineFingerprint(row2));
  });
});
