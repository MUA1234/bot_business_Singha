-- 0004_intelligence_and_evidence.sql
-- Financial Event Intelligence Layer + evidence + audit. Guide §5 (intelligence
-- and evidence), §6 (lifecycle), §7 (versions), invariant #9 (persist-before-process,
-- idempotent, dedup, retryable, auditable), §13 (append-only audit).

-- Raw source events. EVERY external event is stored before processing so a failed
-- process never loses the original (guide invariant #9). Idempotent on provider id.
create table source_events (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('whatsapp','email','upload','google_sheets','bank_file','operational','manual')),
  provider_message_id text,
  company_id uuid references companies(id),        -- may be null until resolved
  received_at timestamptz not null default now(),
  raw_payload jsonb not null,
  content_hash text,                               -- dedup identical bodies/bytes
  idempotency_key text not null,
  correlation_id text not null,
  status text not null default 'received'
    check (status in ('received','processing','processed','failed','dead_letter','duplicate')),
  attempts integer not null default 0,
  last_error text,
  processed_at timestamptz,
  -- Hard idempotency: a given external message is stored once (guide invariant #9).
  unique (idempotency_key)
);
create index on source_events (status);
create index on source_events (content_hash);

-- Dead-letter queue for events that exhausted retries (guide §13).
create table dead_letter_events (
  id uuid primary key default gen_random_uuid(),
  source_event_id uuid not null references source_events(id),
  reason text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Documents / receipts / invoices as evidence.
create table documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  source_event_id uuid references source_events(id),
  storage_path text not null,
  mime_type text,
  byte_size bigint,
  content_hash text,                               -- prevent duplicate receipt upload
  scanned_status text not null default 'pending'
    check (scanned_status in ('pending','clean','infected','skipped')),
  created_at timestamptz not null default now(),
  created_by uuid,
  -- same bytes can't be uploaded twice within a company (guide §9 dedup)
  unique (company_id, content_hash)
);

create table document_extractions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  company_id uuid references companies(id),
  ai_run_id text,
  extracted jsonb not null,
  created_at timestamptz not null default now()
);

create table conversation_references (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  source_event_id uuid references source_events(id),
  channel text,
  external_ref text,
  snippet text,
  created_at timestamptz not null default now()
);

-- The financial event itself — the intelligence-layer draft that may become a
-- journal. Lifecycle state lives here (guide §6); transitions are backend-enforced.
create table financial_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  source_event_id uuid references source_events(id),
  event_type text not null,
  state text not null default 'detected',
  amount numeric(20,4),
  currency char(3),
  transaction_date date,
  counterparty_name text,
  purpose text,
  payment_method text,
  paid_by_employee_id uuid references employees(id),
  confidence_overall numeric(5,4),
  risk_flags text[] not null default '{}',
  missing_fields text[] not null default '{}',
  recommended_action text,
  current_version integer not null default 1,
  correlation_id text not null,
  idempotency_key text,
  journal_id uuid references journal_entries(id),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now()
);
create index on financial_events (company_id, state);

-- Immutable version history of each financial event (guide §5 financial_event_versions).
create table financial_event_versions (
  id uuid primary key default gen_random_uuid(),
  financial_event_id uuid not null references financial_events(id) on delete cascade,
  company_id uuid references companies(id),
  version integer not null,
  snapshot jsonb not null,
  changed_by uuid,
  change_reason text,
  created_at timestamptz not null default now(),
  unique (financial_event_id, version)
);

-- Split allocations for one event across projects/dimensions (guide §5).
create table financial_event_allocations (
  id uuid primary key default gen_random_uuid(),
  financial_event_id uuid not null references financial_events(id) on delete cascade,
  company_id uuid references companies(id),
  amount numeric(20,4) not null check (amount > 0),
  project_id uuid references projects(id),
  division_id uuid references divisions(id),
  site_id uuid references sites(id),
  cost_centre_id uuid references cost_centres(id),
  account_code text
);

create table ai_runs (
  id text primary key,                             -- ai_<uuid> from the gateway
  company_id uuid references companies(id),
  route text not null,
  model text not null,
  prompt_version text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(20,6) not null default 0,
  validation_ok boolean not null,
  validation_issues jsonb,
  confidence_overall numeric(5,4),
  correlation_id text,
  created_at timestamptz not null default now()
);

create table ai_recommendations (
  id uuid primary key default gen_random_uuid(),
  financial_event_id uuid references financial_events(id) on delete cascade,
  company_id uuid references companies(id),
  ai_run_id text references ai_runs(id),
  recommended_action text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table clarification_requests (
  id uuid primary key default gen_random_uuid(),
  financial_event_id uuid not null references financial_events(id) on delete cascade,
  company_id uuid references companies(id),
  missing_fields text[] not null,
  message text not null,
  channel text,
  status text not null default 'open' check (status in ('open','answered','cancelled')),
  created_at timestamptz not null default now()
);

create table duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  financial_event_id uuid not null references financial_events(id) on delete cascade,
  matched_event_id uuid references financial_events(id),
  score numeric(5,4) not null,
  reasons text[] not null default '{}',
  resolution text not null default 'open' check (resolution in ('open','confirmed_duplicate','not_duplicate')),
  created_at timestamptz not null default now()
);

create table policy_evaluations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),
  financial_event_id uuid references financial_events(id) on delete cascade,
  outcome text not null,
  matched_rule_id text,
  required_approver_roles text[] not null default '{}',
  approvals_required integer not null default 0,
  reasons text[] not null default '{}',
  policy_version integer,
  created_at timestamptz not null default now()
);

create table approval_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  financial_event_id uuid references financial_events(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  approvals_required integer not null default 1,
  submitted_by uuid not null,
  created_at timestamptz not null default now()
);

create table approval_actions (
  id uuid primary key default gen_random_uuid(),
  approval_request_id uuid not null references approval_requests(id) on delete cascade,
  company_id uuid not null references companies(id),
  actor_user_id uuid not null,
  action text not null check (action in ('approve','reject')),
  note text,
  created_at timestamptz not null default now(),
  -- one action per approver per request (dual-control counts distinct people)
  unique (approval_request_id, actor_user_id)
);

-- Append-only audit log (guide §13). No update/delete allowed.
create table audit_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid,
  actor_type text not null check (actor_type in ('user','system','ai')),
  actor_id text,
  action text not null,
  entity_type text not null,
  entity_id text,
  correlation_id text,
  source_event_id uuid,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index on audit_events (company_id, created_at);

create or replace function public.block_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;
create trigger trg_audit_append_only
  before update or delete on audit_events
  for each row execute function public.block_audit_mutation();

-- RLS
do $$
declare t text;
begin
  foreach t in array array[
    'source_events','documents','document_extractions','conversation_references',
    'financial_events','financial_event_versions','financial_event_allocations',
    'ai_runs','ai_recommendations','clarification_requests','duplicate_candidates',
    'policy_evaluations','approval_requests','approval_actions','audit_events'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for select using (company_id is null or has_company_access(company_id))',
      t||'_read', t);
  end loop;
end $$;

alter table dead_letter_events enable row level security;
create policy dle_read on dead_letter_events for select using (true);
