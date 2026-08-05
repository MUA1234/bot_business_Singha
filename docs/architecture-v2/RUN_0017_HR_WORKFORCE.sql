-- ============================================================================
-- Singha — migration 0017: HR/workforce (profile fields + leave_requests).
-- Run ONCE on the Singha project. Additive, idempotent, safe to re-run.
-- ============================================================================

begin;
create extension if not exists pgcrypto;

-- 0017_hr_workforce.sql
-- Architecture V2 change plan §7.1 — expand employee records + leave. ADDITIVE:
-- adds HR columns to profiles (the app's employee identity) and a leave_requests
-- table. Company-scoped + RLS. Forward-only, idempotent.

alter table profiles add column if not exists phone text;
alter table profiles add column if not exists job_title text;
alter table profiles add column if not exists start_date date;
alter table profiles add column if not exists skills text[] not null default '{}';
alter table profiles add column if not exists annual_leave_days integer not null default 21;

create table if not exists leave_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  days numeric(6,1) not null default 0,
  reason text,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','cancelled')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists leave_requests_company_idx on leave_requests (company_id, status);
create index if not exists leave_requests_profile_idx on leave_requests (profile_id);

alter table leave_requests enable row level security;
drop policy if exists leave_requests_read on leave_requests;
create policy leave_requests_read on leave_requests for select using (has_company_access(company_id));

commit;
