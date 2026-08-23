-- 0101_service_provider_registry.sql
-- CRM-003 — Consultant and service-provider registry.
-- Company-scoped, RLS-protected, capability-gated writes, audited. Forward-only and idempotent.

create table if not exists service_providers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  status text not null default 'active' check (status in ('active','inactive','blacklisted')),
  capabilities text[] not null default '{}',
  service_areas text[] not null default '{}',
  capacity_notes text,
  price_notes text,
  compliance_status text not null default 'pending' check (compliance_status in ('pending','verified','expired')),
  insurance_status text not null default 'pending' check (insurance_status in ('pending','valid','expired')),
  insurance_expiry date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists service_providers_company_status_idx on service_providers (company_id, status);
create index if not exists service_providers_company_name_idx on service_providers (company_id, name);

-- Capability for service-provider management (additive; idempotent).
insert into permissions (key, label) values ('procurement.service_provider.manage','Procurement: manage service provider registry') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('owner_management','procurement.service_provider.manage')
on conflict do nothing;
insert into role_permissions (role_key, permission_key) select 'system_administrator','procurement.service_provider.manage' on conflict do nothing;

-- RLS: company isolation for reads; capability-gated writes.
alter table service_providers enable row level security;

do $$
begin
  -- read
  drop policy if exists service_providers_read on service_providers;
  create policy service_providers_read on service_providers for select using (public.has_company_access(company_id));

  -- drop any generic company-member write policies from earlier/other migrations
  drop policy if exists service_providers_w_ins on service_providers;
  drop policy if exists service_providers_w_upd on service_providers;
  drop policy if exists service_providers_w_del on service_providers;

  -- capability-gated write policies
  drop policy if exists service_providers_cap_ins on service_providers;
  drop policy if exists service_providers_cap_upd on service_providers;
  drop policy if exists service_providers_cap_del on service_providers;
  create policy service_providers_cap_ins on service_providers for insert with check (public.has_capability(company_id, 'procurement.service_provider.manage'));
  create policy service_providers_cap_upd on service_providers for update using (public.has_capability(company_id, 'procurement.service_provider.manage')) with check (public.has_capability(company_id, 'procurement.service_provider.manage'));
  create policy service_providers_cap_del on service_providers for delete using (public.has_capability(company_id, 'procurement.service_provider.manage'));
end $$;

-- Updated-at maintenance.
create or replace function public.set_updated_at()
returns trigger language plpgsql
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is 'Trigger helper: sets updated_at to now(). Canonical search_path pinned.';

drop trigger if exists service_providers_updated_at on service_providers;
create trigger service_providers_updated_at
  before update on service_providers
  for each row
  execute function public.set_updated_at();
