-- ============================================================
-- Combined migrations 0001–0006 for Singha Business Manager.
-- Paste this whole file into the Supabase SQL Editor and Run.
-- Safe to run once on a fresh project. Order is preserved.
-- ============================================================

-- >>>>>>>>>>>>>>>>>>>> src/db/migrations/0001_org_and_access.sql <<<<<<<<<<<<<<<<<<<<
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


-- >>>>>>>>>>>>>>>>>>>> src/db/migrations/0002_accounting_core.sql <<<<<<<<<<<<<<<<<<<<
-- 0002_accounting_core.sql
-- Accounting Core v0: fiscal years, periods, chart of accounts, journals + lines,
-- reversals, immutability. Guide §3 Phase 3, §5, §9.
--
-- Money is stored as numeric(20,4) — fixed precision, never float (guide #11).

create table fiscal_years (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  name text not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'open' check (status in ('open','closed')),
  created_at timestamptz not null default now(),
  unique (company_id, name),
  check (end_date > start_date)
);

create table accounting_periods (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  fiscal_year_id uuid not null references fiscal_years(id) on delete restrict,
  name text not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'open' check (status in ('open','closed','locked')),
  closed_at timestamptz,
  closed_by uuid,
  created_at timestamptz not null default now(),
  unique (company_id, start_date, end_date),
  check (end_date >= start_date)
);

create table chart_of_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  code text not null,
  name text not null,
  type text not null check (type in ('asset','liability','equity','income','expense')),
  parent_code text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, code)
);

create table currencies (
  code char(3) primary key,
  name text not null,
  minor_units smallint not null default 2
);

create table exchange_rates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  from_currency char(3) not null,
  to_currency char(3) not null,
  rate numeric(20,10) not null,
  as_of date not null,
  unique (company_id, from_currency, to_currency, as_of)
);

create table tax_codes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  code text not null,
  name text not null,
  rate numeric(9,6) not null default 0,
  is_active boolean not null default true,
  unique (company_id, code)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Journals. A posted journal is immutable (guide §9). We model state so drafts
-- can exist, but a trigger blocks UPDATE/DELETE once status = 'posted'.
-- ─────────────────────────────────────────────────────────────────────────────
create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  period_id uuid references accounting_periods(id),
  posting_date date not null,
  currency char(3) not null,
  exchange_rate numeric(20,10) not null default 1,
  memo text,
  status text not null default 'draft' check (status in ('draft','posted','reversed')),
  reversal_of_journal_id uuid references journal_entries(id),
  source_event_id uuid,
  approval_request_id uuid,
  correlation_id text not null,
  idempotency_key text not null,
  total_debit numeric(20,4) not null default 0,
  total_credit numeric(20,4) not null default 0,
  posted_at timestamptz,
  posted_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  -- Idempotency: a given external write posts at most one journal (guide §7).
  unique (company_id, idempotency_key),
  -- Structural guarantee of balance at rest (engine enforces during build too).
  check (total_debit = total_credit)
);

create table journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references journal_entries(id) on delete cascade,
  company_id uuid not null references companies(id) on delete restrict,
  account_code text not null,
  debit numeric(20,4) not null default 0,
  credit numeric(20,4) not null default 0,
  description text,
  project_id uuid references projects(id),
  division_id uuid references divisions(id),
  site_id uuid references sites(id),
  cost_centre_id uuid references cost_centres(id),
  customer_id uuid,
  supplier_id uuid,
  employee_id uuid,
  line_no integer not null,
  -- exactly one side non-zero, neither negative
  check (debit >= 0 and credit >= 0),
  check ((debit = 0) <> (credit = 0))
);

create index on journal_entries (company_id, posting_date);
create index on journal_lines (journal_id);
create index on journal_lines (company_id, account_code);

-- ── Immutability guard: block edits/deletes of posted journals (guide §9). ──
create or replace function public.block_posted_mutation()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'DELETE') then
    if old.status = 'posted' then
      raise exception 'Posted journal % is immutable and cannot be deleted', old.id;
    end if;
    return old;
  end if;
  -- UPDATE: the only permitted change to a posted journal is status→reversed
  -- (which itself is driven by a reversing entry, not an edit of the amounts).
  if old.status = 'posted' then
    if new.status = 'reversed'
       and new.total_debit = old.total_debit
       and new.total_credit = old.total_credit
       and new.currency = old.currency
       and new.posting_date = old.posting_date then
      return new;
    end if;
    raise exception 'Posted journal % is immutable (attempted mutation)', old.id;
  end if;
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end;
$$;

