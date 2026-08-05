-- Singha — combined migrations 0008–0015 (idempotent, guarded). One transaction.

begin;
create extension if not exists pgcrypto;

-- ==================== 0008_phase0_rls_hardening ====================
-- 0008_phase0_rls_hardening.sql
-- Architecture V2 change plan §5.5 (Repair Row Level Security) — Phase 0.
-- Forward-only, idempotent, and DEFENSIVE: every table is guarded with to_regclass
-- so this runs cleanly whether or not the earlier optional migrations (e.g. 0004
-- intelligence layer) were ever applied to this database.

-- 0. Ensure the append-only audit_events table exists (my privileged-op audit needs
--    it; it normally comes from 0004, which may not be applied here).
create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid,
  actor_type text not null check (actor_type in ('user','system','ai')),
  actor_id text,
  action text not null,
  entity_type text not null,
  entity_id text,
  correlation_id text,
  source_event_id uuid,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_events_company_created_idx on audit_events (company_id, created_at);

create or replace function public.block_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_audit_append_only') then
    create trigger trg_audit_append_only
      before update or delete on audit_events
      for each row execute function public.block_audit_mutation();
  end if;
end $$;

-- 1. Strict company-scoped reads for the intelligence/evidence/finance tables that
--    exist. NULL-company rows become visible only to service-role workers.
do $$
declare t text;
begin
  foreach t in array array[
    'source_events','documents','document_extractions','conversation_references',
    'financial_events','financial_event_versions','financial_event_allocations',
    'ai_runs','ai_recommendations','clarification_requests','duplicate_candidates',
    'policy_evaluations','approval_requests','approval_actions','audit_events'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('alter table %I enable row level security', t);
      execute format('drop policy if exists %I on %I', t||'_read', t);
      execute format(
        'create policy %I on %I for select using (company_id is not null and has_company_access(company_id))',
        t||'_read', t);
    end if;
  end loop;
end $$;

-- 2. Dead-letter events (if present): add a company scope and remove the
--    world-readable policy so only service-role workers can read them.
do $$
begin
  if to_regclass('public.dead_letter_events') is not null then
    alter table dead_letter_events add column if not exists company_id uuid references companies(id);
    drop policy if exists dle_read on dead_letter_events;
    -- (no user-facing SELECT policy — restricted to system workers)
  end if;
end $$;

-- ==================== 0009_composite_company_fks ====================
-- 0009_composite_company_fks.sql
-- Architecture V2 change plan §5.5 — a child row must never belong to a different
-- company than its parent. Enforced with composite (id, company_id) references.
-- Forward-only, idempotent, and DEFENSIVE: each step is guarded with to_regclass so
-- it is skipped when a table is absent. FKs are added NOT VALID so applying this can
-- never fail on pre-existing rows; validate later with:
--   ALTER TABLE <child> VALIDATE CONSTRAINT <name>;

-- Parents need a UNIQUE(id, company_id) target for the composite FK.
do $$
begin
  if to_regclass('public.quotations') is not null
     and not exists (select 1 from pg_constraint where conname = 'quotations_id_company_uq') then
    alter table quotations add constraint quotations_id_company_uq unique (id, company_id);
  end if;
  if to_regclass('public.orders') is not null
     and not exists (select 1 from pg_constraint where conname = 'orders_id_company_uq') then
    alter table orders add constraint orders_id_company_uq unique (id, company_id);
  end if;
  if to_regclass('public.wa_conversations') is not null
     and not exists (select 1 from pg_constraint where conname = 'wa_conversations_id_company_uq') then
    alter table wa_conversations add constraint wa_conversations_id_company_uq unique (id, company_id);
  end if;
end $$;

-- Child composite FKs (NOT VALID: enforced for new/updated rows immediately).
do $$
begin
  if to_regclass('public.quotation_items') is not null
     and not exists (select 1 from pg_constraint where conname = 'quotation_items_company_match_fk') then
    alter table quotation_items add constraint quotation_items_company_match_fk
      foreign key (quotation_id, company_id) references quotations (id, company_id) not valid;
  end if;

  if to_regclass('public.price_confirmations') is not null
     and not exists (select 1 from pg_constraint where conname = 'price_conf_company_match_fk') then
    alter table price_confirmations add constraint price_conf_company_match_fk
      foreign key (quotation_id, company_id) references quotations (id, company_id) not valid;
  end if;

  if to_regclass('public.wa_messages') is not null
     and not exists (select 1 from pg_constraint where conname = 'wa_messages_company_match_fk') then
    alter table wa_messages add constraint wa_messages_company_match_fk
      foreign key (conversation_id, company_id) references wa_conversations (id, company_id) not valid;
  end if;

  if to_regclass('public.quotations') is not null
     and not exists (select 1 from pg_constraint where conname = 'quotations_order_company_match_fk') then
    alter table quotations add constraint quotations_order_company_match_fk
      foreign key (order_id, company_id) references orders (id, company_id) not valid;
  end if;
end $$;

-- ==================== 0010_identity_foundation ====================
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

-- ==================== 0011_message_outbox ====================
-- 0011_message_outbox.sql
-- Architecture V2 change plan §5.7 — transactional outbox for outbound messages.
-- ADDITIVE: creates the table only. The live synchronous WhatsApp reply (owner
-- instruction 2026-08-04) is unchanged; the delivery worker that drains this table
-- is wired in a later, tested step. Forward-only and idempotent.

create table if not exists message_outbox (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  channel text not null default 'whatsapp' check (channel in ('whatsapp','email')),
  recipient text not null,
  body text not null,
  -- Hard dedup: one logical send exists once, so a retry/concurrent finalise no-ops.
  idempotency_key text not null unique,
  status text not null default 'pending' check (status in ('pending','sent','failed','dead')),
  attempts int not null default 0,
  last_error text,
  provider_message_id text,
  correlation_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists message_outbox_status_idx on message_outbox (status, created_at);

-- RLS: company-scoped reads; sends are service-role only (default deny for users).
alter table message_outbox enable row level security;
drop policy if exists message_outbox_read on message_outbox;
create policy message_outbox_read on message_outbox for select
  using (company_id is not null and has_company_access(company_id));

-- ==================== 0012_work_tasks ====================
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

-- ==================== 0013_capacity_snapshots ====================
-- 0013_capacity_snapshots.sql
-- Architecture V2 change plan §7.2 — persisted weekly capacity per membership, so the
-- command centre can show over/under-allocation and forecast. ADDITIVE, company-scoped,
-- RLS-protected. Values are produced by src/modules/work/capacity.ts. Forward-only.

create table if not exists capacity_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  membership_id uuid not null references memberships(id) on delete cascade,
  week_start date not null,
  total_hours numeric(8,2) not null default 0,
  net_capacity_hours numeric(8,2) not null default 0,
  allocated_hours numeric(8,2) not null default 0,
  available_hours numeric(8,2) not null default 0,
  utilization_pct numeric(6,2),
  status text not null check (status in ('overloaded','healthy','underallocated')),
  created_at timestamptz not null default now(),
  unique (membership_id, week_start)
);
create index if not exists capacity_snap_company_week_idx on capacity_snapshots (company_id, week_start);

alter table capacity_snapshots enable row level security;
drop policy if exists capacity_snap_read on capacity_snapshots;
create policy capacity_snap_read on capacity_snapshots for select
  using (has_company_access(company_id));

-- ==================== 0014_departments_expansion ====================
-- 0014_departments_expansion.sql
-- Architecture V2 change plan §9 — CRM/sales, procurement, legal and fleet modules.
-- ADDITIVE, company-scoped, RLS-protected. Forward-only and idempotent.

-- ── New departments (legal, fleet) ───────────────────────────────────────────
insert into departments_catalog (key, label, description) values
  ('legal', 'Legal & Compliance', 'Matters, contracts, obligations and licence renewals.'),
  ('fleet', 'Fleet & Transport',  'Vehicles, drivers, trips, fuel and maintenance.')
on conflict (key) do nothing;

-- Helper: enable RLS + a company-scoped read policy on a list of tables.
create or replace function public._v2_enable_company_rls(tables text[])
returns void language plpgsql as $$
declare t text;
begin
  foreach t in array tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_read', t);
    execute format('create policy %I on %I for select using (has_company_access(company_id))', t||'_read', t);
  end loop;
end $$;

-- ── CRM / Sales (§9.1) ────────────────────────────────────────────────────────
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  contact text,
  source text,
  stage text not null default 'new'
    check (stage in ('new','contacted','qualified','proposal','won','lost')),
  estimated_value numeric(18,2) not null default 0,
  currency char(3) not null default 'LKR',
  last_contact_at timestamptz,
  owner_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid
);
create index if not exists leads_company_stage_idx on leads (company_id, stage);

