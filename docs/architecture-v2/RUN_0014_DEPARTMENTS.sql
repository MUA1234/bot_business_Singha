-- ============================================================================
-- Singha — migration 0014 (departments expansion): CRM, procurement, legal, fleet.
-- Run ONCE on the Singha project (you already ran 0008–0013).
-- Single transaction; idempotent; additive (no existing table touched).
-- ============================================================================

begin;
create extension if not exists pgcrypto;

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

commit;