create trigger trg_block_posted_mutation
  before update or delete on journal_entries
  for each row execute function public.block_posted_mutation();

-- Lines of a posted journal cannot change at all.
create or replace function public.block_posted_line_mutation()
returns trigger language plpgsql as $$
declare parent_status text;
begin
  select status into parent_status from journal_entries
    where id = coalesce(new.journal_id, old.journal_id);
  if parent_status = 'posted' then
    raise exception 'Lines of a posted journal are immutable';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger trg_block_posted_line_mutation
  before update or delete on journal_lines
  for each row execute function public.block_posted_line_mutation();

-- RLS
alter table fiscal_years        enable row level security;
alter table accounting_periods  enable row level security;
alter table chart_of_accounts   enable row level security;
alter table exchange_rates      enable row level security;
alter table tax_codes           enable row level security;
alter table journal_entries     enable row level security;
alter table journal_lines       enable row level security;

create policy fy_read   on fiscal_years       for select using (has_company_access(company_id));
create policy ap_read   on accounting_periods for select using (has_company_access(company_id));
create policy coa_read  on chart_of_accounts  for select using (has_company_access(company_id));
create policy fx_read   on exchange_rates     for select using (has_company_access(company_id));
create policy tax_read  on tax_codes          for select using (has_company_access(company_id));
create policy je_read   on journal_entries    for select using (has_company_access(company_id));
create policy jl_read   on journal_lines      for select using (has_company_access(company_id));

-- Posting is a privileged, server-side action gated by permission.
create policy je_post on journal_entries for insert with check (has_permission(company_id, 'post'));
create policy jl_post on journal_lines   for insert with check (has_permission(company_id, 'post'));


-- >>>>>>>>>>>>>>>>>>>> src/db/migrations/0003_subledgers.sql <<<<<<<<<<<<<<<<<<<<
-- 0003_subledgers.sql
-- Parties + operational subledgers. Guide §5, §9 (advances outstanding until
-- settled; reimbursements cannot be paid twice; overpayment control).

create table customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  name text not null,
  email text,
  phone text,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  name text not null,
  email text,
  phone text,
  -- Bank details change is a sensitive, separately-approved action (guide §9/§10).
  bank_account_name text,
  bank_account_number text,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

-- Append-only history of supplier bank-detail changes (guide §9).
create table supplier_bank_detail_changes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  supplier_id uuid not null references suppliers(id) on delete restrict,
  old_account_number text,
  new_account_number text,
  requested_by uuid not null,
  approved_by uuid,
  approval_request_id uuid,
  created_at timestamptz not null default now()
);

create table employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  user_id uuid references users(id),
  name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table customer_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  customer_id uuid not null references customers(id),
  invoice_number text not null,
  currency char(3) not null,
  issue_date date not null,
  due_date date,
  total_amount numeric(20,4) not null,
  amount_settled numeric(20,4) not null default 0,
  status text not null default 'draft' check (status in ('draft','issued','part_paid','paid','cancelled','credited')),
  journal_id uuid references journal_entries(id),
  source_event_id uuid,
  correlation_id text,
  created_at timestamptz not null default now(),
  unique (company_id, invoice_number),
  check (amount_settled >= 0 and amount_settled <= total_amount)
);

create table customer_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references customer_invoices(id) on delete cascade,
  company_id uuid not null references companies(id) on delete restrict,
  description text not null,
  quantity numeric(20,4) not null default 1,
  unit_price numeric(20,4) not null,
  tax_code text,
  amount numeric(20,4) not null,
  project_id uuid references projects(id)
);

create table supplier_bills (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  supplier_id uuid not null references suppliers(id),
  bill_number text,
  currency char(3) not null,
  issue_date date not null,
  due_date date,
  total_amount numeric(20,4) not null,
  amount_settled numeric(20,4) not null default 0,
  status text not null default 'draft' check (status in ('draft','approved','part_paid','paid','cancelled','credited')),
  journal_id uuid references journal_entries(id),
  source_event_id uuid,
  correlation_id text,
  created_at timestamptz not null default now(),
  check (amount_settled >= 0 and amount_settled <= total_amount)
);

