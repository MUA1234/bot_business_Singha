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
