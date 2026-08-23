/**
 * RSK-002 — Contracts register with renewal dates.
 *
 * The legal contracts page must be a real runtime entrypoint that lists
 * company-scoped contracts with renewal dates and surfaces renewal status.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/legal/contracts/page.tsx";

describe("RSK-002 — contracts register surface", () => {
  const page = readFileSync(PAGE, "utf8");

  it("has a real runtime entrypoint under /app/legal/contracts", () => {
    expect(page).toContain("export default async function ContractsPage");
  });

  it("queries the contracts table", () => {
    expect(page).toContain('from("contracts")');
  });

  it("is company-scoped", () => {
    expect(page).toContain("requireDepartment(\"legal\")");
    expect(page).toContain("company_id");
  });

  it("renders renewal dates and status", () => {
    expect(page).toContain("renewal_date");
    expect(page).toContain("renewalStatus");
    expect(page).toMatch(/Renewal/);
  });

  it("shows contract lifecycle status", () => {
    expect(page).toContain("status");
    expect(page).toMatch(/All contracts/);
  });
});