create table supplier_bill_lines (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references supplier_bills(id) on delete cascade,
  company_id uuid not null references companies(id) on delete restrict,
  description text not null,
  quantity numeric(20,4) not null default 1,
  unit_price numeric(20,4) not null,
  tax_code text,
  amount numeric(20,4) not null,
  project_id uuid references projects(id)
);

-- Payments (out) and receipts (in) + allocations to invoices/bills.
create table payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  direction text not null check (direction in ('out','in')),
  party_type text check (party_type in ('customer','supplier','employee')),
  party_id uuid,
  currency char(3) not null,
  amount numeric(20,4) not null check (amount > 0),
  amount_allocated numeric(20,4) not null default 0,
  method text not null,
  payment_date date not null,
  bank_account_id uuid,
  cash_account_id uuid,
  journal_id uuid references journal_entries(id),
  source_event_id uuid,
  correlation_id text,
  idempotency_key text,
  status text not null default 'recorded' check (status in ('recorded','allocated','void')),
  created_at timestamptz not null default now(),
  unique (company_id, idempotency_key),
  check (amount_allocated >= 0 and amount_allocated <= amount)
);

create table payment_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  payment_id uuid not null references payments(id) on delete cascade,
  target_type text not null check (target_type in ('customer_invoice','supplier_bill','employee_advance')),
  target_id uuid not null,
  amount numeric(20,4) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create table receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  customer_id uuid references customers(id),
  amount numeric(20,4) not null check (amount > 0),
  currency char(3) not null,
  received_date date not null,
  payment_id uuid references payments(id),
  created_at timestamptz not null default now()
);

create table credit_notes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  party_type text not null check (party_type in ('customer','supplier')),
  party_id uuid not null,
  amount numeric(20,4) not null check (amount > 0),
  currency char(3) not null,
  reason text,
  created_at timestamptz not null default now()
);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  party_type text not null check (party_type in ('customer','supplier')),
  party_id uuid not null,
  amount numeric(20,4) not null check (amount > 0),
  currency char(3) not null,
  created_at timestamptz not null default now()
);

-- Employee advances remain outstanding until settled (guide §9).
create table employee_advances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  employee_id uuid not null references employees(id),
  currency char(3) not null,
  amount numeric(20,4) not null check (amount > 0),
  amount_settled numeric(20,4) not null default 0,
  issued_date date not null,
  status text not null default 'outstanding' check (status in ('outstanding','part_settled','settled','written_off')),
  journal_id uuid references journal_entries(id),
  correlation_id text,
  created_at timestamptz not null default now(),
  check (amount_settled >= 0 and amount_settled <= amount)
);

create table expense_claims (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  employee_id uuid not null references employees(id),
  currency char(3) not null,
  amount numeric(20,4) not null check (amount > 0),
  purpose text,
  status text not null default 'submitted' check (status in ('submitted','approved','rejected','reimbursed')),
  source_event_id uuid,
  correlation_id text,
  created_at timestamptz not null default now()
);

-- A reimbursement can be paid at most once (guide §9). Enforced by a unique
-- partial index on the claim it settles.
create table reimbursements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  expense_claim_id uuid not null references expense_claims(id),
  employee_id uuid not null references employees(id),
  currency char(3) not null,
  amount numeric(20,4) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending','paid','void')),
  payment_id uuid references payments(id),
  created_at timestamptz not null default now()
);
create unique index one_paid_reimbursement_per_claim
  on reimbursements (expense_claim_id) where (status = 'paid');

create table loans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  counterparty text,
  principal numeric(20,4) not null,
  currency char(3) not null,
  start_date date not null,
  interest_rate numeric(9,6) not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table loan_schedules (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references loans(id) on delete cascade,
  company_id uuid not null references companies(id) on delete restrict,
  due_date date not null,
  principal_due numeric(20,4) not null default 0,
  interest_due numeric(20,4) not null default 0,
  status text not null default 'scheduled'
);

