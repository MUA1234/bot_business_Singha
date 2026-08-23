-- 0094_insurance_register.sql
-- RSK-004 — Insurance register with cover, expiry and renewal tracking.
-- Company-scoped, RLS-protected, audited. Forward-only and idempotent.

create table if not exists insurances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  policy_name text not null,
  insurer text,
  policy_number text,
  cover_amount numeric(18,2),
  currency char(3) not null default 'LKR',
  expiry_date date,
  status text not null default 'active' check (status in ('active','expired','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists insurances_company_expiry_idx on insurances (company_id, expiry_date);
create index if not exists insurances_company_status_idx on insurances (company_id, status);

-- Capability for insurance management (additive; idempotent).
insert into permissions (key, label) values ('legal.insurance.manage','Legal: manage insurance register') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('owner_management','legal.insurance.manage')
on conflict do nothing;
insert into role_permissions (role_key, permission_key) select 'system_administrator','legal.insurance.manage' on conflict do nothing;

-- RLS: company isolation for reads; capability-gated writes.
alter table insurances enable row level security;

do $$
begin
  -- read
  drop policy if exists insurances_read on insurances;
  create policy insurances_read on insurances for select using (public.has_company_access(company_id));

  -- drop any generic company-member write policies from earlier/other migrations
  drop policy if exists insurances_w_ins on insurances;
  drop policy if exists insurances_w_upd on insurances;
  drop policy if exists insurances_w_del on insurances;

  -- capability-gated write policies
  drop policy if exists insurances_cap_ins on insurances;
  drop policy if exists insurances_cap_upd on insurances;
  drop policy if exists insurances_cap_del on insurances;
  create policy insurances_cap_ins on insurances for insert with check (public.has_capability(company_id, 'legal.insurance.manage'));
  create policy insurances_cap_upd on insurances for update using (public.has_capability(company_id, 'legal.insurance.manage')) with check (public.has_capability(company_id, 'legal.insurance.manage'));
  create policy insurances_cap_del on insurances for delete using (public.has_capability(company_id, 'legal.insurance.manage'));
end $$;

-- Updated-at maintenance (function already canonical from 0093).
drop trigger if exists insurances_updated_at on insurances;
create trigger insurances_updated_at
  before update on insurances
  for each row
  execute function public.set_updated_at();
