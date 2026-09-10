-- 0078 — a routing decision's provenance is DERIVED, never asserted (remediation R1 §2, OF-007).
--
-- THE DEFECT. `route_task` took `p_actor_source` and `p_actor` as parameters. The guard that
-- protects a person's assignment from being undone by automation keys on that value, so any
-- service-role caller could manufacture a human decision by passing `'human'` and a real member's
-- id. 0077 tightened it to require an ACTIVE MEMBER — which raised the cost of the forgery without
-- removing it. A trust boundary that the untrusted side can describe is not a trust boundary.
--
-- THE SPLIT. Provenance now comes from WHICH FUNCTION WAS CALLED and from the authenticated
-- session, never from an argument:
--
--   route_task_as_human   — callable ONLY by `authenticated`. The deciding person is `auth.uid()`,
--                           resolved to an ACTIVE membership inside this transaction, with the
--                           capability re-checked at commit. There is no actor parameter to pass.
--                           `service_role` has NO EXECUTE on it, so the service context cannot make
--                           a human decision at all.
--   route_task_as_ai      — service-only. Source is fixed to 'ai' by the function. `decided_by` is
--                           forced NULL; the model and policy version are recorded in their OWN
--                           columns, so a machine decision can never occupy a person's identity.
--   route_task_as_system  — service-only. Source fixed to 'system', same rules.
--
-- The shared implementation moves to `_route_task_internal`, which is revoked from EVERY role: it is
-- reachable only from inside those three SECURITY DEFINER wrappers.
--
-- DATABASE ENFORCEMENT, not convention. Direct DML cannot produce contradictory provenance:
--   * only the trusted delivery owner may INSERT a routing row or a routing event — a POSITIVE
--     owner allowlist derived from `_route_task_internal`'s own owner, so a bespoke role is refused
--     as firmly as `service_role` is;
--   * a 'human' row must carry a person and must not carry a model; an 'ai'/'system' row must carry
--     a component and must NOT carry a person;
--   * provenance is IMMUTABLE after insert;
--   * routing history stays append-only.
--
-- Forward-only, idempotent DDL. No feature flag (a security boundary, not a capability).

begin;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (1) Separate columns for machine provenance, so it never borrows a human identity
-- ─────────────────────────────────────────────────────────────────────────────────────────────
alter table public.task_routing
  add column if not exists decided_by_component      text,
  add column if not exists decided_by_model          text,
  add column if not exists decided_by_policy_version text;

comment on column public.task_routing.decided_by is
  'The PERSON who decided. Non-null only for decided_by_source = human, and only ever written from auth.uid() inside route_task_as_human.';
comment on column public.task_routing.decided_by_component is
  'The system component that decided (e.g. capture-routing). Recorded separately from any human identity.';
comment on column public.task_routing.decided_by_model is
  'The model behind an AI decision, when one was involved. Never a person.';

alter table public.task_routing add column if not exists decided_by_component_bootstrap boolean;
update public.task_routing
   set decided_by_component = coalesce(decided_by_component, 'legacy_pre_0078')
 where decided_by_source in ('ai', 'system') and decided_by_component is null;
alter table public.task_routing drop column if exists decided_by_component_bootstrap;

-- Legacy rows written before the split may carry a person on a machine decision. They are not
-- rewritten (history is history) — the constraint below applies to NEW rows via the trigger, so the
-- record of what happened stays intact while what can be written from now on is constrained.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (2) The trusted writer: a POSITIVE owner allowlist, not a role denylist
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public._is_task_routing_owner()
returns boolean
language plpgsql
stable
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare v_owner oid;
begin
  -- Resolved from the EXACT internal function's identity, so a like-named overload cannot flip it.
  select p.proowner into v_owner
    from pg_catalog.pg_proc p
   where p.oid = '_route_task_internal(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid,text,uuid,text,text,text)'::regprocedure;
  if v_owner is null then return false; end if;   -- fail closed
  return current_user = (select rolname from pg_catalog.pg_roles where oid = v_owner);
end;
$$;