-- RLS: read for company members; writes go through server (service role / policies
-- added per-action in later migrations as workflows land).
do $$
declare t text;
begin
  foreach t in array array[
    'customers','suppliers','supplier_bank_detail_changes','employees',
    'customer_invoices','customer_invoice_lines','supplier_bills','supplier_bill_lines',
    'payments','payment_allocations','receipts','credit_notes','refunds',
    'employee_advances','expense_claims','reimbursements','loans','loan_schedules'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (has_company_access(company_id))', t||'_read', t);
  end loop;
end $$;


-- >>>>>>>>>>>>>>>>>>>> src/db/migrations/0004_intelligence_and_evidence.sql <<<<<<<<<<<<<<<<<<<<
-- 0004_intelligence_and_evidence.sql
-- Financial Event Intelligence Layer + evidence + audit. Guide §5 (intelligence
-- and evidence), §6 (lifecycle), §7 (versions), invariant #9 (persist-before-process,
-- idempotent, dedup, retryable, auditable), §13 (append-only audit).

-- Raw source events. EVERY external event is stored before processing so a failed
-- process never loses the original (guide invariant #9). Idempotent on provider id.
create table source_events (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('whatsapp','email','upload','google_sheets','bank_file','operational','manual')),
  provider_message_id text,
  company_id uuid references companies(id),        -- may be null until resolved
  received_at timestamptz not null default now(),
  raw_payload jsonb not null,
  content_hash text,                               -- dedup identical bodies/bytes
  idempotency_key text not null,
  correlation_id text not null,
  status text not null default 'received'
    check (status in ('received','processing','processed','failed','dead_letter','duplicate')),
  attempts integer not null default 0,
  last_error text,
  processed_at timestamptz,
  -- Hard idempotency: a given external message is stored once (guide invariant #9).
  unique (idempotency_key)
);
create index on source_events (status);
create index on source_events (content_hash);

-- Dead-letter queue for events that exhausted retries (guide §13).
create table dead_letter_events (
  id uuid primary key default gen_random_uuid(),
  source_event_id uuid not null references source_events(id),
  reason text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Documents / receipts / invoices as evidence.
create table documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  source_event_id uuid references source_events(id),
  storage_path text not null,
  mime_type text,
  byte_size bigint,
  content_hash text,                               -- prevent duplicate receipt upload
  scanned_status text not null default 'pending'
    check (scanned_status in ('pending','clean','infected','skipped')),
  created_at timestamptz not null default now(),
  created_by uuid,
  -- same bytes can't be uploaded twice within a company (guide §9 dedup)
  unique (company_id, content_hash)
);

create table document_extractions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  company_id uuid references companies(id),
  ai_run_id text,
  extracted jsonb not null,
  created_at timestamptz not null default now()
);

create table conversation_references (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  source_event_id uuid references source_events(id),
  channel text,
  external_ref text,
  snippet text,
  created_at timestamptz not null default now()
);

-- The financial event itself — the intelligence-layer draft that may become a
-- journal. Lifecycle state lives here (guide §6); transitions are backend-enforced.
create table financial_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  source_event_id uuid references source_events(id),
  event_type text not null,
  state text not null default 'detected',
  amount numeric(20,4),
  currency char(3),
  transaction_date date,
  counterparty_name text,
  purpose text,
  payment_method text,
  paid_by_employee_id uuid references employees(id),
  confidence_overall numeric(5,4),
  risk_flags text[] not null default '{}',
  missing_fields text[] not null default '{}',
  recommended_action text,
  current_version integer not null default 1,
  correlation_id text not null,
  idempotency_key text,
  journal_id uuid references journal_entries(id),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now()
);
create index on financial_events (company_id, state);

-- Immutable version history of each financial event (guide §5 financial_event_versions).
create table financial_event_versions (
  id uuid primary key default gen_random_uuid(),
  financial_event_id uuid not null references financial_events(id) on delete cascade,
  company_id uuid references companies(id),
  version integer not null,
  snapshot jsonb not null,
  changed_by uuid,
  change_reason text,
  created_at timestamptz not null default now(),
  unique (financial_event_id, version)
);

-- Split allocations for one event across projects/dimensions (guide §5).
create table financial_event_allocations (
  id uuid primary key default gen_random_uuid(),
  financial_event_id uuid not null references financial_events(id) on delete cascade,
  company_id uuid references companies(id),
  amount numeric(20,4) not null check (amount > 0),
  project_id uuid references projects(id),
  division_id uuid references divisions(id),
  site_id uuid references sites(id),
  cost_centre_id uuid references cost_centres(id),
  account_code text
);

create table ai_runs (
  id text primary key,                             -- ai_<uuid> from the gateway
  company_id uuid references companies(id),
  route text not null,
  model text not null,
  prompt_version text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(20,6) not null default 0,
  validation_ok boolean not null,
  validation_issues jsonb,
  confidence_overall numeric(5,4),
  correlation_id text,
  created_at timestamptz not null default now()
);

