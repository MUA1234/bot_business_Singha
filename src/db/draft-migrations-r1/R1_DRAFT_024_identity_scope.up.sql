-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_024 — advisor and delegate scope, tightened own-work, and a safe source-health
-- projection. Closes the remainder of R2F-F-003; registers R2F-F-005 as fail-closed.
--
-- ── What draft 023 left open ─────────────────────────────────────────────────────────────
--
-- 023 scoped the queue for owners, managers and staff. Three identity classes were untouched, and
-- own-work visibility rested on an active membership alone — a relationship and a company, but no
-- capability. This unit closes both.
--
-- The invariant, in full:
--
--   visible = active identity relationship
--         AND same company
--         AND active engagement/delegation/assignment
--         AND item inside the granted scope
--         AND required capability
--         AND sensitive-domain permission where applicable
--
-- Nobody gains visibility from a role NAME, an email, a job title, a historical engagement, a
-- self-declared skill, a model recommendation, a caller-supplied identity, or a browser filter.

-- ── 1. Advisor: an ACTIVE, in-window, domain-matched relationship ────────────────────────
--
-- `advisor_relationships` proves all six parts: membership, company, status, time window, domain,
-- and the membership's own capabilities. A suspended or ended relationship, an expired window, a
-- different domain or a different company each fail closed.
create or replace function public.r1_draft_is_active_advisor(
  p_company uuid,
  p_department text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1
      from public.advisor_relationships ar
      join public.memberships m
        on m.id = ar.membership_id
       and m.user_id = auth.uid()
       and m.company_id = ar.company_id
       and m.status = 'active'
     where ar.company_id = p_company
       and ar.status = 'active'
       and ar.domain = p_department
       and ar.starts_at <= now()
       and (ar.ends_at is null or ar.ends_at > now())
  );
$$;

-- ── 2. Delegates need NO new function ────────────────────────────────────────────────────
--
-- One was written here and then deleted, which is worth recording because the mistake is easy to
-- repeat. `has_capability` (migration 0038) already resolves delegated capabilities:
--
--     (b) an active, in-window delegation TO the user, where the DELEGATOR actually holds the
--         capability (a delegate never exceeds the delegator), with a null delegation domain
--         meaning all domains.
--
-- The deleted function matched on domain alone and never checked whether the delegator held
-- anything. It was therefore WEAKER than the rule already in the repository, while reading like an
-- additional safeguard — and it would have granted a delegate visibility their delegator did not
-- have. The existing rule stands on its own; there is nothing to add.

