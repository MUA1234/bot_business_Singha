-- 0107_project_risks_decisions_scenarios.sql
-- PRJ-004 — Per-project risk register, decision log and scenario comparison.
-- Company- and project-scoped, RLS-protected, audited. Forward-only and idempotent.

create table if not exists project_risks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  description text,
  owner_id uuid references profiles(id) on delete set null,
  mitigation text,
  impact text not null default 'medium' check (impact in ('low','medium','high','critical')),
  likelihood text not null default 'medium' check (likelihood in ('low','medium','high','critical')),
  status text not null default 'open' check (status in ('open','mitigated','accepted','closed')),
  review_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_risks_project_idx on project_risks (company_id, project_id, status);
create index if not exists project_risks_review_idx on project_risks (company_id, review_date);

create table if not exists project_decisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  context text,
  options jsonb not null default '[]'::jsonb,
  decided_option_id text,
  rationale text,
  decided_by uuid references profiles(id) on delete set null,
  decided_at timestamptz,
  status text not null default 'pending' check (status in ('pending','decided','reversed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_decisions_project_idx on project_decisions (company_id, project_id, status);

create table if not exists project_scenarios (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  assumptions jsonb not null default '{}'::jsonb,
  best_case_total numeric(20,6) not null,
  expected_total numeric(20,6) not null,
  worst_case_total numeric(20,6) not null,
  currency text not null,
  chosen boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_scenarios_project_idx on project_scenarios (company_id, project_id, chosen);

-- Capability for project portfolio management (additive; idempotent).
insert into permissions (key, label) values ('operations.project.manage','Operations: manage project portfolio') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('owner_management','operations.project.manage'),
  ('project_manager','operations.project.manage')
on conflict do nothing;
insert into role_permissions (role_key, permission_key) select 'system_administrator','operations.project.manage' on conflict do nothing;

-- RLS: company isolation for reads; capability-gated writes.
alter table project_risks enable row level security;
alter table project_decisions enable row level security;
alter table project_scenarios enable row level security;

do $$
begin
  -- project_risks
  drop policy if exists project_risks_read on project_risks;
  create policy project_risks_read on project_risks for select using (public.has_company_access(company_id));
  drop policy if exists project_risks_cap_ins on project_risks;
  drop policy if exists project_risks_cap_upd on project_risks;
  drop policy if exists project_risks_cap_del on project_risks;
  create policy project_risks_cap_ins on project_risks for insert with check (public.has_capability(company_id, 'operations.project.manage'));
  create policy project_risks_cap_upd on project_risks for update using (public.has_capability(company_id, 'operations.project.manage')) with check (public.has_capability(company_id, 'operations.project.manage'));
  create policy project_risks_cap_del on project_risks for delete using (public.has_capability(company_id, 'operations.project.manage'));

  -- project_decisions
  drop policy if exists project_decisions_read on project_decisions;
  create policy project_decisions_read on project_decisions for select using (public.has_company_access(company_id));
  drop policy if exists project_decisions_cap_ins on project_decisions;
  drop policy if exists project_decisions_cap_upd on project_decisions;
  drop policy if exists project_decisions_cap_del on project_decisions;
  create policy project_decisions_cap_ins on project_decisions for insert with check (public.has_capability(company_id, 'operations.project.manage'));
  create policy project_decisions_cap_upd on project_decisions for update using (public.has_capability(company_id, 'operations.project.manage')) with check (public.has_capability(company_id, 'operations.project.manage'));
  create policy project_decisions_cap_del on project_decisions for delete using (public.has_capability(company_id, 'operations.project.manage'));

  -- project_scenarios
  drop policy if exists project_scenarios_read on project_scenarios;
  create policy project_scenarios_read on project_scenarios for select using (public.has_company_access(company_id));
  drop policy if exists project_scenarios_cap_ins on project_scenarios;
  drop policy if exists project_scenarios_cap_upd on project_scenarios;
  drop policy if exists project_scenarios_cap_del on project_scenarios;
  create policy project_scenarios_cap_ins on project_scenarios for insert with check (public.has_capability(company_id, 'operations.project.manage'));
  create policy project_scenarios_cap_upd on project_scenarios for update using (public.has_capability(company_id, 'operations.project.manage')) with check (public.has_capability(company_id, 'operations.project.manage'));
  create policy project_scenarios_cap_del on project_scenarios for delete using (public.has_capability(company_id, 'operations.project.manage'));
end $$;

-- Updated-at maintenance.
drop trigger if exists project_risks_updated_at on project_risks;
create trigger project_risks_updated_at
  before update on project_risks
  for each row
  execute function public.set_updated_at();

drop trigger if exists project_decisions_updated_at on project_decisions;
create trigger project_decisions_updated_at
  before update on project_decisions
  for each row
  execute function public.set_updated_at();

drop trigger if exists project_scenarios_updated_at on project_scenarios;
create trigger project_scenarios_updated_at
  before update on project_scenarios
  for each row
  execute function public.set_updated_at();
