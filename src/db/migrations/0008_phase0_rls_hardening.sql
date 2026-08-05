-- 0008_phase0_rls_hardening.sql
-- Architecture V2 change plan §5.5 (Repair Row Level Security) — Phase 0.
-- Forward-only, idempotent, and DEFENSIVE: every table is guarded with to_regclass
-- so this runs cleanly whether or not the earlier optional migrations (e.g. 0004
-- intelligence layer) were ever applied to this database.

-- 0. Ensure the append-only audit_events table exists (my privileged-op audit needs
--    it; it normally comes from 0004, which may not be applied here).
create table if not exists audit_events (
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
create index if not exists audit_events_company_created_idx on audit_events (company_id, created_at);

create or replace function public.block_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_audit_append_only') then
    create trigger trg_audit_append_only
      before update or delete on audit_events
      for each row execute function public.block_audit_mutation();
  end if;
end $$;

-- 1. Strict company-scoped reads for the intelligence/evidence/finance tables that
--    exist. NULL-company rows become visible only to service-role workers.
do $$
declare t text;
begin
  foreach t in array array[
    'source_events','documents','document_extractions','conversation_references',
    'financial_events','financial_event_versions','financial_event_allocations',
    'ai_runs','ai_recommendations','clarification_requests','duplicate_candidates',
    'policy_evaluations','approval_requests','approval_actions','audit_events'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('alter table %I enable row level security', t);
      execute format('drop policy if exists %I on %I', t||'_read', t);
      execute format(
        'create policy %I on %I for select using (company_id is not null and has_company_access(company_id))',
        t||'_read', t);
    end if;
  end loop;
end $$;

-- 2. Dead-letter events (if present): add a company scope and remove the
--    world-readable policy so only service-role workers can read them.
do $$
begin
  if to_regclass('public.dead_letter_events') is not null then
    alter table dead_letter_events add column if not exists company_id uuid references companies(id);
    drop policy if exists dle_read on dead_letter_events;
    -- (no user-facing SELECT policy — restricted to system workers)
  end if;
end $$;
