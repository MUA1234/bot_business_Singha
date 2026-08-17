-- 0068_ai_atomic_case_persistence.sql
-- Completion-program Phase 1B (owner mandate): the AI-manager analysis paths (manual command-centre
-- + WhatsApp thread analysis) previously created tasks ONE AT A TIME with swallowed per-insert
-- errors, used the constant source identity "manual" (no dedupe), and LOG-AND-CONTINUED when the
-- management-case insert failed — so a retry could duplicate tasks and a "successful" analysis could
-- silently have no durable case.
--
-- This migration moves that persistence to ONE atomic, idempotent, service-only DB boundary:
--   * management_cases gains a caller-supplied idempotency key, UNIQUE per company;
--   * tasks gain a management_case_id linkage (the case's evidence/correlation record ties the
--     created tasks to the observation that proposed them);
--   * create_management_case_atomic(...) inserts the case + ALL its captured tasks + the audit
--     event in one transaction — any failure rolls back everything; replaying the same
--     (company, idempotency_key) returns the ORIGINAL result and creates nothing.
--
-- Invariants enforced AT THIS BOUNDARY (not just in app code):
--   * the AI can only create low-risk `captured` tasks here — the requested status is ignored;
--   * at most 20 tasks per case (the app-side cap, now fail-closed at the DB);
--   * the caller must be the trusted service context (PostgREST service_role JWT) — an
--     unclassifiable or API-role caller is refused 42501 (fail closed);
--   * company scope is a trusted PARAMETER — never read from model-influenced JSON.
--
-- Forward-only, idempotent DDL. No feature flag (this is a correctness boundary, not a capability).

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) Schema: idempotency identity + task linkage.
-- ─────────────────────────────────────────────────────────────────────────────
alter table management_cases add column if not exists idempotency_key text;
create unique index if not exists management_cases_company_idem_uq
  on management_cases (company_id, idempotency_key)
  where idempotency_key is not null;

alter table tasks add column if not exists management_case_id uuid references management_cases(id) on delete set null;
create index if not exists tasks_management_case_idx on tasks (management_case_id) where management_case_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) The atomic RPC. SECURITY DEFINER; canonical search_path (the permanent
-- search-path gate enforces exact `pg_catalog, extensions, public, pg_temp`).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.create_management_case_atomic(
  p_company uuid,
  p_idempotency_key text,
  p_case jsonb,
  p_tasks jsonb,
  p_actor uuid,
  p_audit_action text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, extensions, public, pg_temp as $$
declare
  v_case_id uuid;
  v_created int := 0;
  v_requires_human boolean;
  v_task jsonb;
  v_title text;
  v_existing record;
begin
  -- Trusted service boundary only. caller_jwt_role() is NULL for an unclassifiable caller → refuse.
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'create_management_case_atomic is a service-only boundary (caller is not the service context)'
      using errcode = 'insufficient_privilege';
  end if;

  if p_company is null then raise exception 'p_company is required'; end if;
  if coalesce(btrim(p_idempotency_key), '') = '' then
    raise exception 'p_idempotency_key is required — a constant/absent identity would defeat dedupe';
  end if;
  if p_case is null or jsonb_typeof(p_case) is distinct from 'object' then
    raise exception 'p_case must be a JSON object';
  end if;
  if p_tasks is null or jsonb_typeof(p_tasks) is distinct from 'array' then
    raise exception 'p_tasks must be a JSON array';
  end if;
  if jsonb_array_length(p_tasks) > 20 then
    raise exception 'at most 20 tasks per management case (got %)', jsonb_array_length(p_tasks);
  end if;
  if p_audit_action not in ('manager.analyzed', 'manager.thread_analyzed') then
    raise exception 'unsupported audit action %', p_audit_action;
  end if;

  v_requires_human := coalesce((p_case->>'requires_human')::boolean, false);

  -- Idempotent case insert. A concurrent duplicate blocks on the unique index until the first
  -- transaction commits, then takes the conflict path — so two identical submissions can never
  -- both create a case/task set.
  insert into public.management_cases (
    company_id, idempotency_key, correlation_id, source_event_id, ai_run_id,
    confirmed_facts, inferred_facts, evidence_refs, uncertainty, missing_info,
    confidence, required_authority, decisions, requires_human, created_tasks, created_by
  ) values (
    p_company, btrim(p_idempotency_key),
    p_case->>'correlation_id', p_case->>'source_event_id', p_case->>'ai_run_id',
    coalesce(p_case->'confirmed_facts', '[]'::jsonb),
    coalesce(p_case->'inferred_facts', '[]'::jsonb),
    coalesce(p_case->'evidence_refs', '[]'::jsonb),
    p_case->>'uncertainty',
    coalesce(p_case->'missing_info', '[]'::jsonb),
    nullif(p_case->>'confidence', '')::numeric,
    p_case->>'required_authority',
    coalesce(p_case->'decisions', '[]'::jsonb),
    v_requires_human, 0, p_actor
  )
  on conflict (company_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_case_id;

  if v_case_id is null then
    -- Replay: return the ORIGINAL result; create nothing.
    select id, created_tasks, requires_human into v_existing
      from public.management_cases
     where company_id = p_company and idempotency_key = btrim(p_idempotency_key);
    if v_existing.id is null then
      raise exception 'management case conflict without a visible original (unexpected)';
    end if;
    return jsonb_build_object(
      'duplicate', true,
      'case_id', v_existing.id,
      'created_tasks', v_existing.created_tasks,
      'requires_human', v_existing.requires_human
    );
  end if;

  -- All tasks or none: any invalid element raises and rolls the ENTIRE case back.
  for v_task in select value from jsonb_array_elements(p_tasks) loop
    v_title := btrim(coalesce(v_task->>'title', ''));
    if v_title = '' then
      raise exception 'task % has an empty title — the whole case is rolled back', v_created + 1;
    end if;
    insert into public.tasks (
      company_id, management_case_id, title, description,
      status, requires_evidence, created_by
    ) values (
      p_company, v_case_id, left(v_title, 300), nullif(v_task->>'note', ''),
      'captured',                                      -- forced: the AI proposes; only low-risk capture
      coalesce((v_task->>'requires_evidence')::boolean, false),
      p_actor
    );
    v_created := v_created + 1;
  end loop;

  update public.management_cases set created_tasks = v_created where id = v_case_id;

  -- The required audit event, inside the same transaction.
  insert into public.audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (
    p_company, 'ai', p_actor, p_audit_action, 'management_case', v_case_id::text,
    jsonb_build_object(
      'created_tasks', v_created,
      'correlation_id', p_case->>'correlation_id',
      'source_event_id', p_case->>'source_event_id',
      'requires_human', v_requires_human,
      'idempotency_key', btrim(p_idempotency_key)
    )
  );

  return jsonb_build_object(
    'duplicate', false,
    'case_id', v_case_id,
    'created_tasks', v_created,
    'requires_human', v_requires_human
  );
end $$;

-- Service-only EXECUTE, signature-exact.
do $$
begin
  revoke all on function public.create_management_case_atomic(uuid,text,jsonb,jsonb,uuid,text) from public;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function public.create_management_case_atomic(uuid,text,jsonb,jsonb,uuid,text) from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    revoke all on function public.create_management_case_atomic(uuid,text,jsonb,jsonb,uuid,text) from authenticated;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant execute on function public.create_management_case_atomic(uuid,text,jsonb,jsonb,uuid,text) to service_role;
  end if;
end $$;
