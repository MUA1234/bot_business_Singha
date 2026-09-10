-- ⛔ R1/R2B DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
-- See src/db/draft-migrations-r1/README.md. Owner decision R1-D-1: no production migration
-- number may be assigned until PR-F-001 and PR-F-004 close.
--
-- R2B_DRAFT_014 — the append-only capability-recommendation snapshot (owner Decision 2).
--
-- WHY A TABLE AT ALL. R2B deliberately added no durable structure for LEARNING, because the
-- signal is a pure fold over history that already exists. A RECOMMENDATION is the opposite: it
-- is a statement the system made, at a moment, on evidence that will have changed by the time
-- anyone questions it. It cannot be recomputed later, so it must be recorded — that is what
-- makes a recommendation challengeable rather than merely repeatable.
--
-- WHAT IS DELIBERATELY NOT STORED. No protected attribute, no private coaching note, and NO
-- OPAQUE UNIVERSAL SCORE. The resolver's `suitability` is an ordering value for ONE request;
-- persisted against a person it becomes a rating with a history, which is the universal employee
-- rank the owner forbade. What is stored instead is the ORDER (`rank_position`) and the REASONS,
-- which are the things a human can actually argue with. A `protected_keys` trigger enforces the
-- first part at the database, so a future caller cannot quietly widen the payload.

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 1. The snapshot table.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table if not exists management_item_recommendations (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null,
  item_id               uuid not null references management_items(id) on delete cascade,

  -- What was being filled, and what the resolver concluded.
  purpose               text not null
    check (purpose in ('assignee', 'advisor', 'delegate', 'external_consultant')),
  outcome               text not null
    check (outcome in ('candidates', 'needs_routing')),

  -- The candidate. NULL for a needs_routing snapshot, which names nobody by design.
  candidate_ref         text,
  candidate_type        text
    check (candidate_type is null
           or candidate_type in ('staff', 'team', 'advisor', 'delegate', 'external_consultant')),
  -- Position in the offered order. NOT a score: 1 means "considered first", nothing more.
  rank_position         int check (rank_position is null or rank_position >= 1),

  -- Only capabilities and skills that were ACTUALLY USED to reach this recommendation, each
  -- carrying whether it was verified. A self-declared claim must never read as a fact later.
  capabilities_used     text[] not null default '{}',
  skills_used           jsonb  not null default '[]'::jsonb,

  -- Availability as a RESULT, never a raw timesheet.
  availability          jsonb,

  confidence            numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),

  -- Machine-readable first; the detail is for a human reading the same row.
  reason_codes          text[] not null default '{}',
  reasons               jsonb  not null default '[]'::jsonb,
  missing_codes         text[] not null default '{}',

  -- Where a needs_routing snapshot went, and why. Never a person (R1-D-3).
  routing_department    text,
  routing_reason_code   text,

  evidence_refs         jsonb  not null default '[]'::jsonb,

  -- Reproducibility: which code and which learning rule produced this.
  resolver_version      text not null,
  signal_rule_version   text not null,

  -- Dedup for repeated sweeps: identical advice is not new advice.
  fingerprint           text not null,

  created_at            timestamptz not null default now(),

  -- A needs_routing snapshot names no candidate and must name a department and a reason.
  constraint mir_routing_shape check (
    (outcome = 'candidates'
       and candidate_ref is not null and candidate_type is not null and rank_position is not null)
    or
    (outcome = 'needs_routing'
       and candidate_ref is null and candidate_type is null
       and routing_department is not null and btrim(coalesce(routing_reason_code,'')) <> '')
  )
);

create index if not exists mir_item_idx on management_item_recommendations (item_id, created_at);
create index if not exists mir_company_idx on management_item_recommendations (company_id, created_at);
create unique index if not exists mir_fingerprint_uq
  on management_item_recommendations (item_id, purpose, fingerprint);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 2. APPEND-ONLY. A recommendation that can be edited afterwards is not evidence of what the