create table ai_recommendations (
  id uuid primary key default gen_random_uuid(),
  financial_event_id uuid references financial_events(id) on delete cascade,
  company_id uuid references companies(id),
  ai_run_id text references ai_runs(id),
  recommended_action text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table clarification_requests (
  id uuid primary key default gen_random_uuid(),
  financial_event_id uuid not null references financial_events(id) on delete cascade,
  company_id uuid references companies(id),
  missing_fields text[] not null,
  message text not null,
  channel text,
  status text not null default 'open' check (status in ('open','answered','cancelled')),
  created_at timestamptz not null default now()
);

create table duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  financial_event_id uuid not null references financial_events(id) on delete cascade,
  matched_event_id uuid references financial_events(id),
  score numeric(5,4) not null,
  reasons text[] not null default '{}',
  resolution text not null default 'open' check (resolution in ('open','confirmed_duplicate','not_duplicate')),
  created_at timestamptz not null default now()
);

create table policy_evaluations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  financial_event_id uuid references financial_events(id) on delete cascade,
  outcome text not null,
  matched_rule_id text,
  required_approver_roles text[] not null default '{}',
  approvals_required integer not null default 0,
  reasons text[] not null default '{}',
  policy_version integer,
  created_at timestamptz not null default now()
);

create table approval_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  financial_event_id uuid references financial_events(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  approvals_required integer not null default 1,
  submitted_by uuid not null,
  created_at timestamptz not null default now()
);

create table approval_actions (
  id uuid primary key default gen_random_uuid(),
  approval_request_id uuid not null references approval_requests(id) on delete cascade,
  company_id uuid not null references companies(id),
  actor_user_id uuid not null,
  action text not null check (action in ('approve','reject')),
  note text,
  created_at timestamptz not null default now(),
  -- one action per approver per request (dual-control counts distinct people)
  unique (approval_request_id, actor_user_id)
);

-- Append-only audit log (guide §13). No update/delete allowed.
create table audit_events (
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
create index on audit_events (company_id, created_at);

create or replace function public.block_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;
create trigger trg_audit_append_only
  before update or delete on audit_events
  for each row execute function public.block_audit_mutation();

-- RLS
do $$
declare t text;
begin
  foreach t in array array[
    'source_events','documents','document_extractions','conversation_references',
    'financial_events','financial_event_versions','financial_event_allocations',
    'ai_runs','ai_recommendations','clarification_requests','duplicate_candidates',
    'policy_evaluations','approval_requests','approval_actions','audit_events'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for select using (company_id is null or has_company_access(company_id))',
      t||'_read', t);
  end loop;
end $$;

alter table dead_letter_events enable row level security;
create policy dle_read on dead_letter_events for select using (true);


-- >>>>>>>>>>>>>>>>>>>> src/db/migrations/0005_banking_and_planning.sql <<<<<<<<<<<<<<<<<<<<
-- 0005_banking_and_planning.sql
-- Banking + reconciliation + planning/forecasting. Guide §3 Phases 4 & 6, §5, §9
-- (imported bank lines cannot be reconciled twice beyond available amount).

create table bank_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  name text not null,
  account_number text,
  currency char(3) not null,
  gl_account_code text,                     -- link to chart_of_accounts
  opening_balance numeric(20,4) not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table cash_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  name text not null,
  currency char(3) not null,
  gl_account_code text,
  opening_balance numeric(20,4) not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table bank_imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  bank_account_id uuid not null references bank_accounts(id),
  filename text,
  content_hash text,                        -- prevent re-importing the same file
  row_count integer not null default 0,
  imported_by uuid,
  created_at timestamptz not null default now(),
  unique (company_id, content_hash)
);

create table bank_transactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  bank_account_id uuid not null references bank_accounts(id),
  bank_import_id uuid references bank_imports(id),
  txn_date date not null,
  description text,
  amount numeric(20,4) not null,            -- signed: +in / -out
  currency char(3) not null,
  external_ref text,
  -- normalized fingerprint for dedup of the same statement line
  fingerprint text not null,
  amount_matched numeric(20,4) not null default 0,
  status text not null default 'unmatched'
    check (status in ('unmatched','part_matched','matched','ignored')),
  created_at timestamptz not null default now(),
  unique (company_id, bank_account_id, fingerprint)
);

