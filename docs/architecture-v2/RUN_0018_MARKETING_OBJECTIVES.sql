-- ============================================================================
-- Singha — migration 0018: marketing (audiences, campaigns) + objectives/KPIs.
-- Run ONCE on the Singha project. Additive, idempotent, safe to re-run.
-- ============================================================================

begin;
create extension if not exists pgcrypto;

-- 0018_marketing_objectives.sql
-- Architecture V2 change plan §9 (marketing) + §10.1 (objectives/KPIs). ADDITIVE,
-- company-scoped, RLS-protected. Forward-only, idempotent.

-- ── Marketing ─────────────────────────────────────────────────────────────────
create table if not exists audiences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  source text not null default 'customers' check (source in ('customers','leads','manual')),
  criteria jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  channel text not null default 'whatsapp' check (channel in ('whatsapp','email','other')),
  audience_id uuid references audiences(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','scheduled','running','done','cancelled')),
  budget numeric(18,2),
  currency char(3) not null default 'LKR',
  sent_count integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid
);
create index if not exists campaigns_company_idx on campaigns (company_id, status);

-- ── Objectives / KPIs ─────────────────────────────────────────────────────────
create table if not exists objectives (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  title text not null,
  description text,
  metric text,
  unit text,
  target_value numeric(20,4) not null default 0,
  current_value numeric(20,4) not null default 0,
  period_start date,
  period_end date,
  status text not null default 'on_track' check (status in ('on_track','at_risk','off_track','done','cancelled')),
  owner_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists objectives_company_idx on objectives (company_id, status);

alter table audiences   enable row level security;
alter table campaigns   enable row level security;
alter table objectives  enable row level security;
drop policy if exists audiences_read on audiences;
drop policy if exists campaigns_read on campaigns;
drop policy if exists objectives_read on objectives;
create policy audiences_read  on audiences  for select using (has_company_access(company_id));
create policy campaigns_read  on campaigns  for select using (has_company_access(company_id));
create policy objectives_read on objectives for select using (has_company_access(company_id));

commit;