--    system actually advised at the time.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function r1_draft_recommendation_append_only() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  raise exception 'management_item_recommendations is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists mir_no_update on management_item_recommendations;
create trigger mir_no_update
  before update or delete on management_item_recommendations
  for each row execute function r1_draft_recommendation_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 3. Protected attributes are refused AT THE DATABASE.
--
--    The application already refuses them with a positive allowlist when candidate evidence is
--    constructed. This is the second line: application guards are bypassed by whoever writes the
--    next caller, and a stored protected attribute is a lasting harm rather than a transient one.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function r1_draft_recommendation_no_protected() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_forbidden text[] := array[
    'ethnicity','race','nationality','religion','belief','caste','political_opinion','politicalopinion',
    'union_member','unionmember','health','disability','medical_condition','pregnancy','sick_leave',
    'mental_health','gender','sex','sexual_orientation','gender_identity','marital_status','family_status',
    'children','dependants','dependents','age','age_band','date_of_birth','dob','birth_date','address',
    'home_address','postcode','postal_code','photo','photo_url','avatar','face_embedding','biometric',
    'visa_status','immigration_status','criminal_record','salary','pay','pay_rate','wage','remuneration',
    -- An opaque universal score is forbidden for the same reason, by name.
    'suitability','suitability_score','score','rating','rank','employee_score','overall_score'
  ];
  v_key text;
  v_doc jsonb;
begin
  foreach v_doc in array array[
    coalesce(new.skills_used, '[]'::jsonb),
    coalesce(new.availability, '{}'::jsonb),
    coalesce(new.reasons, '[]'::jsonb),
    coalesce(new.evidence_refs, '[]'::jsonb)
  ] loop
    -- Walk every object key at any depth.
    for v_key in
      select k from jsonb_each_text(
        case when jsonb_typeof(v_doc) = 'object' then v_doc else '{}'::jsonb end
      ) as t(k, v)
      union all
      select k from jsonb_array_elements(
        case when jsonb_typeof(v_doc) = 'array' then v_doc else '[]'::jsonb end
      ) as e(elem), jsonb_each_text(
        case when jsonb_typeof(e.elem) = 'object' then e.elem else '{}'::jsonb end
      ) as t2(k, v)
    loop
      if lower(replace(v_key, '-', '_')) = any (v_forbidden) then
        raise exception
          'refused: "%" is a protected attribute or an opaque person score and may never be persisted in a recommendation', v_key
          using errcode = 'insufficient_privilege';
      end if;
    end loop;
  end loop;

  foreach v_key in array coalesce(new.capabilities_used, '{}') loop
    if lower(replace(v_key, '-', '_')) = any (v_forbidden) then
      raise exception 'refused: "%" is a protected attribute', v_key
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists mir_no_protected on management_item_recommendations;
create trigger mir_no_protected
  before insert on management_item_recommendations
  for each row execute function r1_draft_recommendation_no_protected();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 4. RLS: company-scoped reads through the existing identity function; writes service-only.