create table reconciliation_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  bank_account_id uuid not null references bank_accounts(id),
  opened_by uuid,
  status text not null default 'open' check (status in ('open','closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table reconciliation_matches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  session_id uuid references reconciliation_sessions(id),
  bank_transaction_id uuid not null references bank_transactions(id),
  target_type text not null check (target_type in ('payment','receipt','journal_line')),
  target_id uuid not null,
  amount numeric(20,4) not null check (amount > 0),
  confirmed_by uuid,                         -- AI may suggest; human confirms (guide §4)
  is_ai_suggested boolean not null default false,
  created_at timestamptz not null default now()
);

create table cash_counts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  cash_account_id uuid not null references cash_accounts(id),
  counted_amount numeric(20,4) not null,
  counted_at timestamptz not null default now(),
  counted_by uuid,
  variance numeric(20,4) not null default 0
);

-- Planning: budgets, commitments, forecasts (actual vs committed vs forecast kept
-- SEPARATE per guide invariant #13).
create table budgets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  name text not null,
  fiscal_year_id uuid references fiscal_years(id),
  currency char(3) not null,
  created_at timestamptz not null default now()
);

create table budget_lines (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references budgets(id) on delete cascade,
  company_id uuid not null references companies(id) on delete restrict,
  account_code text,
  project_id uuid references projects(id),
  period_id uuid references accounting_periods(id),
  amount numeric(20,4) not null
);

create table commitments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  description text not null,
  counterparty text,
  currency char(3) not null,
  amount numeric(20,4) not null,
  committed_date date,
  expected_settlement_date date,
  status text not null default 'open' check (status in ('open','partially_settled','settled','cancelled')),
  created_at timestamptz not null default now()
);

create table recurring_obligations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  description text not null,
  currency char(3) not null,
  amount numeric(20,4) not null,
  cadence text not null check (cadence in ('weekly','monthly','quarterly','annual')),
  next_due date,
  created_at timestamptz not null default now()
);

create table forecasts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete restrict,
  name text not null,
  currency char(3) not null,
  horizon_days integer not null default 90,
  created_at timestamptz not null default now()
);

create table forecast_scenarios (
  id uuid primary key default gen_random_uuid(),
  forecast_id uuid not null references forecasts(id) on delete cascade,
  company_id uuid not null references companies(id) on delete restrict,
  kind text not null check (kind in ('best','expected','worst')),
  assumptions jsonb
);

create table forecast_lines (
  id uuid primary key default gen_random_uuid(),
  forecast_id uuid not null references forecasts(id) on delete cascade,
  scenario_id uuid references forecast_scenarios(id) on delete cascade,
  company_id uuid not null references companies(id) on delete restrict,
  as_of date not null,
  category text not null,
  inflow numeric(20,4) not null default 0,
  outflow numeric(20,4) not null default 0,
  confidence numeric(5,4)
);

-- RLS
do $$
declare t text;
begin
  foreach t in array array[
    'bank_accounts','cash_accounts','bank_imports','bank_transactions',
    'reconciliation_sessions','reconciliation_matches','cash_counts',
    'budgets','budget_lines','commitments','recurring_obligations',
    'forecasts','forecast_scenarios','forecast_lines'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select using (has_company_access(company_id))', t||'_read', t);
  end loop;
end $$;


-- >>>>>>>>>>>>>>>>>>>> src/db/migrations/0006_approval_policies.sql <<<<<<<<<<<<<<<<<<<<
-- 0006_approval_policies.sql
-- Owner-configured approval policy (guide §18 thresholds / §10 separation of duties).
-- The policy is DATA, evaluated by the deterministic engine in src/policy/authority.ts
-- (never by free-text AI). Stored as validated JSONB so the whole `ApprovalPolicy`
-- shape (rules, bands, never_auto) versions atomically. Exactly one active row per
-- company; new versions supersede rather than mutate (auditable history, guide §13).

create table approval_policies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  version integer not null,
  policy jsonb not null,               -- matches schemas/approval-policy.ts (Zod-validated on read)
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (company_id, version)
);

-- At most one active policy per company (the one the pipeline evaluates against).
create unique index approval_policies_one_active
  on approval_policies (company_id) where is_active;

alter table approval_policies enable row level security;
create policy approval_policies_read on approval_policies
  for select using (has_company_access(company_id));




