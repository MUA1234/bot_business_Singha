-- Release 1 — promoted from R1_DRAFT_027 on 2026-09-11.
--
-- Quarantined outside the numbered sequence under owner decision R1-D-1 while the hosted
-- migration state was unknown. Case A is proven (the hosted ledger's high-water is main's 0069,
-- recovery markers absent), so the owner approved promotion and this is now migration 0137,
-- applied by the ordinary runner with no special confirmation and no separate ledger.
--
-- In-body references to "draft NNN" name the ORIGINAL unit and were deliberately left alone —
-- see docs/release-1/MIGRATION-PROMOTION.md for the mapping. Rollback SQL for this migration is
-- src/db/rollback/0137_*.down.sql; the forward runner never sees it.
--
-- R1_DRAFT_027 — separating the two evidence contracts (R2F-F-017).
--
-- ── The defect ───────────────────────────────────────────────────────────────────────────
--
-- The executor's freshness check compared the ITEM's condition-evidence digest against the
-- RECOMMENDATION SNAPSHOT's candidate-eligibility evidence refs. Two different record sets about
-- two different subjects — the business facts that raised the item, and the facts that make a
-- person a plausible assignee — compared for equality. They cannot match, so no item created by
-- the real cycle could ever execute an automatic action.
--
-- The fix is NOT to make the two sets agree. It is to record both, separately, and compare each
-- against its own kind:
--
--   condition evidence   → checked at EXECUTION  ("has the problem changed?")
--   eligibility evidence → checked at ASSIGNMENT ("is this still the right person?")
--
-- A stale candidate must not stop an unassigned task being created; it must stop that task being
-- given to someone.
--
-- ── Why v2 is redefined here rather than patched afterwards ──────────────────────────────
--
-- The first version of this unit stamped the bindings with an UPDATE after v2 had inserted the
-- rows. `management_item_recommendations` is append-only and refused it — correctly, and that is
-- the whole reason the table has that trigger: advice that can be edited after the fact is not
-- evidence of what the system actually advised.
--
-- So the bindings are written by the INSERT itself. v2 keeps its exact signature and its exact
-- behaviour, and gains six columns read from the same jsonb element it already reads; there is
-- still ONE writer of a snapshot row, which is what stops the two paths drifting apart.

-- ── 1. The bindings a recommendation must carry ──────────────────────────────────────────
alter table management_item_recommendations
  -- The condition this advice was ABOUT. Nothing recorded this before: a snapshot knew who it
  -- proposed and nothing about the problem it proposed them for.
  add column if not exists condition_evidence_digest   text,
  -- The candidate's eligibility evidence, digested. Derivable from `evidence_refs`, and stored
  -- under its own name so that no call site can mistake one set for the other again.
  add column if not exists eligibility_evidence_digest text,
  -- The action this advice was for. `management_items.proposed_action_id` can move; the advice
  -- was given for one specific action.
  add column if not exists action_id                   text,
  -- The PLAN: what the system proposed to do, in full, decided when the advice was recorded.
  add column if not exists planned_parameters          jsonb,
  add column if not exists parameter_digest            text,
  -- The rules the advice was given under.
  add column if not exists policy_version              text;

comment on column management_item_recommendations.condition_evidence_digest is
  'Digest of management_item_evidence for this item at recommendation time. Compared at EXECUTION.';
comment on column management_item_recommendations.eligibility_evidence_digest is
  'Digest of this row''s own evidence_refs — the candidate''s eligibility. Compared at ASSIGNMENT.';