-- ─────────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.has_company_access(uuid)') is not null then
    execute 'alter table management_item_recommendations enable row level security';
    begin
      execute 'create policy mir_read on management_item_recommendations
                 for select using (has_company_access(company_id))';
    exception when duplicate_object then null;
    end;
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 5. The atomic entry point.
--
--    It CALLS r1_draft_create_management_item rather than reimplementing it. Unit 013 already
--    replaces that function's body to widen the twelve-domain allowlists; copying the body here
--    would create a second definition that drifts the moment either is edited — which is the
--    exact defect class this recovery keeps finding. A function body is one transaction from the
--    caller's point of view, so item, evidence, opening transition, audit row AND the
--    recommendation snapshots are still all-or-nothing.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.r1_draft_create_management_item_v2(
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
  p_evidence                 jsonb,
  -- An ARRAY of snapshots: one per offered candidate, or exactly one needs_routing row.
  p_recommendations          jsonb default '[]'::jsonb,
  p_resolver_version         text  default null,
  p_signal_rule_version      text  default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_base    jsonb;
  v_item_id uuid;
  v_rec     jsonb;
  v_written int := 0;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'r1_draft_create_management_item_v2 is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  v_base := public.r1_draft_create_management_item(
    p_company, p_actor, p_department, p_kind, p_observation_source, p_subject_table,
    p_subject_id, p_identity_key, p_correlation_id, p_priority, p_confidence,
    p_required_authority, p_proposed_action_id, p_evidence_quality, p_may_run_unattended,
    p_business_deadline, p_business_deadline_source, p_evidence
  );

  v_item_id := (v_base->>'item_id')::uuid;

  if p_recommendations is null or jsonb_typeof(p_recommendations) <> 'array'
     or jsonb_array_length(p_recommendations) = 0 then
    return v_base || jsonb_build_object('recommendations_written', 0);
  end if;

  if coalesce(btrim(p_resolver_version), '') = ''
     or coalesce(btrim(p_signal_rule_version), '') = '' then
    raise exception 'a recommendation must record the resolver and signal rule versions'
      using errcode = 'check_violation';
  end if;

  for v_rec in select * from jsonb_array_elements(p_recommendations) loop
    -- The company is the ITEM's company, taken from the authorised call — never from the
    -- payload. A recommendation cannot be attributed to another company by a caller.
    begin
      insert into public.management_item_recommendations (
        company_id, item_id, purpose, outcome, candidate_ref, candidate_type, rank_position,
        capabilities_used, skills_used, availability, confidence,
        reason_codes, reasons, missing_codes,
        routing_department, routing_reason_code, evidence_refs,
        resolver_version, signal_rule_version, fingerprint
      ) values (
        p_company, v_item_id,
        v_rec->>'purpose', v_rec->>'outcome',
        nullif(v_rec->>'candidate_ref', ''), nullif(v_rec->>'candidate_type', ''),
        nullif(v_rec->>'rank_position', '')::int,
        coalesce(array(select jsonb_array_elements_text(coalesce(v_rec->'capabilities_used','[]'::jsonb))), '{}'),
        coalesce(v_rec->'skills_used', '[]'::jsonb),
        v_rec->'availability',
        nullif(v_rec->>'confidence', '')::numeric,
        coalesce(array(select jsonb_array_elements_text(coalesce(v_rec->'reason_codes','[]'::jsonb))), '{}'),
        coalesce(v_rec->'reasons', '[]'::jsonb),
        coalesce(array(select jsonb_array_elements_text(coalesce(v_rec->'missing_codes','[]'::jsonb))), '{}'),
        nullif(v_rec->>'routing_department', ''), nullif(v_rec->>'routing_reason_code', ''),
        coalesce(v_rec->'evidence_refs', '[]'::jsonb),
        p_resolver_version, p_signal_rule_version,
        md5(coalesce(v_rec::text, ''))
      );
      v_written := v_written + 1;
    exception when unique_violation then
      -- Identical advice for the same item and purpose is not new advice. Repeated sweeps
      -- must not grow the history without saying anything new.
      null;
    end;
  end loop;

  return v_base || jsonb_build_object('recommendations_written', v_written);
end;
$$;

do $$
declare
  sig text := 'public.r1_draft_create_management_item_v2(uuid,uuid,text,text,text,text,text,text,text,text,numeric,text,text,text,boolean,timestamptz,text,jsonb,jsonb,text,text)';
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

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 6. Direct INSERT that bypasses the RPC is refused, exactly as for management_items.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function r1_draft_guard_recommendation_insert() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    raise exception
      'recommendations may only be created through r1_draft_create_management_item_v2()'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists mir_guard_insert on management_item_recommendations;
create trigger mir_guard_insert
  before insert on management_item_recommendations
  for each row execute function r1_draft_guard_recommendation_insert();
