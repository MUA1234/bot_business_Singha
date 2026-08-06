import { describe, it, expect } from "vitest";
import { validateReconciliation, type ReconInput } from "@/modules/finance/reconcile-validate";

const CO = "co-a";
const base = (over: Partial<ReconInput> = {}): ReconInput => ({
  callerCompanyId: CO,
  bankTxn: { companyId: CO, currency: "LKR", amount: "1000.00" }, // credit
  target: { type: "receipt", companyId: CO, currency: "LKR", amount: "1000.00" },
  matchAmount: "1000.00",
  ...over,
});

describe("validateReconciliation (§WP2.7)", () => {
  it("accepts a valid same-company, same-currency, in-direction match", () => {
    expect(validateReconciliation(base()).ok).toBe(true);
  });

  it("rejects a target in another company (browser-supplied id injection)", () => {
    expect(validateReconciliation(base({ target: { type: "receipt", companyId: "co-b", currency: "LKR", amount: "1000.00" } })).ok).toBe(false);
  });

  it("rejects a bank txn from another company", () => {
    expect(validateReconciliation(base({ bankTxn: { companyId: "co-b", currency: "LKR", amount: "1000" } })).ok).toBe(false);
  });

  it("rejects a currency mismatch", () => {
    expect(validateReconciliation(base({ target: { type: "receipt", companyId: CO, currency: "USD", amount: "1000" } })).ok).toBe(false);
  });

  it("rejects an amount over the bank transaction", () => {
    expect(validateReconciliation(base({ matchAmount: "2000.00" })).ok).toBe(false);
  });

  it("rejects an amount over the target's remaining", () => {
    expect(validateReconciliation(base({ target: { type: "receipt", companyId: CO, currency: "LKR", amount: "500.00" } })).ok).toBe(false);
  });

  it("rejects a non-positive amount", () => {
    expect(validateReconciliation(base({ matchAmount: "0" })).ok).toBe(false);
    expect(validateReconciliation(base({ matchAmount: "-5" })).ok).toBe(false);
  });

  it("enforces direction: receipt needs a credit, payment needs a debit", () => {
    // receipt against a debit → reject
    expect(validateReconciliation(base({ bankTxn: { companyId: CO, currency: "LKR", amount: "-1000" } })).ok).toBe(false);
    // payment against a debit → ok
    expect(
      validateReconciliation({
        callerCompanyId: CO,
        bankTxn: { companyId: CO, currency: "LKR", amount: "-1000" },
        target: { type: "payment", companyId: CO, currency: "LKR", amount: "1000" },
        matchAmount: "1000",
      }).ok,
    ).toBe(true);
    // payment against a credit → reject
    expect(
      validateReconciliation({
        callerCompanyId: CO,
        bankTxn: { companyId: CO, currency: "LKR", amount: "1000" },
        target: { type: "payment", companyId: CO, currency: "LKR", amount: "1000" },
        matchAmount: "1000",
      }).ok,
    ).toBe(false);
  });

  it("still enforces company + amount when target currency/amount are unknown (journal_line)", () => {
    const r = validateReconciliation({
      callerCompanyId: CO,
      bankTxn: { companyId: CO, currency: "LKR", amount: "1000" },
      target: { type: "journal_line", companyId: CO },
      matchAmount: "500",
    });
    expect(r.ok).toBe(true);
  });
});