create table if not exists opportunities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  title text not null,
  amount numeric(18,2) not null default 0,
  currency char(3) not null default 'LKR',
  probability numeric(5,2) not null default 0 check (probability between 0 and 100),
  expected_close date,
  status text not null default 'open' check (status in ('open','won','lost')),
  created_at timestamptz not null default now()
);

-- ── Procurement (§9.2) ────────────────────────────────────────────────────────
create table if not exists purchase_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  title text not null,
  description text,
  estimated_cost numeric(18,2),
  currency char(3) not null default 'LKR',
  status text not null default 'draft'
    check (status in ('draft','submitted','approved','rejected','ordered','closed')),
  requested_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists purchase_requests_company_idx on purchase_requests (company_id, status);

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  purchase_request_id uuid references purchase_requests(id) on delete set null,
  supplier_id uuid references suppliers(id),
  po_number text not null,
  currency char(3) not null default 'LKR',
  total_amount numeric(18,2) not null default 0,
  status text not null default 'draft'
    check (status in ('draft','sent','part_received','received','closed','cancelled')),
  created_at timestamptz not null default now(),
  unique (company_id, po_number)
);

create table if not exists po_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  description text not null,
  quantity numeric(18,3) not null default 1,
  unit_price numeric(18,2) not null default 0,
  received_quantity numeric(18,3) not null default 0
);

