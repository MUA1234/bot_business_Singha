-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_013 — widen the managed-domain vocabulary from five to twelve (R2A).
--
-- This is a QUARANTINED DRAFT UNIT, not a numbered production migration. No numbered
-- migration is created, and none is renumbered.
--
-- Units 001/005/012 constrained `department` to the five domains R1 connected. R2A connects
-- the remaining seven, so the CHECK constraints and the registered-source allowlist widen to
-- match. Everything else — the lifecycle, RLS, the atomic-create boundary, the transition
-- guard — is untouched.

-- ── 1. management_items.department ─────────────────────────────────────────────────────
alter table public.management_items
  drop constraint if exists management_items_department_check;
alter table public.management_items
  add constraint management_items_department_check check (
    department in (
      -- R1
      'finance', 'workforce', 'operations', 'crm', 'system',
      -- R2A
      'governance', 'objectives', 'marketing', 'procurement', 'assets', 'legal', 'providers'
    )
  );

-- ── 2. observation_sources.department ──────────────────────────────────────────────────
alter table public.observation_sources
  drop constraint if exists observation_sources_department_check;
alter table public.observation_sources
  add constraint observation_sources_department_check check (
    department in (
      'finance', 'workforce', 'operations', 'crm', 'system',
      'governance', 'objectives', 'marketing', 'procurement', 'assets', 'legal', 'providers'
    )
  );

-- ── 3. The atomic-create RPC's registered-source and department allowlists ─────────────
-- Re-issued with the same signature, the same service-only gate, the same pinned
-- search_path and the same validation order. ONLY the two allowlists change: an
-- unregistered source and an unmanaged department are still refused, there are simply now
-- twelve managed domains instead of five.
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
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'r1_draft_create_management_item is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  if p_company is null then
    raise exception 'company is required' using errcode = 'check_violation';
  end if;
  if to_regclass('public.companies') is not null
     and not exists (select 1 from public.companies c where c.id = p_company) then
    raise exception 'company % does not exist', p_company using errcode = 'foreign_key_violation';
  end if;

  if p_actor is not null and to_regclass('public.memberships') is not null then
    if not exists (
      select 1 from public.memberships m
       where m.user_id = p_actor and m.company_id = p_company and m.status = 'active'
    ) then
      raise exception 'actor % is not an active member of company %', p_actor, p_company
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- TWELVE registered sources, one per managed domain.
  if p_observation_source is null or p_observation_source not in (
    'finance.receivable_overdue', 'workforce.capacity_exception',
    'operations.task_exception', 'crm.followup_due', 'system.health_degraded',
    'governance.directive_overdue', 'objectives.objective_at_risk',
    'marketing.campaign_stalled', 'procurement.stock_below_reorder',
    'assets.document_expiring', 'legal.obligation_expiring', 'providers.provider_at_risk'
  ) then
    raise exception 'observation source % is not registered', coalesce(p_observation_source, '(null)')
      using errcode = 'check_violation';
  end if;

  if p_department is null or p_department not in (
    'finance', 'workforce', 'operations', 'crm', 'system',
    'governance', 'objectives', 'marketing', 'procurement', 'assets', 'legal', 'providers'
  ) then
    raise exception 'department % is not a managed domain', coalesce(p_department, '(null)')
      using errcode = 'check_violation';
  end if;

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
    if (v_ev ? 'company_id') and (v_ev->>'company_id')::uuid is distinct from p_company then
      raise exception 'cross-company evidence refused: item company %, evidence company %',
        p_company, v_ev->>'company_id'
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  select id into v_existing
    from public.management_items
   where company_id = p_company and identity_key = p_identity_key;
  if found then
    return jsonb_build_object('ok', true, 'result', 'duplicate', 'item_id', v_existing);
  end if;

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

  for v_ev in select * from jsonb_array_elements(p_evidence) loop
    insert into public.management_item_evidence
      (company_id, item_id, source_table, source_id, facts)
    values
      (p_company, v_item_id, v_ev->>'source_table', v_ev->>'source_id',
       coalesce(v_ev->'facts', '{}'::jsonb));
    v_count := v_count + 1;
  end loop;

  insert into public.management_item_transitions
    (company_id, item_id, from_state, to_state, actor_id, actor_type, reason, evidence)
  values
    (p_company, v_item_id, null, 'observed', p_actor,
     case when p_actor is null then 'system' else 'user' end,
     'detected by ' || p_observation_source
       || case when p_correlation_id is null then '' else ' [' || p_correlation_id || ']' end,
     coalesce(p_evidence, '[]'::jsonb));

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

-- CREATE OR REPLACE preserves the existing ACL, but the grants are restated so the
-- service-only boundary is explicit in this unit too rather than inherited silently.
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