revoke all on function public._is_task_routing_owner() from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (3) The shared implementation — unreachable except through the three wrappers
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public._route_task_internal(
  p_company uuid,
  p_task uuid,
  p_desired_state text,
  p_reason_code text,
  p_required_capability text,
  p_proposed jsonb,
  p_assignee uuid,
  p_queue text,
  p_approval uuid,
  p_human_actor uuid,          -- ONLY ever auth.uid(), supplied by route_task_as_human
  p_actor_source text,         -- fixed by the wrapper, never by an outside caller
  p_submitter uuid,
  p_component text,
  p_model text,
  p_policy_version text
)
returns table (routing_id uuid, routing_state text, reason_code text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_task     record;
  v_prev     record;
  v_state    text := p_desired_state;
  v_reason   text := p_reason_code;
  v_assignee uuid := p_assignee;
  v_bad      text;
  v_id       uuid;
begin
  if p_actor_source not in ('human', 'ai', 'system') then
    raise exception 'unsupported actor source %', p_actor_source;
  end if;
  if p_company is null or p_task is null then raise exception 'company and task are required'; end if;

  select t.id, t.company_id, t.status into v_task
    from public.tasks t where t.id = p_task for update;
  if not found then raise exception 'task % not found', p_task; end if;

  if v_task.company_id is distinct from p_company then
    raise exception 'task does not belong to this company' using errcode = 'insufficient_privilege';
  end if;

  if v_task.status in ('completed', 'cancelled') then
    raise exception 'task is % and cannot be routed', v_task.status using errcode = 'invalid_parameter_value';
  end if;

  select * into v_prev from public.task_routing r where r.task_id = p_task and r.is_active for update;

  -- A PERSON'S DECISION STANDS. Now meaningful, because `p_actor_source` reaches here only from a
  -- wrapper that derived it — an automated caller has no way to present itself as human.
  if v_prev.id is not null
     and v_prev.routing_state = 'assigned'
     and v_prev.decided_by_source = 'human'
     and p_actor_source in ('ai', 'system') then
    insert into public.task_routing_events (
      company_id, task_id, routing_id, from_state, to_state, reason_code, detail, actor_id, actor_source
    ) values (
      p_company, p_task, v_prev.id, v_prev.routing_state, v_prev.routing_state, 'automated_supersede_refused',
      jsonb_build_object('requested_state', p_desired_state, 'requested_reason', p_reason_code,
                         'component', p_component),
      null, p_actor_source
    );
    return query select v_prev.id, v_prev.routing_state, v_prev.reason_code;
    return;
  end if;

  if v_state = 'assigned' then
    v_bad := public.task_assignee_ineligible_reason(p_company, v_assignee, p_required_capability, p_submitter);
    if v_bad is not null then
      v_state    := case when v_bad = 'no_assignee_proposed' then 'needs_routing' else 'no_eligible_assignee' end;
      v_reason   := v_bad;
      v_assignee := null;
    end if;
  end if;

  if v_state = 'awaiting_approval' and p_approval is null then
    v_state  := 'manual_review';
    v_reason := 'approval_required_but_no_approval_record';
  end if;

  if v_prev.id is not null then
    update public.task_routing set is_active = false, updated_at = now() where id = v_prev.id;
  end if;

  insert into public.task_routing (
    company_id, task_id, routing_state, reason_code, required_capability, proposed_assignees,
    assignee_id, queue_name, approval_request_id, attempt_count,
    decided_by, decided_by_source, decided_by_component, decided_by_model, decided_by_policy_version
  ) values (
    p_company, p_task, v_state, v_reason, nullif(btrim(coalesce(p_required_capability, '')), ''),
    coalesce(p_proposed, '[]'::jsonb),
    case when v_state = 'assigned' then v_assignee else null end,
    case when v_state = 'assigned' then null else nullif(btrim(coalesce(p_queue, '')), '') end,
    case when v_state = 'awaiting_approval' then p_approval else null end,
    coalesce(v_prev.attempt_count, 0) + 1,
    -- A person's id is recorded ONLY on a human decision, and a machine's identity ONLY on a
    -- machine decision. The trigger below refuses any other combination.
    case when p_actor_source = 'human' then p_human_actor else null end,
    p_actor_source,
    case when p_actor_source = 'human' then null else coalesce(nullif(btrim(coalesce(p_component, '')), ''), 'unspecified') end,
    case when p_actor_source = 'ai' then nullif(btrim(coalesce(p_model, '')), '') else null end,
    case when p_actor_source = 'human' then null else nullif(btrim(coalesce(p_policy_version, '')), '') end
  ) returning id into v_id;

  if v_prev.id is not null then
    update public.task_routing set superseded_by = v_id, updated_at = now() where id = v_prev.id;
  end if;

  insert into public.task_routing_events (company_id, task_id, routing_id, from_state, to_state, reason_code, detail, actor_id, actor_source)
  values (p_company, p_task, v_id, v_prev.routing_state, v_state, v_reason,
          jsonb_build_object('proposed', coalesce(p_proposed, '[]'::jsonb), 'refused_reason', v_bad,
                             'component', p_component, 'model', p_model, 'policy_version', p_policy_version),
          case when p_actor_source = 'human' then p_human_actor else null end, p_actor_source);

  return query select v_id, v_state, v_reason;
end;
$$;

-- Reachable from NOBODY directly. The wrappers run as this function's owner and therefore may call
-- it; every API role — including service_role — may not.
revoke all on function public._route_task_internal(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid,text,uuid,text,text,text) from public, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (4) The HUMAN path — identity from the session, never from an argument
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.route_task_as_human(
  p_company uuid,
  p_task uuid,
  p_desired_state text,
  p_reason_code text,
  p_required_capability text default null,
  p_proposed jsonb default '[]'::jsonb,
  p_assignee uuid default null,
  p_queue text default null,
  p_approval uuid default null,
  p_submitter uuid default null
)
returns table (routing_id uuid, routing_state text, reason_code text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_actor uuid;
  v_memberships int;
begin
  -- NO actor parameter exists to spoof. The deciding person is whoever the request is authenticated
  -- as, and nothing else.
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'a human routing decision requires an authenticated session'
      using errcode = 'insufficient_privilege';
  end if;
  -- Belt and braces: this function is not granted to the service context, and it also refuses to
  -- run in one.
  if public.caller_jwt_role() = 'service_role' then
    raise exception 'the service context cannot make a human routing decision'
      using errcode = 'insufficient_privilege';
  end if;
  if p_company is null then raise exception 'p_company is required'; end if;

  -- Membership is resolved INSIDE this transaction, at decision time. Inactive, suspended, ended,
  -- deleted and cross-company identities all fail here; more than one active membership for the
  -- same person in the same company is ambiguous and also fails, rather than picking one.
  select count(*) into v_memberships
    from public.memberships m
   where m.user_id = v_actor and m.company_id = p_company and m.status = 'active';
  if v_memberships = 0 then
    raise exception 'no active membership in this company' using errcode = 'insufficient_privilege';
  elsif v_memberships > 1 then
    raise exception 'ambiguous membership for this person in this company' using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.profiles pr
     where pr.id = v_actor and pr.company_id = p_company and pr.is_active
  ) then
    raise exception 'no active profile in this company' using errcode = 'insufficient_privilege';
  end if;

  -- Capability re-checked AT COMMIT TIME, against the acting person, in this company.
  if not public.actor_has_capability(v_actor, p_company, 'operations.task.manage') then
    raise exception 'a routing decision requires operations.task.manage in this company'
      using errcode = 'insufficient_privilege';
  end if;

  return query select * from public._route_task_internal(
    p_company, p_task, p_desired_state, p_reason_code, p_required_capability, p_proposed,
    p_assignee, p_queue, p_approval, v_actor, 'human', p_submitter, null, null, null);
end;
$$;

-- Granted to AUTHENTICATED ONLY. The service role is explicitly excluded, which is what makes
-- "a service caller cannot create a human decision" a property of the grant rather than of a check
-- someone could forget.
revoke all on function public.route_task_as_human(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid) from public, anon, service_role;
grant execute on function public.route_task_as_human(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (5) The SYSTEM / AI paths — source fixed by the function
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.route_task_as_ai(
  p_company uuid,
  p_task uuid,
  p_desired_state text,
  p_reason_code text,
  p_component text,
  p_model text default null,
  p_policy_version text default null,
  p_required_capability text default null,
  p_proposed jsonb default '[]'::jsonb,
  p_assignee uuid default null,
  p_queue text default null,
  p_approval uuid default null,
  p_submitter uuid default null
)
returns table (routing_id uuid, routing_state text, reason_code text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'route_task_as_ai is a service-only boundary' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_component), '') = '' then
    raise exception 'p_component is required — an AI decision must name the component that made it';
  end if;
  -- 'ai' is a LITERAL here. There is no parameter through which a caller could say anything else.
  return query select * from public._route_task_internal(
    p_company, p_task, p_desired_state, p_reason_code, p_required_capability, p_proposed,
    p_assignee, p_queue, p_approval, null, 'ai', p_submitter, p_component, p_model, p_policy_version);
end;
$$;

create or replace function public.route_task_as_system(
  p_company uuid,
  p_task uuid,
  p_desired_state text,
  p_reason_code text,
  p_component text,
  p_policy_version text default null,
  p_required_capability text default null,
  p_proposed jsonb default '[]'::jsonb,
  p_assignee uuid default null,
  p_queue text default null,
  p_approval uuid default null,
  p_submitter uuid default null
)
returns table (routing_id uuid, routing_state text, reason_code text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'route_task_as_system is a service-only boundary' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_component), '') = '' then
    raise exception 'p_component is required — a system decision must name the component that made it';
  end if;
  return query select * from public._route_task_internal(
    p_company, p_task, p_desired_state, p_reason_code, p_required_capability, p_proposed,
    p_assignee, p_queue, p_approval, null, 'system', p_submitter, p_component, null, p_policy_version);
