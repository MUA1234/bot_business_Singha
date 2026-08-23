/**
 * CRM-005 — Compliance and insurance status per counterparty.
 *
 * Verifies the supplier schema extension, shared compliance capability,
 * deterministic health helper, surfaced badges, and the purchase-order creation
 * compliance gate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SUPPLIER_PAGE = "src/app/app/procurement/suppliers/page.tsx";
const SERVICE_PROVIDER_PAGE = "src/app/app/procurement/service-providers/page.tsx";
const PO_ACTIONS = "src/app/app/procurement/purchase-orders/actions.ts";
const PO_PAGE = "src/app/app/procurement/purchase-orders/page.tsx";
const MIGRATION = "src/db/migrations/0102_counterparty_compliance.sql";
const HELPER = "src/modules/crm/counterparty-compliance.ts";

describe("CRM-005 — counterparty compliance and insurance status", () => {
  const supplierPage = readFileSync(SUPPLIER_PAGE, "utf8");
  const serviceProviderPage = readFileSync(SERVICE_PROVIDER_PAGE, "utf8");
  const poActions = readFileSync(PO_ACTIONS, "utf8");
  const poPage = readFileSync(PO_PAGE, "utf8");
  const migration = readFileSync(MIGRATION, "utf8");
  const helper = readFileSync(HELPER, "utf8");

  it("has migration 0102 extending suppliers with compliance/insurance fields", () => {
    expect(migration).toContain("alter table suppliers");
    expect(migration).toContain("compliance_status");
    expect(migration).toContain("insurance_status");
    expect(migration).toContain("insurance_expiry");
    expect(migration).toContain("suppliers_company_compliance_status_idx");
    expect(migration).toContain("suppliers_company_insurance_status_idx");
  });

  it("ensures service_providers carry the same compliance/insurance fields", () => {
    expect(migration).toContain("alter table service_providers");
    expect(migration).toContain("compliance_status");
    expect(migration).toContain("insurance_status");
    expect(migration).toContain("insurance_expiry");
  });

  it("adds shared counterparty compliance capability and gates supplier updates", () => {
    expect(migration).toContain("procurement.counterparty.compliance");
    expect(migration).toContain("suppliers_cap_upd");
    expect(migration).toContain("has_capability(company_id, 'procurement.counterparty.compliance')");
  });

  it("extends service_provider update policy with the shared compliance capability", () => {
    expect(migration).toContain("service_providers_cap_upd");
    expect(migration).toContain("procurement.service_provider.manage");
    expect(migration).toContain("procurement.counterparty.compliance");
  });

  it("provides a deterministic counterparty health helper", () => {
    expect(helper).toContain("export function counterpartyHealth");
    expect(helper).toContain("export function canOrderFromCounterparty");
    expect(helper).toContain('"verified"');
    expect(helper).toContain('"warning"');
    expect(helper).toContain('"blocked"');
  });

  it("shows supplier compliance/insurance badges and expiry", () => {
    expect(supplierPage).toContain("compliance_status");
    expect(supplierPage).toContain("insurance_status");
    expect(supplierPage).toContain("insurance_expiry");
    expect(supplierPage).toContain("counterpartyHealth");
  });

  it("shows service provider health badges", () => {
    expect(serviceProviderPage).toContain("providerHealth");
  });

  it("gates purchase order creation on supplier compliance health and audits rejections", () => {
    expect(poActions).toContain("counterpartyHealth");
    expect(poActions).toContain("canOrderFromCounterparty");
    expect(poActions).toContain("purchase_order.rejected_compliance");
    expect(poActions).toContain("supplier_id");
    expect(poActions).toContain('from("suppliers")');
  });

  it("exposes a supplier selector on the purchase order create form", () => {
    expect(poPage).toContain('name="supplier_id"');
    expect(poPage).toContain('from("suppliers")');
  });
});