-- >>>>>>>>>>>>>>>>>>>> src/db/migrations/0007_app_profiles_and_orders.sql <<<<<<<<<<<<<<<<<<<<

-- 0007_app_profiles_and_orders.sql
-- The operational APP layer on top of the accounting core:
--   • employee profiles (username → department + admin flag)
--   • extensible departments catalog
--   • product / price catalog (what the AI quoting engine prices against)
--   • WhatsApp conversation + order + quotation + price-confirmation tables
--
-- Everything is company-scoped (CLAUDE.md: explicit company_id everywhere) and
-- RLS-protected. A single default company (Singha) is seeded so the pilot works
-- without a separate provisioning step. Cross-department leakage is prevented by
-- department-aware RLS + explicit filtering in server code.

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────────
-- Default company (pilot). Deterministic UUID so app code can reference it.
-- ─────────────────────────────────────────────────────────────────────────────
insert into companies (id, name, legal_name, base_currency, country, status)
values ('00000000-0000-0000-0000-00000000515a', 'Singha', 'Singha (Pvt) Ltd', 'LKR', 'LK', 'active')
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Departments catalog (extensible). Keys match src/lib/departments.ts.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists departments_catalog (
  key         text primary key,
  label       text not null,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into departments_catalog (key, label, description) values
  ('admin',       'Admin / Owner',    'Full control of the platform.'),
  ('sales',       'Sales & Orders',   'WhatsApp orders, customers and quotations.'),
  ('finance',     'Finance',          'Invoices, payments, approvals, exports.'),
  ('marketing',   'Marketing',        'Campaigns, audiences and broadcasts.'),
  ('operations',  'Operations',       'Fulfilment, tasks and delivery.'),
  ('hr',          'Human Resources',  'Staff records and internal requests.'),
  ('procurement', 'Procurement',      'Suppliers, purchasing and inventory.')
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Employee profiles. id == auth.users.id. Username is unique; login maps
-- <username>@singha.local → this row. `department` decides the dashboard.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete restrict
              default '00000000-0000-0000-0000-00000000515a',
  username    text not null unique,
  full_name   text,
  department  text not null references departments_catalog(key),
  is_admin    boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid
);

create index if not exists profiles_company_dept_idx on profiles (company_id, department);

-- Helper functions for RLS (SECURITY DEFINER so policies can read profiles).
create or replace function public.my_department()
returns text language sql stable security definer set search_path = public as $$
  select department from profiles where id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from profiles where id = auth.uid() and is_active), false)
$$;

create or replace function public.my_company()
returns uuid language sql stable security definer set search_path = public as $$
  select company_id from profiles where id = auth.uid()
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Product / price catalog. The AI quoting engine prices against this; a miss
-- means the line needs human price confirmation.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists product_catalog (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  name        text not null,
  sku         text,
  unit_price  numeric(18,2),
  currency    char(3) not null default 'LKR',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid
);
create index if not exists product_catalog_company_idx on product_catalog (company_id, is_active);

-- ─────────────────────────────────────────────────────────────────────────────
-- WhatsApp conversations (order intake state machine) + message log.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists wa_conversations (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  customer_wa_id  text not null,              -- E.164 without '+', as Meta sends it
  customer_name   text,
  status          text not null default 'collecting'
                  check (status in ('collecting','quoting','awaiting_price','quoted','closed')),
  state           jsonb not null default '{}'::jsonb,  -- collected fields so far
  last_inbound_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, customer_wa_id)
);

