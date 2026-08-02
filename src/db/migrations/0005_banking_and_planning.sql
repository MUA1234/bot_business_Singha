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