-- ── 2. Digests, in one shape, computed from canonical rows ───────────────────────────────
--
-- The same form as the condition digest — ordered `table:id` pairs, md5 — so the two are
-- comparable in FORM and never in meaning. `empty` for a needs_routing snapshot, which names
-- nobody and therefore has no eligibility evidence: a real value, not a missing one.
create or replace function public.r1_draft_eligibility_digest(p_refs jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(md5(string_agg(pair, '|' order by pair)), 'empty')
    from (
      select coalesce(r->>'sourceTable', r->>'source_table', '')
             || ':' ||
             coalesce(r->>'sourceId', r->>'source_id', '') as pair
        from jsonb_array_elements(
               case when jsonb_typeof(coalesce(p_refs, '[]'::jsonb)) = 'array'
                    then p_refs else '[]'::jsonb end) as r
    ) s;
$$;

/*
 * The CONDITION digest of an evidence PAYLOAD, in the same form `r1_draft_evidence_digest`
 * produces from the stored rows.
 *
 * Needed because the digest has to be written INTO the snapshot insert, which happens in the same
 * transaction as the evidence insert — so the rows are not yet visible to a second statement in
 * every path. v3 asserts the two agree once the transaction has both, so this can never quietly
 * diverge from the stored-row function it mirrors.
 */
create or replace function public.r1_draft_condition_digest_of(p_evidence jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(md5(string_agg(pair, '|' order by pair)), 'empty')
    from (
      select coalesce(e->>'source_table', e->>'sourceTable', '')
             || ':' ||
             coalesce(e->>'source_id', e->>'sourceId', '') as pair
        from jsonb_array_elements(
               case when jsonb_typeof(coalesce(p_evidence, '[]'::jsonb)) = 'array'
                    then p_evidence else '[]'::jsonb end) as e
    ) s;
$$;

-- ── 3. ONE snapshot writer, now carrying the bindings ────────────────────────────────────
--
-- Signature and behaviour unchanged from draft 014. The only difference is six more columns read
-- from the same `v_rec` element, so a caller that supplies none writes NULLs and behaves exactly
-- as before.
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
        resolver_version, signal_rule_version, fingerprint,
        condition_evidence_digest, eligibility_evidence_digest, action_id,
        planned_parameters, parameter_digest, policy_version
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
        md5(coalesce(v_rec::text, '')),
        -- The bindings. Absent from the element ⇒ NULL, which the executor treats as "no plan"
        -- and refuses — fail-closed, never permissive.
        nullif(v_rec->>'condition_evidence_digest', ''),
        nullif(v_rec->>'eligibility_evidence_digest', ''),
        nullif(v_rec->>'action_id', ''),
        v_rec->'planned_parameters',
        nullif(v_rec->>'parameter_digest', ''),
        nullif(v_rec->>'policy_version', '')
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

-- ── 4. v3: derive the bindings server-side, then verify them ─────────────────────────────
--
-- The kernel supplies only what it alone knows — the PLAN it intends to carry out. Both evidence
-- digests are computed here, from the payload that is becoming the canonical record in this same
-- transaction, and then CHECKED against the stored rows. A caller cannot assert either one.
create or replace function public.r1_draft_create_management_item_v3(
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
  p_recommendations          jsonb default '[]'::jsonb,
  p_resolver_version         text  default null,
  p_signal_rule_version      text  default null,
  -- The plan. NULL when the action has none, which is the case for thirteen of fifteen.
  p_planned_parameters       jsonb default null,
  p_parameter_digest         text  default null,
  p_policy_version           text  default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_condition text;
  v_enriched  jsonb := '[]'::jsonb;
  v_rec       jsonb;
  v_result    jsonb;
  v_item_id   uuid;
  v_stored    text;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'r1_draft_create_management_item_v3 is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  -- Computed, never accepted. The payload is what is about to become the evidence rows.
  v_condition := public.r1_draft_condition_digest_of(p_evidence);

  if p_recommendations is not null and jsonb_typeof(p_recommendations) = 'array' then
    for v_rec in select * from jsonb_array_elements(p_recommendations) loop
      v_enriched := v_enriched || jsonb_build_array(
        v_rec || jsonb_build_object(
          'condition_evidence_digest', v_condition,
          -- From the row's OWN refs. Each snapshot gets its own candidate's digest.
          'eligibility_evidence_digest',
            public.r1_draft_eligibility_digest(coalesce(v_rec->'evidence_refs', '[]'::jsonb)),
          'action_id', p_proposed_action_id,
          'planned_parameters', p_planned_parameters,
          'parameter_digest', p_parameter_digest,
          'policy_version', p_policy_version
        )
      );
    end loop;
  end if;

  v_result := public.r1_draft_create_management_item_v2(
    p_company, p_actor, p_department, p_kind, p_observation_source, p_subject_table,
    p_subject_id, p_identity_key, p_correlation_id, p_priority, p_confidence,
    p_required_authority, p_proposed_action_id, p_evidence_quality, p_may_run_unattended,
    p_business_deadline, p_business_deadline_source, p_evidence,
    v_enriched, p_resolver_version, p_signal_rule_version
  );

  v_item_id := (v_result->>'item_id')::uuid;

  -- SELF-VERIFYING. The digest written into the snapshots must equal the one the stored evidence
  -- produces. A repeated identity key returns the ORIGINAL item, whose evidence may legitimately
  -- differ from this payload — so the check applies only when this call actually created the item.
  if v_item_id is not null and coalesce(v_result->>'result', '') = 'created' then
    v_stored := public.r1_draft_evidence_digest(p_company, v_item_id);
    if v_stored is distinct from v_condition then
      raise exception
        'condition digest disagrees with stored evidence (payload %, stored %)', v_condition, v_stored
        using errcode = 'check_violation';
    end if;
  end if;

  return v_result || jsonb_build_object('condition_evidence_digest', v_condition);
end;
$$;

-- ── 5. Privileges ────────────────────────────────────────────────────────────────────────
do $$
declare
  v_role text;
  v3_sig text := 'public.r1_draft_create_management_item_v3('
              || 'uuid,uuid,text,text,text,text,text,text,text,text,numeric,text,text,text,'
              || 'boolean,timestamptz,text,jsonb,jsonb,text,text,jsonb,text,text)';
begin
  execute format('revoke all on function %s from public', v3_sig);
  execute 'revoke all on function public.r1_draft_eligibility_digest(jsonb) from public';
  execute 'revoke all on function public.r1_draft_condition_digest_of(jsonb) from public';

  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      -- The create RPC stays SERVICE-ONLY: filing a management item is the kernel's act, and no
      -- session may perform it. The digest helpers are revoked too — a session that could compute
      -- a digest over arbitrary input could search for one that matches.
      execute format('revoke all on function %s from %I', v3_sig, v_role);
      execute format('revoke all on function public.r1_draft_eligibility_digest(jsonb) from %I', v_role);
      execute format('revoke all on function public.r1_draft_condition_digest_of(jsonb) from %I', v_role);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute format('grant execute on function %s to service_role', v3_sig);
    execute 'grant execute on function public.r1_draft_eligibility_digest(jsonb) to service_role';
    execute 'grant execute on function public.r1_draft_condition_digest_of(jsonb) to service_role';
  end if;
end $$;
