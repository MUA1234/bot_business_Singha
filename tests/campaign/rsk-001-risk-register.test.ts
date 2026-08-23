/**
 * RSK-001 — Risk register surface.
 *
 * The legal risks page is a real runtime entrypoint that lists company-scoped risks
 * with owner, mitigation, evidence and review dates, and provides an audited create
 * action guarded to the legal department.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/legal/risks/page.tsx";
const ACTIONS = "src/app/app/legal/risks/actions.ts";
const HOME = "src/app/app/legal/page.tsx";
const MIGRATION = "src/db/migrations/0093_risk_register.sql";

describe("RSK-001 — Risk register surface", () => {
  const page = readFileSync(PAGE, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const home = readFileSync(HOME, "utf8");
  const migration = readFileSync(MIGRATION, "utf8");

  it("has a real runtime entrypoint under /app/legal/risks", () => {
    expect(page).toContain('export const metadata = { title: "Risks');
    expect(page).toContain("export default async function RisksPage");
    expect(page).toContain("requireDepartment(\"legal\")");
  });

  it("reads risks scoped by company_id with owner, mitigation, evidence and review dates", () => {
    expect(page).toContain('from("risks")');
    expect(page).toContain(".eq(\"company_id\", p.companyId)");
    expect(page).toContain("owner_id");
    expect(page).toContain("mitigation");
    expect(page).toContain("evidence");
    expect(page).toContain("review_date");
  });

  it("has a company-scoped risks table with capability-gated RLS in the migration", () => {
    expect(migration).toContain("create table if not exists risks");
    expect(migration).toContain("company_id uuid not null references companies(id) on delete cascade");
    expect(migration).toContain("alter table risks enable row level security");
    expect(migration).toContain("risks_read on risks for select using");
    expect(migration).toContain("legal.risk.manage");
    expect(migration).toContain("has_capability(company_id, 'legal.risk.manage')");
  });

  it("provides an audited create action gated to legal", () => {
    expect(actions).toContain("export async function createRisk");
    expect(actions).toContain('if (!p.isAdmin && p.department !== "legal") throw new Error("Not allowed")');
    expect(actions).toContain('.from("risks")');
    expect(actions).toContain("company_id: p.companyId");
    expect(actions).toContain('action: "risk.created"');
    expect(actions).toContain("writeAudit");
  });

  it("is linked from the legal home with an open-risks count", () => {
    expect(home).toContain('href="/app/legal/risks"');
    expect(home).toContain('from("risks")');
    expect(home).toContain("Open risks");
  });
});
