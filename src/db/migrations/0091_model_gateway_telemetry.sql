-- 0091_model_gateway_telemetry.sql
-- MOD-003: durable, company-scoped evidence for every provider attempt. Model attempts are
-- read-only analysis records; they cannot create or authorize a business side effect.

create table if not exists ai_model_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  logical_request_id text not null,
  task text not null check (task in ('extraction', 'quotation', 'management')),
  provider text not null,
  model text not null,
  attempt integer not null check (attempt > 0),
  outcome text not null check (outcome in ('succeeded', 'failed')),
  latency_ms integer not null check (latency_ms >= 0),
  error_category text,
  created_at timestamptz not null default now(),
  unique (company_id, logical_request_id, attempt)
);

create index if not exists ai_model_attempts_health_idx
  on ai_model_attempts (provider, created_at desc);

create index if not exists ai_model_attempts_company_task_idx
  on ai_model_attempts (company_id, task, created_at desc);

create table if not exists ai_model_budget_policies (
  company_id uuid not null references companies(id),
  task text not null check (task in ('extraction', 'quotation', 'management')),
  -- UTC daily ceiling. The server subtracts today's durable ai_runs cost before each route.
  max_cost_usd numeric(20,6) not null check (max_cost_usd > 0),
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (company_id, task)
);

alter table ai_model_attempts enable row level security;
alter table ai_model_budget_policies enable row level security;

revoke insert, update, delete on ai_model_attempts from authenticated;
revoke insert, update, delete on ai_model_budget_policies from authenticated;