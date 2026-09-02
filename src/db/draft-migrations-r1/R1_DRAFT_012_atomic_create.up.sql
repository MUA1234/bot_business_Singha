-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_012 — atomic management-item creation.
--
-- WHY. The runtime persisted an item with THREE separate statements: insert the item,
-- insert each evidence row, insert the opening transition. A failure between them left an
-- item with no evidence, or an item with no opening transition — an audit chain with a hole
-- in it, and an item that the zero-evidence prohibition would then refuse to advance. That
-- shape is not acceptable for staging or production, so it is replaced by one RPC in one
-- transaction: all four records, or none.
--
-- It follows the repository's established service-only pattern (migration 0068): SECURITY
-- DEFINER, a pinned canonical search_path, EXECUTE revoked from PUBLIC/anon/authenticated
-- and granted only to `service_role`, plus an IN-FUNCTION `caller_jwt_role()` gate that
-- fails closed for an unclassifiable caller — because an EXECUTE grant alone is not a
-- trust boundary.

create or replace function public.r1_draft_create_management_item(
  p_company                  uuid,
  p_actor                    uuid,
  p_department               text,
  p_kind                     text,
  p_observation_source       text,
  p_subject_table            text,
  p_subject_id               text,
  p_identity_key             text,
  p_correlation_id           text,
  p_priority                 text,
  p_confidence               numeric,
  p_required_authority       text,
  p_proposed_action_id       text,
  p_evidence_quality         text,
  p_may_run_unattended       boolean,
  p_business_deadline        timestamptz,
  p_business_deadline_source text,
  p_evidence                 jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_item_id uuid;
  v_ev      jsonb;
  v_count   int := 0;
  v_existing uuid;
begin
  -- ── 1. Trusted service boundary. NULL for an unclassifiable caller ⇒ refuse. ─────────
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'r1_draft_create_management_item is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  -- ── 2. Validate company ──────────────────────────────────────────────────────────────
  if p_company is null then
    raise exception 'company is required' using errcode = 'check_violation';
  end if;
  if to_regclass('public.companies') is not null
     and not exists (select 1 from public.companies c where c.id = p_company) then
    raise exception 'company % does not exist', p_company using errcode = 'foreign_key_violation';
  end if;

  -- ── 3. Validate the ACTOR, when one is named ────────────────────────────────────────
  -- A cycle triggered by a person carries that person; a scheduled sweep carries none. When
  -- one IS named they must be an active member of THIS company — a revoked actor cannot
  -- create management work, and an actor from another company cannot at all.
  if p_actor is not null and to_regclass('public.memberships') is not null then
    if not exists (
      select 1 from public.memberships m
       where m.user_id = p_actor and m.company_id = p_company and m.status = 'active'
    ) then
      raise exception 'actor % is not an active member of company %', p_actor, p_company
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- ── 4. Validate adapter registration ────────────────────────────────────────────────
  -- Only a REGISTERED observation source may create work. An unregistered source is a
  -- coding error or an attempt to inject items through a path nobody reviewed.
  if p_observation_source is null or p_observation_source not in (
    'finance.receivable_overdue', 'workforce.capacity_exception',
    'operations.task_exception', 'crm.followup_due', 'system.health_degraded'
  ) then
    raise exception 'observation source % is not registered', coalesce(p_observation_source, '(null)')
      using errcode = 'check_violation';
  end if;

  if p_department is null or p_department not in ('finance','workforce','operations','crm','system') then
    raise exception 'department % is not a managed domain', coalesce(p_department, '(null)')
      using errcode = 'check_violation';
  end if;

  -- ── 5. Require at least one WELL-FORMED, SAME-COMPANY evidence reference ────────────
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'array' or jsonb_array_length(p_evidence) = 0 then
    raise exception 'a management item requires at least one evidence reference'
      using errcode = 'check_violation';
  end if;
  for v_ev in select * from jsonb_array_elements(p_evidence) loop
    if coalesce(btrim(v_ev->>'source_table'), '') = ''
       or coalesce(btrim(v_ev->>'source_id'), '') = '' then
      raise exception 'evidence must name both a source table and a row id'
        using errcode = 'check_violation';
    end if;
    -- An evidence row may not claim a different company. The child trigger would also
    -- refuse it, but refusing here keeps the whole operation atomic and the error precise.
    if (v_ev ? 'company_id') and (v_ev->>'company_id')::uuid is distinct from p_company then
      raise exception 'cross-company evidence refused: item company %, evidence company %',
        p_company, v_ev->>'company_id'
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  -- ── 6. Deterministic duplicate handling ─────────────────────────────────────────────
  -- The SAME (company, identity_key) is not an error and not a second item: it is the same
  -- condition observed again. The ORIGINAL item is returned, exactly as 0068 returns the
  -- original case on a replayed idempotency key.
  select id into v_existing
    from public.management_items
   where company_id = p_company and identity_key = p_identity_key;
  if found then
    return jsonb_build_object('ok', true, 'result', 'duplicate', 'item_id', v_existing);
  end if;

  -- ── 7. Create the item in the ENFORCED initial state ────────────────────────────────
  -- `observed` is not a caller-supplied parameter: an item cannot be conjured into an
  -- advanced state, bypassing the lifecycle.
  insert into public.management_items (
    company_id, department, kind, subject_table, subject_id, identity_key, state,
    priority, confidence, required_authority, proposed_action_id, evidence_quality,
    may_run_unattended, business_deadline, business_deadline_source
  ) values (
    p_company, p_department, p_kind, p_subject_table, p_subject_id, p_identity_key, 'observed',
    p_priority, p_confidence, p_required_authority, p_proposed_action_id, p_evidence_quality,
    coalesce(p_may_run_unattended, false), p_business_deadline, p_business_deadline_source
  )
  returning id into v_item_id;

  -- ── 8. Evidence links ───────────────────────────────────────────────────────────────
  for v_ev in select * from jsonb_array_elements(p_evidence) loop
    insert into public.management_item_evidence
      (company_id, item_id, source_table, source_id, facts)
    values
      (p_company, v_item_id, v_ev->>'source_table', v_ev->>'source_id',
       coalesce(v_ev->'facts', '{}'::jsonb));
    v_count := v_count + 1;
  end loop;

  -- ── 9. The opening lifecycle transition, carrying correlation ───────────────────────
  insert into public.management_item_transitions
    (company_id, item_id, from_state, to_state, actor_id, actor_type, reason, evidence)
  values
    (p_company, v_item_id, null, 'observed', p_actor,
     case when p_actor is null then 'system' else 'user' end,
     'detected by ' || p_observation_source
       || case when p_correlation_id is null then '' else ' [' || p_correlation_id || ']' end,
     coalesce(p_evidence, '[]'::jsonb));

  -- ── 10. Audit linkage, inside the SAME transaction ──────────────────────────────────
  if to_regclass('public.audit_events') is not null then
    insert into public.audit_events
      (company_id, actor_type, actor_id, action, entity_type, entity_id, correlation_id, payload)
    values
      (p_company, case when p_actor is null then 'system' else 'user' end,
       coalesce(p_actor::text, 'system'), 'management_item.created', 'management_item',
       v_item_id::text, p_correlation_id,
       jsonb_build_object('source', p_observation_source, 'department', p_department,
                          'evidence_count', v_count, 'identity_key', p_identity_key));
  end if;

  return jsonb_build_object('ok', true, 'result', 'created', 'item_id', v_item_id,
                            'evidence_count', v_count);
end;
$$;

-- ── Permissions: service-only, minimum required ──────────────────────────────────────
do $$
declare
  sig text := 'public.r1_draft_create_management_item(uuid,uuid,text,text,text,text,text,text,text,text,numeric,text,text,text,boolean,timestamptz,text,jsonb)';
begin
  execute format('revoke all on function %s from public', sig);
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute format('revoke all on function %s from anon', sig);
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute format('revoke all on function %s from authenticated', sig);
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute format('grant execute on function %s to service_role', sig);
  end if;
end
$$;

-- ── Direct creation that bypasses the RPC is refused ────────────────────────────────────
-- The RPC is only a boundary if it is the ONLY door. Two changes close the others:
--
--   (a) the authenticated INSERT policy from unit 007 is dropped, so a manager can no
--       longer create an item directly through PostgREST; and
--   (b) a BEFORE INSERT trigger refuses a PostgREST API role outright. `service_role`
--       bypasses RLS, so the policy alone would not stop the application's own client from
--       inserting directly — this does. Inside the SECURITY DEFINER RPC `current_user` is
--       the function OWNER, not the API role, so the legitimate path is unaffected.
drop policy if exists management_items_ins on public.management_items;

create or replace function r1_draft_guard_item_insert() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    raise exception
      'management items may only be created through r1_draft_create_management_item()'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists management_items_guard_insert on management_items;
create trigger management_items_guard_insert
  before insert on management_items
  for each row execute function r1_draft_guard_item_insert();
