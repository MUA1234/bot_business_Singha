-- 0106_incidents_and_statutory_obligations.sql
-- RSK-005 — Incident log and statutory obligations register.
-- Adds an incidents table and extends obligations with evidence and a statutory flag.
-- Forward-only and idempotent.

-- 1. Incident log.
create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  title text not null,
  description text,
  occurred_at timestamptz not null default now(),
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  status text not null default 'open' check (status in ('open','investigating','resolved','closed')),
  root_cause text,
  corrective_action text,
  evidence text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists incidents_company_status_idx on incidents (company_id, status);
create index if not exists incidents_company_occurred_idx on incidents (company_id, occurred_at desc);

-- 2. Extend obligations for statutory obligations with evidence.
alter table obligations
  add column if not exists evidence text,
  add column if not exists obligation_type text not null default 'contractual' check (obligation_type in ('contractual','statutory'));

create index if not exists obligations_company_type_idx on obligations (company_id, obligation_type);

-- 3. Capability for legal compliance management (incidents + obligations).
insert into permissions (key, label) values ('legal.compliance.manage','Legal: manage incidents and statutory obligations') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('owner_management','legal.compliance.manage')
on conflict do nothing;
insert into role_permissions (role_key, permission_key) select 'system_administrator','legal.compliance.manage' on conflict do nothing;

-- 4. RLS: company isolation for reads; capability-gated writes.
alter table incidents enable row level security;

-- Ensure obligations has RLS enabled (idempotent no-op if already enabled).
alter table obligations enable row level security;

do $$
begin
  -- incidents
  drop policy if exists incidents_read on incidents;
  create policy incidents_read on incidents for select using (public.has_company_access(company_id));

  drop policy if exists incidents_w_ins on incidents;
  drop policy if exists incidents_w_upd on incidents;
  drop policy if exists incidents_w_del on incidents;

  drop policy if exists incidents_cap_ins on incidents;
  drop policy if exists incidents_cap_upd on incidents;
  drop policy if exists incidents_cap_del on incidents;
  create policy incidents_cap_ins on incidents for insert with check (public.has_capability(company_id, 'legal.compliance.manage'));
  create policy incidents_cap_upd on incidents for update using (public.has_capability(company_id, 'legal.compliance.manage')) with check (public.has_capability(company_id, 'legal.compliance.manage'));
  create policy incidents_cap_del on incidents for delete using (public.has_capability(company_id, 'legal.compliance.manage'));

  -- obligations
  drop policy if exists obligations_read on obligations;
  create policy obligations_read on obligations for select using (public.has_company_access(company_id));

  drop policy if exists obligations_w_ins on obligations;
  drop policy if exists obligations_w_upd on obligations;
  drop policy if exists obligations_w_del on obligations;

  drop policy if exists obligations_cap_ins on obligations;
  drop policy if exists obligations_cap_upd on obligations;
  drop policy if exists obligations_cap_del on obligations;
  create policy obligations_cap_ins on obligations for insert with check (public.has_capability(company_id, 'legal.compliance.manage'));
  create policy obligations_cap_upd on obligations for update using (public.has_capability(company_id, 'legal.compliance.manage')) with check (public.has_capability(company_id, 'legal.compliance.manage'));
  create policy obligations_cap_del on obligations for delete using (public.has_capability(company_id, 'legal.compliance.manage'));
end $$;

-- 5. Updated-at maintenance.
drop trigger if exists incidents_updated_at on incidents;
create trigger incidents_updated_at
  before update on incidents
  for each row
  execute function public.set_updated_at();
