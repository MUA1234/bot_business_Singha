/**
 * FIN-005 — Taxes and professional-review opportunities.
 *
 * The finance tax-codes page must be a real runtime entrypoint that lists
 * company-scoped tax rates and uses the deterministic tax engine to surface the
 * tax on a sample amount. Routing uncertain cases to a finance reviewer remains
 * out of scope.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/finance/tax-codes/page.tsx";

describe("FIN-005 — tax codes surface", () => {
  const page = readFileSync(PAGE, "utf8");

  it("has a real runtime entrypoint under /app/finance/tax-codes", () => {
    expect(page).toContain("export default async function TaxCodesPage");
  });

  it("queries the tax_codes table scoped to the company", () => {
    expect(page).toContain('from("tax_codes")');
    expect(page).toContain("company_id");
  });

  it("uses the deterministic tax engine", () => {
    expect(page).toContain('from "@/accounting/tax"');
    expect(page).toContain("taxAmount");
  });

  it("surfaces code, name, rate and sample tax amount", () => {
    expect(page).toMatch(/Tax Codes|Tax codes/);
    expect(page).toContain("code");
    expect(page).toContain("name");
    expect(page).toContain("rate");
    expect(page).toContain("fmtMoney");
  });

  it("is gated behind the finance department and supports create action", () => {
    expect(page).toContain('requireDepartment("finance")');
    expect(page).toContain("createTaxCode");
  });
});
