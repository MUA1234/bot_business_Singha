/**
 * GOV-001 — Management directives with response obligations surface.
 *
 * The admin directives page is a real runtime entrypoint that lists company-scoped
 * directives issued to named humans with a required response window, and provides
 * audited issue/acknowledge/close actions guarded to admin.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/admin/directives/page.tsx";
const ACTIONS = "src/app/app/admin/directives/actions.ts";
const HOME = "src/app/app/admin/page.tsx";
const MIGRATION = "src/db/migrations/0096_management_directives.sql";

describe("GOV-001 — Management directives surface", () => {
  const page = readFileSync(PAGE, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const home = readFileSync(HOME, "utf8");
  const migration = readFileSync(MIGRATION, "utf8");

  it("has a real runtime entrypoint under /app/admin/directives", () => {
    expect(page).toContain('export const metadata = { title: "Directives');
    expect(page).toContain("export default async function DirectivesPage");
    expect(page).toContain("requireAdmin()");
  });

  it("reads management_directives scoped by company_id with response window and status", () => {
    expect(page).toContain('from("management_directives")');
    expect(page).toContain('.eq("company_id", admin.companyId)');
    expect(page).toContain("response_required_by");
    expect(page).toContain("status");
    expect(page).toContain("acknowledged_at");
  });

  it("has a company-scoped management_directives table with capability-gated RLS in the migration", () => {
    expect(migration).toContain("create table if not exists management_directives");
    expect(migration).toContain("company_id uuid not null references companies(id) on delete cascade");
    expect(migration).toContain("alter table management_directives enable row level security");
    expect(migration).toContain("management_directives_read on management_directives for select using");
    expect(migration).toContain("admin.directive.manage");
    expect(migration).toContain("has_capability(company_id, 'admin.directive.manage')");
  });

  it("provides audited issue, acknowledge and close actions", () => {
    expect(actions).toContain("export async function createDirective");
    expect(actions).toContain("export async function acknowledgeDirective");
    expect(actions).toContain("export async function closeDirective");
    expect(actions).toContain('action: "management_directive.created"');
    expect(actions).toContain('action: "management_directive.acknowledged"');
    expect(actions).toContain('action: "management_directive.closed"');
    expect(actions).toContain("writeAudit");
  });

  it("requires a response obligation (title, recipient and due date) when issuing", () => {
    expect(page).toContain('name="title"');
    expect(page).toContain('name="issued_to"');
    expect(page).toContain('name="response_required_by"');
    expect(page).toContain('type="datetime-local"');
  });

  it("is linked from the admin home", () => {
    // The admin home builds its index from a data array, so the route appears as
    // `href: "/app/admin/directives"` rather than as a JSX `href="…"` literal.
    // What matters is that the admin home REFERENCES the route and names it.
    expect(home).toContain("/app/admin/directives");
    expect(home).toContain("Directives");
  });
});
