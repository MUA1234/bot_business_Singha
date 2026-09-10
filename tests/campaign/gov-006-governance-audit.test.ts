/**
 * GOV-006 — Governance audit trail surface.
 *
 * The admin audit log is a real runtime entrypoint that records and lets a human
 * search the governance story: directives, acknowledgements, approvals, overrides
 * and other privileged decisions. It stays company-scoped and read-only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/admin/audit/page.tsx";

describe("GOV-006 — Governance audit trail surface", () => {
  const page = readFileSync(PAGE, "utf8");

  it("has a real runtime entrypoint under /app/admin/audit", () => {
    expect(page).toContain('export const metadata = { title: "Audit Log — Singha Central"');
    expect(page).toContain("export default async function AuditPage");
    expect(page).toContain("requireAdmin()");
  });

  it("reads audit_events scoped by company_id", () => {
    expect(page).toContain('from("audit_events")');
    expect(page).toContain('.eq("company_id", admin.companyId)');
  });

  it("provides a governance filter that searches governance entity types", () => {
    expect(page).toContain("GOVERNANCE_ENTITY_TYPES");
    expect(page).toContain('"management_directive"');
    expect(page).toContain('"approval_request"');
    expect(page).toContain('.in("entity_type", GOVERNANCE_ENTITY_TYPES)');
    expect(page).toContain('href="/app/admin/audit?governance=1"');
  });

  it("includes directive and approval decisions in the governance view", () => {
    expect(page).toContain("management_directive");
    expect(page).toContain("approval_request");
  });
});
