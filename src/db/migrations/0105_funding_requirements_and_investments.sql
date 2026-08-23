-- 0105_funding_requirements_and_investments.sql
-- FIN-007 — Funding requirements and investments.
-- Company-scoped funding gap register and investment asset register. Forward-only and idempotent.

create table if not exists funding_requirements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  description text,
  required_amount numeric(19,4) not null,
  currency text not null default 'LKR',
  required_by_date date,
  status text not null default 'draft' check (status in ('draft','requested','approved','rejected','funded')),
  funding_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists funding_requirements_company_status_idx on funding_requirements (company_id, status);
create index if not exists funding_requirements_company_date_idx on funding_requirements (company_id, required_by_date);

create table if not exists investments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  kind text,
  acquisition_date date,
  cost_basis numeric(19,4) not null default 0,
  currency text not null default 'LKR',
  current_value numeric(19,4),
  status text not null default 'active' check (status in ('active','disposed')),
  location text,
  disposal_date date,
  disposal_proceeds numeric(19,4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists investments_company_status_idx on investments (company_id, status);
create index if not exists investments_company_acquisition_idx on investments (company_id, acquisition_date);

-- Capability for funding and investment management.
insert into permissions (key, label) values ('finance.funding.manage','Finance: manage funding requirements and investments') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('owner_management','finance.funding.manage')
on conflict do nothing;
insert into role_permissions (role_key, permission_key) select 'system_administrator','finance.funding.manage' on conflict do nothing;

-- RLS: company isolation for reads; capability-gated writes.
alter table funding_requirements enable row level security;
alter table investments enable row level security;

do $$
begin
  -- funding_requirements
  drop policy if exists funding_requirements_read on funding_requirements;
  create policy funding_requirements_read on funding_requirements for select using (public.has_company_access(company_id));

  drop policy if exists funding_requirements_w_ins on funding_requirements;
  drop policy if exists funding_requirements_w_upd on funding_requirements;
  drop policy if exists funding_requirements_w_del on funding_requirements;

  drop policy if exists funding_requirements_cap_ins on funding_requirements;
  drop policy if exists funding_requirements_cap_upd on funding_requirements;
  drop policy if exists funding_requirements_cap_del on funding_requirements;
  create policy funding_requirements_cap_ins on funding_requirements for insert with check (public.has_capability(company_id, 'finance.funding.manage'));
  create policy funding_requirements_cap_upd on funding_requirements for update using (public.has_capability(company_id, 'finance.funding.manage')) with check (public.has_capability(company_id, 'finance.funding.manage'));
  create policy funding_requirements_cap_del on funding_requirements for delete using (public.has_capability(company_id, 'finance.funding.manage'));

  -- investments
  drop policy if exists investments_read on investments;
  create policy investments_read on investments for select using (public.has_company_access(company_id));

  drop policy if exists investments_w_ins on investments;
  drop policy if exists investments_w_upd on investments;
  drop policy if exists investments_w_del on investments;

  drop policy if exists investments_cap_ins on investments;
  drop policy if exists investments_cap_upd on investments;
  drop policy if exists investments_cap_del on investments;
  create policy investments_cap_ins on investments for insert with check (public.has_capability(company_id, 'finance.funding.manage'));
  create policy investments_cap_upd on investments for update using (public.has_capability(company_id, 'finance.funding.manage')) with check (public.has_capability(company_id, 'finance.funding.manage'));
  create policy investments_cap_del on investments for delete using (public.has_capability(company_id, 'finance.funding.manage'));
end $$;

-- Updated-at maintenance (idempotent; function already exists from earlier migrations).
drop trigger if exists funding_requirements_updated_at on funding_requirements;
create trigger funding_requirements_updated_at
  before update on funding_requirements
  for each row
  execute function public.set_updated_at();

drop trigger if exists investments_updated_at on investments;
create trigger investments_updated_at
  before update on investments
  for each row
  execute function public.set_updated_at();
