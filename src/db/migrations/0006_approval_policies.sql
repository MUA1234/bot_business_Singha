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
