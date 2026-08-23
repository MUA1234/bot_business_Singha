/**
 * RSK-004 — Insurance register surface.
 *
 * The legal insurances page is a real runtime entrypoint that lists company-scoped
 * insurance policies with cover, expiry and renewal flags, and provides an audited
 * create action guarded to the legal department.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/legal/insurances/page.tsx";
const ACTIONS = "src/app/app/legal/insurances/actions.ts";
const HOME = "src/app/app/legal/page.tsx";
const MIGRATION = "src/db/migrations/0094_insurance_register.sql";

describe("RSK-004 — Insurance register surface", () => {
  const page = readFileSync(PAGE, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const home = readFileSync(HOME, "utf8");
  const migration = readFileSync(MIGRATION, "utf8");

  it("has a real runtime entrypoint under /app/legal/insurances", () => {
    expect(page).toContain('export const metadata = { title: "Insurances');
    expect(page).toContain("export default async function InsurancesPage");
    expect(page).toContain("requireDepartment(\"legal\")");
  });

  it("reads insurances scoped by company_id with cover, expiry and status", () => {
    expect(page).toContain('from("insurances")');
    expect(page).toContain(".eq(\"company_id\", p.companyId)");
    expect(page).toContain("cover_amount");
    expect(page).toContain("expiry_date");
    expect(page).toContain("status");
  });

  it("has a company-scoped insurances table with capability-gated RLS in the migration", () => {
    expect(migration).toContain("create table if not exists insurances");
    expect(migration).toContain("company_id uuid not null references companies(id) on delete cascade");
    expect(migration).toContain("alter table insurances enable row level security");
    expect(migration).toContain("insurances_read on insurances for select using");
    expect(migration).toContain("legal.insurance.manage");
    expect(migration).toContain("has_capability(company_id, 'legal.insurance.manage')");
  });

  it("provides an audited create action gated to legal", () => {
    expect(actions).toContain("export async function createInsurance");
    expect(actions).toContain('if (!p.isAdmin && p.department !== "legal") throw new Error("Not allowed")');
    expect(actions).toContain('.from("insurances")');
    expect(actions).toContain("company_id: p.companyId");
    expect(actions).toContain('action: "insurance.created"');
    expect(actions).toContain("writeAudit");
  });

  it("is linked from the legal home with an active-insurances count", () => {
    expect(home).toContain('href="/app/legal/insurances"');
    expect(home).toContain('from("insurances")');
    expect(home).toContain("Active insurances");
  });
});
