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
