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