create table if not exists goods_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  received_at timestamptz not null default now(),
  received_by uuid,
  note text
);

-- ── Legal & Compliance (§9.3) ─────────────────────────────────────────────────
create table if not exists legal_matters (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  title text not null,
  matter_type text,
  status text not null default 'open' check (status in ('open','on_hold','closed')),
  owner_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  legal_matter_id uuid references legal_matters(id) on delete set null,
  title text not null,
  counterparty text,
  start_date date,
  end_date date,
  renewal_date date,
  status text not null default 'active' check (status in ('draft','active','expired','terminated')),
  version integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists obligations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  contract_id uuid references contracts(id) on delete set null,
  description text not null,
  due_date date,
  status text not null default 'open' check (status in ('open','done','overdue','waived')),
  created_at timestamptz not null default now()
);
create index if not exists obligations_company_due_idx on obligations (company_id, due_date);

create table if not exists licences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  authority text,
  licence_number text,
  issue_date date,
  expiry_date date,
  status text not null default 'active' check (status in ('active','expired','pending')),
  created_at timestamptz not null default now()
);
create index if not exists licences_company_expiry_idx on licences (company_id, expiry_date);

-- ── Fleet & Transport (§9.4) ──────────────────────────────────────────────────
create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  registration_no text not null,
  make text,
  model text,
  year integer,
  status text not null default 'active' check (status in ('active','maintenance','retired')),
  odometer numeric(12,1),
  created_at timestamptz not null default now(),
  unique (company_id, registration_no)
);

create table if not exists drivers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  licence_number text,
  licence_expiry date,
  phone text,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  vehicle_id uuid references vehicles(id) on delete set null,
  driver_id uuid references drivers(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  started_at timestamptz,
  ended_at timestamptz,
  start_odometer numeric(12,1),
  end_odometer numeric(12,1),
  purpose text,
  created_at timestamptz not null default now()
);

create table if not exists fuel_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  vehicle_id uuid references vehicles(id) on delete cascade,
  litres numeric(10,2),
  cost numeric(18,2),
  currency char(3) not null default 'LKR',
  odometer numeric(12,1),
  logged_at timestamptz not null default now()
);

create table if not exists maintenance_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  vehicle_id uuid references vehicles(id) on delete cascade,
  kind text,
  description text,
  cost numeric(18,2),
  currency char(3) not null default 'LKR',
  service_date date,
  next_service_date date,
  created_at timestamptz not null default now()
);

