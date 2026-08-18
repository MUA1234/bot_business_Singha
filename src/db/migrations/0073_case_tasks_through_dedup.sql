-- 0073 — the AI analysis path now creates tasks THROUGH the AIM-002 deduplication boundary.
--
-- WHY: 0071 built a server-computed task identity and an atomic create-or-return RPC, but nothing
-- in production called it. `create_management_case_atomic` (0068) still did a raw
-- `insert into public.tasks`, so the guarantee protected any FUTURE caller while the ONE path that
-- actually creates tasks — WhatsApp thread analysis and the manual command centre — kept
-- duplicating. AIM-002's own register entry recorded that gap as its residual risk. This closes it.
--
-- WHAT CHANGES: the task loop inside `create_management_case_atomic` calls
-- `public.create_task_deduplicated(...)` instead of inserting directly. There is now exactly ONE
-- implementation of task identity and create-or-return, so the two paths cannot drift.
--
-- SIGNATURE IS UNCHANGED — (uuid,text,jsonb,jsonb,uuid,text). The identity components travel as
-- OPTIONAL keys on each element of `p_tasks`:
--     { title, note, requires_evidence, source_type, source_id, purpose, target, window }
-- A caller that sends none of them gets a NULL identity, which is NOT deduplicated — byte-for-byte
-- the pre-0073 behaviour. Existing callers and tests keep working unchanged.
--
-- WHAT IT DELIBERATELY DOES NOT DO:
--   * It does not re-link an existing task to the new case. The task belongs to the case that first
--     captured it; rewriting that pointer would falsify history.
--   * It does not overwrite an existing task's description with the newer analysis's note. A
--     deduplicated task is a task that already exists; the analysis observed it again, it did not
--     revise it.
--   * It does not merge on similarity. Only the exact server-computed identity dedupes (0071).
--
-- Every identity component is TRUNCATED to its bound here rather than allowed to raise. The 0071
-- RPC rejects an oversized component, and that rejection inside this all-or-none boundary would
-- roll back an ENTIRE analysis because a model wrote a long title — turning a cosmetic input
-- problem into a lost analysis. Truncation at 256 characters of an at-most-300-character title
-- cannot plausibly collide two distinct purposes.
--
-- Forward-only, idempotent DDL. No feature flag (a correctness boundary, not a capability).

begin;

-- Report what actually happened, durably — including on the idempotent replay path.
alter table public.management_cases
  add column if not exists deduplicated_tasks int not null default 0;

comment on column public.management_cases.deduplicated_tasks is
  'Tasks this analysis proposed that already existed under the same AIM-002 identity and were therefore NOT created again.';

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
  v_deduped int := 0;
  v_requires_human boolean;
  v_task jsonb;
  v_title text;
  v_note text;
  v_existing record;
  v_task_id uuid;
  v_is_new boolean;
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
    select id, created_tasks, deduplicated_tasks, requires_human into v_existing
      from public.management_cases
     where company_id = p_company and idempotency_key = btrim(p_idempotency_key);
    if v_existing.id is null then
      raise exception 'management case conflict without a visible original (unexpected)';
    end if;
    return jsonb_build_object(
      'duplicate', true,
      'case_id', v_existing.id,
      'created_tasks', v_existing.created_tasks,
      'deduplicated_tasks', v_existing.deduplicated_tasks,
      'requires_human', v_existing.requires_human
    );
  end if;

  -- All tasks or none: any invalid element raises and rolls the ENTIRE case back.
  for v_task in select value from jsonb_array_elements(p_tasks) loop
    v_title := btrim(coalesce(v_task->>'title', ''));
    if v_title = '' then
      raise exception 'task % has an empty title — the whole case is rolled back', v_created + v_deduped + 1;
    end if;
    v_title := left(v_title, 300);
    v_note := nullif(v_task->>'note', '');

    -- AIM-002 boundary. The identity is recomputed inside the RPC (and again by the row trigger),
    -- so nothing a model wrote can widen or forge it — only supply the business facts.
    select d.task_id, d.created into v_task_id, v_is_new
      from public.create_task_deduplicated(
        p_company,
        v_title,
        left(v_task->>'source_type', 64),
        left(v_task->>'source_id', 512),
        left(v_task->>'purpose', 256),
        left(v_task->>'target', 256),
        left(v_task->>'window', 64),
        v_case_id,
        coalesce((v_task->>'requires_evidence')::boolean, false),
        p_actor
      ) d;

    if v_is_new then
      -- The note is only ever written on the task this analysis actually created.
      if v_note is not null then
        update public.tasks set description = v_note where id = v_task_id;
      end if;
      v_created := v_created + 1;
    else
      v_deduped := v_deduped + 1;
    end if;
  end loop;

  update public.management_cases
     set created_tasks = v_created, deduplicated_tasks = v_deduped
   where id = v_case_id;

  -- The required audit event, inside the same transaction.
  insert into public.audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (
    p_company, 'ai', p_actor, p_audit_action, 'management_case', v_case_id::text,
    jsonb_build_object(
      'created_tasks', v_created,
      'deduplicated_tasks', v_deduped,
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
    'deduplicated_tasks', v_deduped,
    'requires_human', v_requires_human
  );
end $$;

-- Service-only EXECUTE, signature-exact. CREATE OR REPLACE preserves grants; re-stated so the
-- boundary is legible in this file rather than inferred from 0068.
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

-- Fail closed: the replacement must still be reachable ONLY by the service context, must still be
-- SECURITY DEFINER, and must still carry the canonical search_path the 0067 gate requires.
do $$
declare
  v_oid oid;
  v_cfg text[];
begin
  select p.oid, p.proconfig into v_oid, v_cfg
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.oid::regprocedure::text = 'create_management_case_atomic(uuid,text,jsonb,jsonb,uuid,text)'
     and p.prosecdef;
  if v_oid is null then
    raise exception '0073 fail-closed: create_management_case_atomic is missing or not SECURITY DEFINER';
  end if;
  if not (v_cfg @> array['search_path=pg_catalog, extensions, public, pg_temp']) then
    raise exception '0073 fail-closed: create_management_case_atomic has a non-canonical search_path (%)', v_cfg;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and has_function_privilege('anon', v_oid, 'EXECUTE') then
    raise exception '0073 fail-closed: anon can execute create_management_case_atomic';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception '0073 fail-closed: authenticated can execute create_management_case_atomic';
  end if;
end $$;

commit;
