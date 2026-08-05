-- 0020_rfq.sql
-- Architecture V2 change plan §9.2 — request-for-quotation + supplier quotations.
-- ADDITIVE, company-scoped, RLS-protected. Forward-only, idempotent.

create table if not exists rfqs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'open' check (status in ('open','closed','awarded','cancelled')),
  created_at timestamptz not null default now(),
  created_by uuid
);
create index if not exists rfqs_company_idx on rfqs (company_id, status);

create table if not exists supplier_quotations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  rfq_id uuid not null references rfqs(id) on delete cascade,
  supplier_id uuid references suppliers(id) on delete set null,
  supplier_name text,
  total_amount numeric(18,2) not null default 0,
  currency char(3) not null default 'LKR',
  lead_time_days integer,
  notes text,
  is_selected boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists supplier_quotations_rfq_idx on supplier_quotations (rfq_id);

alter table rfqs                enable row level security;
alter table supplier_quotations enable row level security;
drop policy if exists rfqs_read on rfqs;
drop policy if exists supplier_quotations_read on supplier_quotations;
create policy rfqs_read on rfqs for select using (has_company_access(company_id));
create policy supplier_quotations_read on supplier_quotations for select using (has_company_access(company_id));