end;
$$;

revoke all on function public.route_task_as_ai(uuid,uuid,text,text,text,text,text,text,jsonb,uuid,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.route_task_as_ai(uuid,uuid,text,text,text,text,text,text,jsonb,uuid,text,uuid,uuid) to service_role;
revoke all on function public.route_task_as_system(uuid,uuid,text,text,text,text,text,jsonb,uuid,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.route_task_as_system(uuid,uuid,text,text,text,text,text,jsonb,uuid,text,uuid,uuid) to service_role;

-- The old signature took provenance as arguments. It is removed, not deprecated: leaving it in
-- place would leave the forgery reachable.
drop function if exists public.route_task(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid,text,uuid);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (6) Enforcement at the table — direct DML cannot produce contradictory provenance
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.task_routing_provenance_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- Only the trusted writer may create a routing row at all. A POSITIVE owner allowlist: a
    -- bespoke custom role is refused exactly as service_role is.
    if not public._is_task_routing_owner() then
      raise exception 'task_routing rows are created only by the routing boundary (route_task_as_human / _as_ai / _as_system)'
        using errcode = 'insufficient_privilege';
    end if;
    if new.decided_by_source = 'human' then
      if new.decided_by is null then
        raise exception 'a human routing decision must record the person who made it';
      end if;
      if new.decided_by_model is not null or new.decided_by_component is not null then
        raise exception 'a human routing decision must not carry machine provenance';
      end if;
    else
      if new.decided_by is not null then
        raise exception 'a % routing decision must not carry a human identity', new.decided_by_source;
      end if;
      if coalesce(btrim(coalesce(new.decided_by_component, '')), '') = '' then
        raise exception 'a % routing decision must name the component that made it', new.decided_by_source;
      end if;
    end if;
    return new;
  end if;

  -- Provenance is IMMUTABLE. The lifecycle columns (is_active, superseded_by, updated_at,
  -- next_attempt_at) stay writable so supersession still works.
  if new.decided_by is distinct from old.decided_by
     or new.decided_by_source is distinct from old.decided_by_source
     or new.decided_by_component is distinct from old.decided_by_component
     or new.decided_by_model is distinct from old.decided_by_model
     or new.decided_by_policy_version is distinct from old.decided_by_policy_version
     or new.task_id is distinct from old.task_id
     or new.company_id is distinct from old.company_id
     or new.routing_state is distinct from old.routing_state
     or new.assignee_id is distinct from old.assignee_id then
    raise exception 'a routing decision is immutable — supersede it with a new one instead'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists task_routing_provenance_trg on public.task_routing;
create trigger task_routing_provenance_trg
  before insert or update on public.task_routing
  for each row execute function public.task_routing_provenance_guard();

revoke all on function public.task_routing_provenance_guard() from public, anon, authenticated;

-- Routing HISTORY may only be written by the same trusted boundary.
create or replace function public.task_routing_events_writer_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if not public._is_task_routing_owner() then
    raise exception 'routing history is written only by the routing boundary'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists task_routing_events_writer_trg on public.task_routing_events;
create trigger task_routing_events_writer_trg
  before insert on public.task_routing_events
  for each row execute function public.task_routing_events_writer_guard();

revoke all on function public.task_routing_events_writer_guard() from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (7) Fail closed
-- ─────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare bad text;
begin
  -- The human path must be UNREACHABLE from the service context.
  if has_function_privilege('service_role', 'public.route_task_as_human(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid)', 'EXECUTE') then
    raise exception '0078 fail-closed: service_role can execute route_task_as_human';
  end if;
  if not has_function_privilege('authenticated', 'public.route_task_as_human(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid)', 'EXECUTE') then
    raise exception '0078 fail-closed: authenticated cannot execute route_task_as_human — the human path would be unusable';
  end if;

  -- The machine paths must be unreachable from an untrusted session.
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('route_task_as_ai', 'route_task_as_system', '_route_task_internal',
                       '_is_task_routing_owner', 'task_routing_provenance_guard', 'task_routing_events_writer_guard')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if bad is not null then
    raise exception '0078 fail-closed: % reachable by anon/authenticated', bad;
  end if;

  -- The shared implementation must be unreachable even from the service context.
  if has_function_privilege('service_role', '_route_task_internal(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid,text,uuid,text,text,text)'::regprocedure, 'EXECUTE') then
    raise exception '0078 fail-closed: service_role can call the internal routing implementation directly';
  end if;

  -- The old spoofable signature must be gone.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'route_task'
  ) then
    raise exception '0078 fail-closed: the caller-supplied-provenance route_task still exists';
  end if;
end $$;

commit;