create table if not exists wa_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references wa_conversations(id) on delete cascade,
  company_id       uuid not null references companies(id) on delete cascade,
  direction        text not null check (direction in ('inbound','outbound')),
  body             text,
  wa_message_id    text,                      -- provider id (idempotency for sends)
  created_at       timestamptz not null default now()
);
create index if not exists wa_messages_conv_idx on wa_messages (conversation_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Orders (captured customer request) + quotations + line items.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists orders (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id) on delete cascade,
  conversation_id  uuid references wa_conversations(id) on delete set null,
  customer_name    text,
  customer_phone   text,
  customer_address text,
  customer_email   text,
  request_text     text,                      -- the raw ask, for staff context
  status           text not null default 'new'
                   check (status in ('new','quoted','confirmed','cancelled')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists orders_company_idx on orders (company_id, status);

create table if not exists quotations (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  order_id      uuid references orders(id) on delete set null,
  quote_number  text not null,
  currency      char(3) not null default 'LKR',
  status        text not null default 'draft'
                check (status in ('draft','awaiting_price','ready','sent','accepted','rejected')),
  subtotal      numeric(18,2) not null default 0,
  tax_amount    numeric(18,2) not null default 0,
  total         numeric(18,2) not null default 0,
  notes         text,
  public_token  text not null unique,         -- for the shareable /q/<token> page
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  unique (company_id, quote_number)
);
create index if not exists quotations_company_idx on quotations (company_id, status);

create table if not exists quotation_items (
  id            uuid primary key default gen_random_uuid(),
  quotation_id  uuid not null references quotations(id) on delete cascade,
  company_id    uuid not null references companies(id) on delete cascade,
  description   text not null,
  quantity      numeric(18,3) not null default 1,
  unit_price    numeric(18,2),                -- null until priced/confirmed
  currency      char(3) not null default 'LKR',
  line_total    numeric(18,2),
  status        text not null default 'needs_confirmation'
                check (status in ('priced','needs_confirmation')),
  catalog_id    uuid references product_catalog(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists quotation_items_quote_idx on quotation_items (quotation_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Price confirmations — routed to a department dashboard for a human decision.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists price_confirmations (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies(id) on delete cascade,
  quotation_id       uuid not null references quotations(id) on delete cascade,
  quotation_item_id  uuid not null references quotation_items(id) on delete cascade,
  department         text not null references departments_catalog(key),
  description        text not null,
  quantity           numeric(18,3) not null default 1,
  currency           char(3) not null default 'LKR',
  ai_suggested_price numeric(18,2),
  status             text not null default 'open'
                     check (status in ('open','resolved','dismissed')),
  resolved_price     numeric(18,2),
  resolved_by        uuid,
  resolved_at        timestamptz,
  note               text,
  created_at         timestamptz not null default now()
);
create index if not exists price_conf_dept_idx on price_confirmations (company_id, department, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security. Service-role server jobs bypass RLS; these protect any
-- user/anon-token access. Department scoping is the anti-leakage boundary.
-- ─────────────────────────────────────────────────────────────────────────────
alter table departments_catalog  enable row level security;
alter table profiles             enable row level security;
alter table product_catalog      enable row level security;
alter table wa_conversations     enable row level security;
alter table wa_messages          enable row level security;
alter table orders               enable row level security;
alter table quotations           enable row level security;
alter table quotation_items      enable row level security;
alter table price_confirmations  enable row level security;

-- Everyone signed-in may read the department catalog.
drop policy if exists dept_cat_read on departments_catalog;
create policy dept_cat_read on departments_catalog for select using (auth.uid() is not null);

-- Profiles: read your own; admins read all in their company.
drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles for select
  using (id = auth.uid() or (is_admin() and company_id = my_company()));

-- Catalog: sales/finance/admin of the company may read; admin writes (via app it's
-- service-role, but keep read policy for user-scoped dashboards).
drop policy if exists catalog_read on product_catalog;
create policy catalog_read on product_catalog for select
  using (company_id = my_company() and (is_admin() or my_department() in ('sales','finance')));

-- Orders / quotations / items: sales + admin of the company.
drop policy if exists orders_read on orders;
create policy orders_read on orders for select
  using (company_id = my_company() and (is_admin() or my_department() in ('sales','finance')));

drop policy if exists quotations_read on quotations;
create policy quotations_read on quotations for select
  using (company_id = my_company() and (is_admin() or my_department() in ('sales','finance')));

drop policy if exists quotation_items_read on quotation_items;
create policy quotation_items_read on quotation_items for select
  using (company_id = my_company() and (is_admin() or my_department() in ('sales','finance')));

-- Price confirmations: only the routed department (or admin) sees them.
drop policy if exists price_conf_read on price_confirmations;
create policy price_conf_read on price_confirmations for select
  using (company_id = my_company() and (is_admin() or department = my_department()));

-- Conversations / messages: sales + admin.
drop policy if exists wa_conv_read on wa_conversations;
create policy wa_conv_read on wa_conversations for select
  using (company_id = my_company() and (is_admin() or my_department() = 'sales'));

drop policy if exists wa_msg_read on wa_messages;
create policy wa_msg_read on wa_messages for select
  using (company_id = my_company() and (is_admin() or my_department() = 'sales'));