create table if not exists vehicle_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  doc_type text not null check (doc_type in ('insurance','registration','emission','permit','other')),
  reference text,
  expiry_date date,
  created_at timestamptz not null default now()
);
create index if not exists vehicle_documents_expiry_idx on vehicle_documents (company_id, expiry_date);

-- ── Enable RLS on everything new ──────────────────────────────────────────────
select public._v2_enable_company_rls(array[
  'leads','opportunities',
  'purchase_requests','purchase_orders','po_lines','goods_receipts',
  'legal_matters','contracts','obligations','licences',
  'vehicles','drivers','trips','fuel_logs','maintenance_records','vehicle_documents'
]);

-- ==================== 0015_post_journal_rpc ====================
-- 0015_post_journal_rpc.sql
-- Architecture V2 change plan §8.2 — connect approval to PERSISTENT posting. This
-- function posts a manual journal ATOMICALLY (header + lines in one transaction) and
-- enforces the core invariants server-side: at least two lines, every account exists
-- & is active in the company, the period is open, no negative amounts, and
-- debit == credit (Constitution §8). Posted journals are immutable — corrections use
-- reversals. Human-initiated only (called from a permission-checked server action);
-- the language model never calls this. Forward-only, idempotent (create or replace).

create or replace function public.post_manual_journal(
  p_company uuid,
  p_date date,
  p_currency text,
  p_memo text,
  p_posted_by uuid,
  p_lines jsonb
) returns uuid
language plpgsql
as $$
declare
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_line jsonb;
  v_journal_id uuid;
  v_period_id uuid;
  v_period_status text;
  v_line_no int := 0;
  v_debit numeric;
  v_credit numeric;
  v_code text;
begin
  if p_lines is null or jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal needs at least two lines';
  end if;

  -- Period gate: a closed/locked period rejects ordinary posting.
  select id, status into v_period_id, v_period_status
  from accounting_periods
  where company_id = p_company and p_date between start_date and end_date
  order by start_date desc
  limit 1;
  if v_period_status is not null and v_period_status in ('closed', 'locked') then
    raise exception 'Accounting period is % for %', v_period_status, p_date;
  end if;

  -- Validate each line and accumulate totals.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_code := v_line->>'account_code';
    v_debit := round(coalesce((v_line->>'debit')::numeric, 0), 2);
    v_credit := round(coalesce((v_line->>'credit')::numeric, 0), 2);
    if v_debit < 0 or v_credit < 0 then
      raise exception 'Line has a negative amount';
    end if;
    if v_debit > 0 and v_credit > 0 then
      raise exception 'Line % has both a debit and a credit', v_code;
    end if;
    if not exists (
      select 1 from chart_of_accounts
      where company_id = p_company and code = v_code and is_active
    ) then
      raise exception 'Account % not found or inactive in this company', v_code;
    end if;
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
  end loop;

  if round(v_total_debit, 2) <> round(v_total_credit, 2) then
    raise exception 'Journal is unbalanced: debit % <> credit %', v_total_debit, v_total_credit;
  end if;
  if round(v_total_debit, 2) = 0 then
    raise exception 'A zero-value journal is not allowed';
  end if;

  insert into journal_entries (
    company_id, period_id, posting_date, currency, exchange_rate, memo, status,
    correlation_id, idempotency_key, total_debit, total_credit, posted_at, posted_by, created_by
  ) values (
    p_company, v_period_id, p_date, p_currency, 1, p_memo, 'posted',
    'corr_' || gen_random_uuid(), 'jm_' || gen_random_uuid(),
    round(v_total_debit, 2), round(v_total_credit, 2), now(), p_posted_by, p_posted_by
  ) returning id into v_journal_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_line_no := v_line_no + 1;
    insert into journal_lines (journal_id, company_id, account_code, debit, credit, description, line_no)
    values (
      v_journal_id, p_company, v_line->>'account_code',
      round(coalesce((v_line->>'debit')::numeric, 0), 2),
      round(coalesce((v_line->>'credit')::numeric, 0), 2),
      v_line->>'description', v_line_no
    );
  end loop;

  return v_journal_id;
end $$;

commit;
