-- 0010_identity_foundation.sql
-- Change plan §5.3, step 1 — ADDITIVE ONLY. Creates the unified membership/identity
-- model ALONGSIDE the existing users / employees / profiles tables. Nothing is
-- dropped or altered, so this is fully reversible (drop the new tables to undo).
--
-- The app still READS and WRITES profiles. Cutover of reads (step 4) and writes
-- (step 5) happens in LATER migrations, each after staging isolation tests and
-- owner sign-off (Constitution §15). See docs/architecture-v2/IDENTITY_UNIFICATION_PLAN.md.
--
-- Forward-only and idempotent (safe to re-run).

create extension if not exists "pgcrypto";

-- ── New model ────────────────────────────────────────────────────────────────
create table if not exists organisation_units (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  type text not null check (type in ('division','branch','department','team','project_office','site')),
  parent_id uuid references organisation_units(id),
  name text not null,
  key text,
  created_at timestamptz not null default now(),
  unique (company_id, type, name)
);

-- Membership = the future single source of truth for company access.
create table if not exists memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  status text not null default 'active' check (status in ('active','suspended','ended')),
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);

create table if not exists membership_roles (
  membership_id uuid not null references memberships(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  role_key text not null references roles(key),
  primary key (membership_id, role_key)
);

create table if not exists authority_rules (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references memberships(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  domain text not null,                 -- 'expense','payment','contract','hr'...
  max_amount numeric(20,4),
  currency char(3),
  note text,
  created_at timestamptz not null default now()
);

create table if not exists membership_assignments (
  membership_id uuid not null references memberships(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  org_unit_id uuid not null references organisation_units(id) on delete cascade,
  is_primary boolean not null default false,
  primary key (membership_id, org_unit_id)
);

create table if not exists employee_profiles (
  membership_id uuid primary key references memberships(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  employment_status text,
  start_date date,
  end_date date,
  skills text[] not null default '{}',
  work_timezone text,
  created_at timestamptz not null default now()
);

create table if not exists delegations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  from_membership uuid not null references memberships(id) on delete cascade,
  to_membership uuid not null references memberships(id) on delete cascade,
  reason text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

-- ── RLS: company-scoped reads; writes are service-role only (default deny) ────
do $$
declare t text;
begin
  foreach t in array array[
    'organisation_units','memberships','membership_roles','authority_rules',
    'membership_assignments','employee_profiles','delegations'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_read', t);
    execute format('create policy %I on %I for select using (has_company_access(company_id))', t||'_read', t);
  end loop;
end $$;

-- ── Backfill from profiles (additive; safe to re-run) ─────────────────────────
-- 1. Ensure a users row per profile (users.id == auth.users.id == profiles.id).
insert into users (id, full_name, is_active)
select p.id, p.full_name, p.is_active from profiles p
on conflict (id) do nothing;

-- 2. One department org unit per (company, department) seen in profiles.
insert into organisation_units (company_id, type, name, key)
select distinct p.company_id, 'department', p.department, p.department from profiles p
on conflict (company_id, type, name) do nothing;

-- 3. One membership per profile.
insert into memberships (company_id, user_id, status)
select p.company_id, p.id, case when p.is_active then 'active' else 'suspended' end
from profiles p
on conflict (company_id, user_id) do nothing;

-- 4. Everyone gets staff_submitter; admins also get system_administrator.
--    Ensure those role keys exist (they are seeded by 0001, but guard anyway).
insert into roles (key, label) values
  ('staff_submitter', 'Staff submitter'),
  ('system_administrator', 'System administrator')
on conflict (key) do nothing;

insert into membership_roles (membership_id, company_id, role_key)
select m.id, m.company_id, 'staff_submitter' from memberships m
on conflict do nothing;

insert into membership_roles (membership_id, company_id, role_key)
select m.id, m.company_id, 'system_administrator'
from memberships m
join profiles p on p.id = m.user_id and p.company_id = m.company_id
where p.is_admin
on conflict do nothing;

-- 5. Link each membership to its department org unit as the primary assignment.
insert into membership_assignments (membership_id, company_id, org_unit_id, is_primary)
select m.id, m.company_id, ou.id, true
from memberships m
join profiles p on p.id = m.user_id and p.company_id = m.company_id
join organisation_units ou
  on ou.company_id = m.company_id and ou.type = 'department' and ou.name = p.department
on conflict do nothing;
