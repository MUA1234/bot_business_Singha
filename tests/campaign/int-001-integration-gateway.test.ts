/**
 * INT-001 — Integration Gateway surface.
 *
 * The admin integrations page is a real runtime entrypoint that lists company-scoped
 * applications, connectors, event contracts and command contracts with signature/replay
 * flags, and provides audited create actions guarded to admin.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/admin/integrations/page.tsx";
const ACTIONS = "src/app/app/admin/integrations/actions.ts";
const HOME = "src/app/app/admin/page.tsx";
const MIGRATION = "src/db/migrations/0095_integration_gateway.sql";

describe("INT-001 — Integration Gateway surface", () => {
  const page = readFileSync(PAGE, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const home = readFileSync(HOME, "utf8");
  const migration = readFileSync(MIGRATION, "utf8");

  it("has a real runtime entrypoint under /app/admin/integrations", () => {
    expect(page).toContain('export const metadata = { title: "Integration Gateway');
    expect(page).toContain("export default async function IntegrationsPage");
    expect(page).toContain("requireAdmin()");
  });

  it("reads integrations, connectors and contracts scoped by company_id", () => {
    expect(page).toContain('from("integrations")');
    expect(page).toContain('from("connectors")');
    expect(page).toContain('from("integration_event_contracts")');
    expect(page).toContain('from("integration_command_contracts")');
    expect(page).toContain('.eq("company_id", admin.companyId)');
  });

  it("has company-scoped registry tables with capability-gated RLS in the migration", () => {
    expect(migration).toContain("create table if not exists integrations");
    expect(migration).toContain("create table if not exists connectors");
    expect(migration).toContain("create table if not exists integration_event_contracts");
    expect(migration).toContain("create table if not exists integration_command_contracts");
    expect(migration).toContain("company_id uuid not null references companies(id) on delete cascade");
    expect(migration).toContain("alter table integrations enable row level security");
    expect(migration).toContain("admin.integration.manage");
    expect(migration).toContain("has_capability(company_id, 'admin.integration.manage')");
  });

  it("records signature-required and replay-protection flags on contracts", () => {
    expect(migration).toContain("signature_required boolean not null default true");
    expect(migration).toContain("replay_protection boolean not null default true");
    expect(page).toContain("signature_required");
    expect(page).toContain("replay_protection");
  });

  it("provides audited create actions for application, connector and contracts", () => {
    expect(actions).toContain("export async function createIntegration");
    expect(actions).toContain("export async function createConnector");
    expect(actions).toContain("export async function createEventContract");
    expect(actions).toContain("export async function createCommandContract");
    expect(actions).toContain('action: "integration.created"');
    expect(actions).toContain('action: "connector.created"');
    expect(actions).toContain('action: "integration_event_contract.created"');
    expect(actions).toContain('action: "integration_command_contract.created"');
    expect(actions).toContain("writeAudit");
  });

  it("is linked from the admin home", () => {
    // F-001 review — see the matching case in gov-001. The original JSX-literal assertion
    // could not hold once the admin home moved to a data array rendered through `.map()`,
    // and the bare path that replaced it was weaker than necessary. This asserts the
    // declaration as written, paired with its label; the reachability invariant is
    // asserted live in tests/hard-scenario/a-owner-ai-management.test.ts.
    expect(home).toContain('href: "/app/admin/integrations"');
    expect(home).toMatch(/href:\s*"\/app\/admin\/integrations"[^}]*label:\s*"Integrations"/);
  });
});