-- ── 3. The predicate, with the two new classes and a capability on own work ──────────────
--
-- Order is unchanged and still matters: an active membership first, sensitive domains second (so a
-- company-wide viewer is not thereby entitled to grievance or compliance material), then the
-- widening grants.
--
-- CONSULTANTS ARE ABSENT BY DECISION, not by oversight (R2F-F-005). `consultant_engagements`
-- references `service_providers`, which has no user or membership column — there is no `auth.uid()`
-- that resolves to a consultant — and the table carries
-- `check (internal_access = false)`, so the schema refuses to represent internal access at all.
-- Granting it would need a person-level provider identity, an owner decision to relax that
-- constraint, and a registered capability. None exists, so consultants stay unavailable.
create or replace function public.r1_draft_may_see_management_item(
  p_company    uuid,
  p_department text,
  p_owner      uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_actor uuid := auth.uid();
  v_spec  text;
  v_dept  text;
begin
  if v_actor is null or p_company is null then
    return false;
  end if;

  -- 1. Active membership in THIS company. Revoked, ended or foreign ⇒ nothing.
  if not exists (
    select 1 from public.memberships m
     where m.user_id = v_actor and m.company_id = p_company and m.status = 'active'
  ) then
    return false;
  end if;

  -- 2. Sensitive domains: the domain capability, and no substitute. Checked BEFORE every
  --    widening grant below, so no advisor, delegate or company-wide viewer reaches legal or
  --    workforce material without the domain capability itself.
  v_spec := public.r1_draft_specialist_capability(p_department);
  if p_department in ('legal', 'workforce') then
    return coalesce(public.has_capability(p_company, v_spec), false);
  end if;

  -- 3. Cross-domain visibility, explicitly granted.
  if public.has_capability(p_company, 'management.queue.view_company') then
    return true;
  end if;

  -- 4. A department this person manages.
  v_dept := public.r1_draft_department_capability(p_department);
  if v_dept is not null and public.has_capability(p_company, v_dept) then
    return true;
  end if;

  -- 5. An ACTIVE advisor relationship for this exact domain, plus the baseline internal-work
  --    capability. The relationship alone is not enough: the invariant requires a capability.
  if public.r1_draft_is_active_advisor(p_company, p_department)
     and public.has_capability(p_company, 'operations.task.work') then
    return true;
  end if;

  -- 6. DELEGATES ARE ALREADY HANDLED, and by a stricter rule than one written here.
  --
  --    `has_capability` (migration 0038) is delegation-aware in its own right: an active,
  --    in-window delegation TO the user grants a capability when the DELEGATOR actually holds it
  --    — "a delegate never exceeds the delegator" — with a null delegation domain meaning all
  --    domains. So a delegate reaches step 4 above through the department capability itself.
  --
  --    A separate branch here was written first and then removed. It matched on domain alone and
  --    never checked whether the delegator held anything, so it was WEAKER than the rule already
  --    in the repository while looking like an additional safeguard. Two paths to one grant, the
  --    laxer of them newer, is how a boundary quietly loosens.

  -- 7. Their own accountable work.
  --
  --    TIGHTENED: being named accountable owner is a relationship and a company, but not a
  --    capability. The invariant requires one, so `operations.task.work` — the registered
  --    capability for working assigned tasks — is now required too. Every staff role already
  --    holds it, so this excludes nobody who should see their own work; it stops a bare
  --    membership from being sufficient.
  if p_owner is not null
     and public.has_capability(p_company, 'operations.task.work')
     and exists (
       select 1 from public.memberships m
        where m.id = p_owner and m.user_id = v_actor
          and m.company_id = p_company and m.status = 'active'
     ) then
    return true;
  end if;

  return false;
end;
$fn$;

-- ── 4. R2F-F-006: a safe source-health projection ────────────────────────────────────────
--
-- `observation_sources.last_failure_reason` is free text, readable by any member of the company.
-- Nothing writes it today — like `proposed_action` before it, it is a declared column with no
-- writer — which makes it a LATENT exposure rather than an active one, and exactly the kind that
-- becomes real the first time someone stores a driver error containing a query fragment or a
-- constraint message quoting values.
--
-- Truthful health reporting needs one fact per department: was it observed, or not. That is all
-- this returns. Timestamps, failure reasons, cadence and kind stay server-side.
--
-- Rows with a NULL `company_id` are the deliberate cross-company DEFAULT registrations. They are
-- included because they carry only a department and a kind, and excluding them would under-report
-- which departments are registered at all.
create or replace function public.r1_draft_source_health(p_company uuid)
returns table (department text, unobserved boolean)
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select s.department,
         bool_or(s.consecutive_failures > 0 or s.last_failure_at is not null) as unobserved
    from public.observation_sources s
   where (s.company_id is null or s.company_id = p_company)
     and exists (
       select 1 from public.memberships m
        where m.user_id = auth.uid() and m.company_id = p_company and m.status = 'active'
     )
   group by s.department;
$$;

do $$
begin
  if to_regprocedure('public.has_capability(uuid, text)') is null then
    raise notice 'R1_DRAFT_024: base identity functions absent — policy changes SKIPPED';
    return;
  end if;

  -- The raw table is no longer readable by a session. The projection above is the only way in,
  -- and it exposes no reason text, no timestamps and no cadence.
  execute 'drop policy if exists observation_sources_sel on public.observation_sources';
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke select on public.observation_sources from authenticated';
  end if;
end $$;

-- ── 5. Privileges ────────────────────────────────────────────────────────────────────────
do $$
begin
  for i in 1..1 loop
    execute 'revoke all on function public.r1_draft_is_active_advisor(uuid, text) from public';
    execute 'revoke all on function public.r1_draft_source_health(uuid) from public';
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'grant execute on function public.r1_draft_is_active_advisor(uuid, text) to authenticated';
      execute 'grant execute on function public.r1_draft_source_health(uuid) to authenticated';
    end if;
  end loop;
end $$;
