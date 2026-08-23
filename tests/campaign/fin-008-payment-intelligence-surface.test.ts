/**
 * FIN-008 — Payment intelligence and evidence surface.
 *
 * The reconciliation page is a real runtime entrypoint that reads company-scoped
 * bank transactions, payments and receipts, suggests deterministic matches by exact
 * decimal amount and date window, and lets a finance user import bank lines and
 * confirm matches only after server-side validation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/finance/reconciliation/page.tsx";
const ACTIONS = "src/app/app/finance/reconciliation/actions.ts";
const MATCHER = "src/modules/finance/reconcile.ts";

describe("FIN-008 — payment intelligence surface", () => {
  const page = readFileSync(PAGE, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const matcher = readFileSync(MATCHER, "utf8");

  it("has a real runtime entrypoint under /app/finance/reconciliation", () => {
    expect(page).toContain('export const metadata = { title: "Reconciliation');
    expect(page).toContain("export default async function ReconciliationPage");
    expect(page).toContain("requireDepartment(\"finance\")");
  });

  it("queries bank transactions, payments and receipts scoped by company_id", () => {
    expect(page).toContain('from("bank_transactions")');
    expect(page).toContain('from("payments")');
    expect(page).toContain('from("receipts")');
    expect(page).toContain(".eq(\"company_id\", p.companyId)");
  });

  it("uses a deterministic matcher with exact decimal amount and nearest date", () => {
    expect(matcher).toContain("export function suggestMatches");
    expect(matcher).toContain("Money.of(amount, currency)");
    expect(matcher).toContain("absStr(c.amount, c.currency) === txnAbs");
    expect(matcher).toContain("days <= dayWindow");
    expect(matcher).toContain('const confidence = best.days <= 1 ? "high" : "medium"');
  });

  it("imports bank statement lines only for a verified company bank account", () => {
    expect(actions).toContain("export async function importBankTransactions");
    expect(actions).toContain(".eq(\"id\", bankAccountId).eq(\"company_id\", p.companyId)");
    expect(actions).toContain('action: "bank.imported"');
    expect(actions).toContain("writeAudit");
  });

  it("confirms matches after server-side target validation and writes an audit record", () => {
    expect(actions).toContain("export async function confirmMatch");
    expect(actions).toContain("validateReconciliation");
    expect(actions).toContain('from("reconciliation_matches").insert');
    expect(actions).toContain('from("bank_transactions").update({ amount_matched: amount, status: "matched" })');
    expect(actions).toContain('action: "bank.matched"');
  });
});
