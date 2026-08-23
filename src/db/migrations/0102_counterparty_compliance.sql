-- 0102_counterparty_compliance.sql
-- CRM-005 — Compliance and insurance status per counterparty.
-- Extends suppliers with compliance/insurance fields, ensures service_providers
-- carry the same fields, and adds a shared capability for counterparty-compliance
-- updates. Forward-only and idempotent.

-- 1. Extend suppliers with compliance/insurance status and expiry.
alter table suppliers
  add column if not exists compliance_status text not null default 'pending' check (compliance_status in ('pending','verified','expired')),
  add column if not exists insurance_status text not null default 'pending' check (insurance_status in ('pending','valid','expired')),
  add column if not exists insurance_expiry date;

create index if not exists suppliers_company_compliance_status_idx on suppliers (company_id, compliance_status);
create index if not exists suppliers_company_insurance_status_idx on suppliers (company_id, insurance_status);

-- 2. Ensure service_providers carry the same three fields (idempotent no-op after 0101).
alter table service_providers
  add column if not exists compliance_status text not null default 'pending' check (compliance_status in ('pending','verified','expired')),
  add column if not exists insurance_status text not null default 'pending' check (insurance_status in ('pending','valid','expired')),
  add column if not exists insurance_expiry date;

-- 3. Shared capability for counterparty compliance management.
insert into permissions (key, label) values ('procurement.counterparty.compliance','Procurement: manage counterparty compliance and insurance status') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values ('owner_management','procurement.counterparty.compliance') on conflict do nothing;
insert into role_permissions (role_key, permission_key) select 'system_administrator','procurement.counterparty.compliance' on conflict do nothing;

-- 4. Capability-gated update policies for suppliers and service_providers.
do $$
begin
  -- Suppliers: only users with the shared compliance capability may update compliance fields.
  drop policy if exists suppliers_cap_upd on suppliers;
  create policy suppliers_cap_upd on suppliers for update using (public.has_capability(company_id, 'procurement.counterparty.compliance')) with check (public.has_capability(company_id, 'procurement.counterparty.compliance'));

  -- Service providers: existing full managers keep control; compliance specialists may
  -- also update compliance/insurance fields.
  drop policy if exists service_providers_cap_upd on service_providers;
  create policy service_providers_cap_upd on service_providers for update using (
    public.has_capability(company_id, 'procurement.service_provider.manage')
    or public.has_capability(company_id, 'procurement.counterparty.compliance')
  ) with check (
    public.has_capability(company_id, 'procurement.service_provider.manage')
    or public.has_capability(company_id, 'procurement.counterparty.compliance')
  );
end $$;
