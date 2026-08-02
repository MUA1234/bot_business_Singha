-- 0001_org_and_access.sql
-- Organization, hierarchy, users, roles, permissions, company access + RLS core.
-- Guide §2 (explicit company_id everywhere; legal companies isolated), §5, §10.
--
-- Convention: `company_id` on every business table references companies(id).
-- RLS on EVERY table. Cross-company leakage is a critical failure (CLAUDE.md).

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────────
-- Legal companies (the isolation boundary) and the operational hierarchy beneath.
-- A legal company ≠ division/branch/department/project/site (guide principle #3).
-- ─────────────────────────────────────────────────────────────────────────────
create table companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  legal_name    text,
  base_currency char(3) not null,
  country       text,
  status        text not null default 'active' check (status in ('active','suspended','archived')),
  created_at    timestamptz not null default now(),
  created_by    uuid,
  updated_at    timestamptz not null default now()
);

create table divisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table branches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  division_id uuid references divisions(id),
  name text not null,
  created_at timestamptz not null default now()
);

create table departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  name text not null,
  created_at timestamptz not null default now()
);

create table sites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  name text not null,
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  division_id uuid references divisions(id),
  name text not null,
  code text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

create table cost_centres (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  name text not null,
  code text,
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Users mirror Supabase auth.users. Roles/permissions per company (guide §10).
-- ─────────────────────────────────────────────────────────────────────────────
create table users (
  id          uuid primary key,          -- == auth.users.id
  email       text,
  full_name   text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table roles (
  key   text primary key,                -- staff_submitter, finance_reviewer, …
  label text not null
);

create table permissions (
  key   text primary key,                -- view, approve, post, reverse, …
  label text not null
);

create table role_permissions (
  role_key       text not null references roles(key) on delete cascade,
  permission_key text not null references permissions(key) on delete cascade,
  primary key (role_key, permission_key)
);

-- Which users may act in which company, and in what role. The RLS anchor.
create table user_company_access (
  user_id    uuid not null references users(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  role_key   text not null references roles(key),
  created_at timestamptz not null default now(),
  primary key (user_id, company_id, role_key)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS anchor function. SECURITY DEFINER so RLS policies can call it without the
-- caller needing direct select on user_company_access.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.has_company_access(target_company uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from user_company_access uca
    where uca.user_id = auth.uid()
      and uca.company_id = target_company
  );
$$;

create or replace function public.has_permission(target_company uuid, perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from user_company_access uca
    join role_permissions rp on rp.role_key = uca.role_key
    where uca.user_id = auth.uid()
      and uca.company_id = target_company
      and rp.permission_key = perm
  );
$$;

-- Seed the permission + role vocabulary (guide §10).
insert into permissions(key, label) values
  ('view','View'), ('create_draft','Create draft'), ('edit_draft','Edit draft'),
  ('upload_evidence','Upload evidence'), ('submit_for_approval','Submit for approval'),
  ('approve','Approve'), ('reject','Reject'), ('post','Post'), ('reconcile','Reconcile'),
  ('reverse','Reverse'), ('close_period','Close period'), ('reopen_period','Reopen period'),
  ('export','Export'), ('administer_accounts','Administer accounts'),
  ('change_supplier_bank_details','Change supplier bank details'),
  ('initiate_payment','Initiate payment'), ('authorize_payment','Authorize payment')
on conflict do nothing;

insert into roles(key, label) values
  ('staff_submitter','Staff submitter'), ('project_manager','Project/division manager'),
  ('finance_reviewer','Finance reviewer'), ('accountant','Accountant'),
  ('payment_initiator','Payment initiator'), ('payment_approver','Payment approver'),
  ('auditor_readonly','Auditor / read-only'), ('system_administrator','System administrator'),
  ('owner_management','Owner / management')
on conflict do nothing;

-- Enable RLS everywhere. Company-scoped tables share the same select policy shape.
alter table companies            enable row level security;
alter table divisions            enable row level security;
alter table branches             enable row level security;
alter table departments          enable row level security;
alter table sites                enable row level security;
alter table projects             enable row level security;
alter table cost_centres         enable row level security;
alter table users                enable row level security;
alter table user_company_access  enable row level security;

-- A user sees a company only if they have access to it.
create policy company_read on companies for select using (has_company_access(id));

-- Generic per-company read for hierarchy tables.
create policy div_read  on divisions   for select using (has_company_access(company_id));
create policy br_read   on branches    for select using (has_company_access(company_id));
create policy dep_read  on departments for select using (has_company_access(company_id));
create policy site_read on sites       for select using (has_company_access(company_id));
create policy proj_read on projects    for select using (has_company_access(company_id));
create policy cc_read   on cost_centres for select using (has_company_access(company_id));

-- Users can see their own row + their own access grants.
create policy user_self on users for select using (id = auth.uid());
create policy uca_self  on user_company_access for select using (user_id = auth.uid());
