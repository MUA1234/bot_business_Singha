/**
 * CRM-003 — Consultant and service-provider registry.
 *
 * The procurement service-provider page lists company-scoped providers with
 * capabilities, service areas, compliance/insurance badges, and an audited create
 * form. The detail page supports status updates. The migration adds the table,
 * indexes, permission, capability-gated RLS and an updated_at trigger.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/procurement/service-providers/page.tsx";
const DETAIL = "src/app/app/procurement/service-providers/[id]/page.tsx";
const ACTIONS = "src/app/app/procurement/service-providers/actions.ts";
const HOME = "src/app/app/procurement/page.tsx";
const MIGRATION = "src/db/migrations/0101_service_provider_registry.sql";
const HELPER = "src/modules/crm/service-provider.ts";

describe("CRM-003 — service provider registry", () => {
  const page = readFileSync(PAGE, "utf8");
  const detail = readFileSync(DETAIL, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const home = readFileSync(HOME, "utf8");
  const migration = readFileSync(MIGRATION, "utf8");
  const helper = readFileSync(HELPER, "utf8");

  it("has a real runtime entrypoint under /app/procurement/service-providers", () => {
    expect(page).toContain('export const metadata = { title: "Service Providers');
    expect(page).toContain("export default async function ServiceProvidersPage");
    expect(page).toContain('requireDepartment("procurement")');
  });

  it("lists providers scoped by company_id with capabilities, service areas and badges", () => {
    expect(page).toContain('from("service_providers")');
    expect(page).toContain('.eq("company_id", p.companyId)');
    expect(page).toContain("capabilities");
    expect(page).toContain("service_areas");
    expect(page).toContain("compliance_status");
    expect(page).toContain("insurance_status");
    expect(page).toContain("insurance_expiry");
  });

  it("shows provider fields and a status update form on the detail page", () => {
    expect(detail).toContain("export default async function ServiceProviderDetail");
    expect(detail).toContain('requireDepartment("procurement")');
    expect(detail).toContain("updateServiceProviderStatus");
    expect(detail).toContain('name="status"');
    expect(detail).toContain('name="compliance_status"');
    expect(detail).toContain('name="insurance_status"');
    expect(detail).toContain('name="insurance_expiry"');
    expect(detail).toContain('name="capabilities"');
    expect(detail).toContain('name="service_areas"');
  });

  it("has a company-scoped service_providers table with capability-gated RLS in the migration", () => {
    expect(migration).toContain("create table if not exists service_providers");
    expect(migration).toContain("company_id uuid not null references companies(id) on delete cascade");
    expect(migration).toContain("status text not null default 'active' check (status in ('active','inactive','blacklisted'))");
    expect(migration).toContain("compliance_status text not null default 'pending' check (compliance_status in ('pending','verified','expired'))");
    expect(migration).toContain("insurance_status text not null default 'pending' check (insurance_status in ('pending','valid','expired'))");
    expect(migration).toContain("alter table service_providers enable row level security");
    expect(migration).toContain("service_providers_read on service_providers for select using");
    expect(migration).toContain("procurement.service_provider.manage");
    expect(migration).toContain("has_capability(company_id, 'procurement.service_provider.manage')");
  });

  it("adds indexes and updated_at trigger", () => {
    expect(migration).toContain("service_providers_company_status_idx");
    expect(migration).toContain("service_providers_company_name_idx");
    expect(migration).toContain("service_providers_updated_at");
    expect(migration).toContain("public.set_updated_at()");
  });

  it("provides audited create and update actions gated to procurement", () => {
    expect(actions).toContain("export async function createServiceProvider");
    expect(actions).toContain("export async function updateServiceProviderStatus");
    expect(actions).toContain('if (!p.isAdmin && p.department !== "procurement") throw new Error("Not allowed")');
    expect(actions).toContain('action: "service_provider.created"');
    expect(actions).toContain('action: "service_provider.status_updated"');
    expect(actions).toContain("writeAudit");
  });

  it("uses a deterministic provider health helper", () => {
    expect(helper).toContain("export function providerHealth");
    expect(helper).toContain('"verified"');
    expect(helper).toContain('"warning"');
    expect(helper).toContain('"blocked"');
    expect(page).toContain("providerHealth");
    expect(detail).toContain("providerHealth");
  });

  it("is linked from the procurement home", () => {
    expect(home).toContain("serviceProviders");
    expect(home).toContain('href: "/app/procurement/service-providers"');
    expect(home).toContain('from("service_providers")');
    expect(home).toContain("Service providers");
  });
});
