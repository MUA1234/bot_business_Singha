-- 0012_work_tasks.sql
-- Architecture V2 change plan §7.3 — projects, tasks, dependencies, assignments,
-- check-ins and evidence. ADDITIVE. Company-scoped, RLS-protected. The task status
-- values match the pure state machine in src/modules/work/task-lifecycle.ts.
-- Forward-only and idempotent.

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  org_unit_id uuid references organisation_units(id),
  name text not null,
  code text,
  status text not null default 'active' check (status in ('active','on_hold','completed','cancelled')),
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  title text not null,
  description text,
  status text not null default 'captured' check (status in (
    'captured','clarifying','planned','awaiting_estimate','scheduled','in_progress',
    'blocked','awaiting_evidence','verification','completed','overdue','escalated',
    'cancelled','reopened')),
  priority int not null default 3,
  requires_evidence boolean not null default false,
  estimate_hours numeric(8,2),
  planned_start date,
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid
);
create index if not exists tasks_company_status_idx on tasks (company_id, status);

-- Dependencies (task blocks task), same company enforced by composite FK below.
create table if not exists task_dependencies (
  task_id uuid not null references tasks(id) on delete cascade,
  depends_on_task_id uuid not null references tasks(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);

-- Assignment to a membership (the V2 identity model from migration 0010).
create table if not exists task_assignments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  membership_id uuid references memberships(id) on delete set null,
  estimate_hours numeric(8,2),
  accepted boolean not null default false,
  created_at timestamptz not null default now(),
  unique (task_id, membership_id)
);

create table if not exists task_check_ins (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  note text,
  progress_pct int check (progress_pct between 0 and 100),
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists task_evidence (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  kind text not null check (kind in ('message','document','photo','approval','system','gps','financial')),
  reference text,
  document_id uuid,
  verified_by uuid,
  created_at timestamptz not null default now()
);

-- Company-scoped composite integrity: a child can't cross companies (NOT VALID so
-- it never fails on legacy rows; VALIDATE later once data is confirmed clean).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_id_company_uq') then
    alter table tasks add constraint tasks_id_company_uq unique (id, company_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'task_dep_company_match_fk') then
    alter table task_dependencies add constraint task_dep_company_match_fk
      foreign key (task_id, company_id) references tasks (id, company_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'task_assign_company_match_fk') then
    alter table task_assignments add constraint task_assign_company_match_fk
      foreign key (task_id, company_id) references tasks (id, company_id) not valid;
  end if;
end $$;

-- RLS: company-scoped reads; writes are through service-role/domain services.
do $$
declare t text;
begin
  foreach t in array array[
    'projects','tasks','task_dependencies','task_assignments','task_check_ins','task_evidence'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_read', t);
    execute format('create policy %I on %I for select using (has_company_access(company_id))', t||'_read', t);
  end loop;
end $$;
