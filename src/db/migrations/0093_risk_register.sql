-- 0093_risk_register.sql
-- RSK-001 — Risk register with owner, mitigation, evidence and review dates.
-- Company-scoped, RLS-protected, audited. Forward-only and idempotent.

create table if not exists risks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  title text not null,
  description text,
  owner_id uuid references profiles(id) on delete set null,
  mitigation text,
  evidence text,
  review_date date,
  status text not null default 'open' check (status in ('open','mitigated','accepted','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists risks_company_review_idx on risks (company_id, review_date);
create index if not exists risks_company_status_idx on risks (company_id, status);

-- Capability for risk management (additive; idempotent).
insert into permissions (key, label) values ('legal.risk.manage','Legal: manage risk register') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('owner_management','legal.risk.manage')
on conflict do nothing;
insert into role_permissions (role_key, permission_key) select 'system_administrator','legal.risk.manage' on conflict do nothing;

-- RLS: company isolation for reads; capability-gated writes.
alter table risks enable row level security;

do $$
begin
  -- read
  drop policy if exists risks_read on risks;
  create policy risks_read on risks for select using (public.has_company_access(company_id));

  -- drop any generic company-member write policies from earlier/other migrations
  drop policy if exists risks_w_ins on risks;
  drop policy if exists risks_w_upd on risks;
  drop policy if exists risks_w_del on risks;

  -- capability-gated write policies
  drop policy if exists risks_cap_ins on risks;
  drop policy if exists risks_cap_upd on risks;
  drop policy if exists risks_cap_del on risks;
  create policy risks_cap_ins on risks for insert with check (public.has_capability(company_id, 'legal.risk.manage'));
  create policy risks_cap_upd on risks for update using (public.has_capability(company_id, 'legal.risk.manage')) with check (public.has_capability(company_id, 'legal.risk.manage'));
  create policy risks_cap_del on risks for delete using (public.has_capability(company_id, 'legal.risk.manage'));
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

drop trigger if exists risks_updated_at on risks;
create trigger risks_updated_at
  before update on risks
  for each row
  execute function public.set_updated_at();
