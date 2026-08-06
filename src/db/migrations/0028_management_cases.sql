-- 0028_management_cases.sql
-- WP5.1 (NEXT_PHASE_DEVELOPER_BRIEF) — persist a durable management case for every
-- material AI analysis: evidence, confirmed vs inferred facts, uncertainty, decisions,
-- and the correlation trail linking observation → AI run → tasks. ADDITIVE, FORWARD-
-- ONLY, IDEMPOTENT. Read-only via RLS; written by the (service-role) analyze path.

create table if not exists management_cases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  correlation_id text,
  source_event_id text,
  ai_run_id text,
  confirmed_facts jsonb not null default '[]',
  inferred_facts jsonb not null default '[]',
  evidence_refs jsonb not null default '[]',
  uncertainty text,
  missing_info jsonb not null default '[]',
  confidence numeric(5,4),
  required_authority text,
  decisions jsonb not null default '[]',
  requires_human boolean not null default false,
  created_tasks integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists management_cases_company_idx on management_cases (company_id, created_at desc);

alter table management_cases enable row level security;
drop policy if exists mgmt_cases_read on management_cases;
create policy mgmt_cases_read on management_cases for select using (has_company_access(company_id));
