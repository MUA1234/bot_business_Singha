-- 0077 — inbound boundary, correction loop 2.
--
-- A second independent adversarial review of the loop-1 correction found that two of the fixes had
-- traded one defect for another. Every finding below was REPRODUCED on live PostgreSQL before being
-- accepted. This is a new migration rather than an edit to 0076 so the audit trail survives: 0076 is
-- what was reviewed, 0077 is what the review changed.
--
--   (1) EVERY STAFF-FINANCE CAPTURE ENDED WITH company_id = NULL.  The production call graph records
--       the dispatch TWICE — once from the capture marker (which had no company) and once from the
--       orchestration (which does) — and the second call took the idempotent-replay branch, which
--       returned without ever writing the company. Removing the duplicate `source_events` row had
--       therefore replaced it with a lost tenant scope: the row was claimable with a NULL company,
--       the company-scoped backlog reported zero for the company that received it, no user could
--       ever see it under RLS, and duplicate scoring — which keys on the company — was disabled.
--       CLAUDE.md: "Every record must have explicit company scope."
--
--   (2) A DECIDED NON-CAPTURE RECEIPT KEPT status='received' FOREVER, so `/api/health`'s raw
--       "unprocessed events" count stayed inflated by every customer-order message — the very
--       symptom the loop-1 commit claimed to have fixed.
--
--   (3) A CLAIMED ROW WITH NO PROCESSOR WAS DEAD-LETTERED.  The only wired sweeper returns
--       `no_processor` for everything, and 0076 narrowed claiming to exactly the finance captures —
--       so each capture would be destroyed within one cron interval. Unbuilt work is not poison.
--
--   (4) `route_task` accepted `p_actor_source = 'human'` on the caller's word alone.
--
--   (5) The 0076 owner assertion matched an UNQUALIFIED `regprocedure` text with no pinned
--       search_path, so it could abort for the wrong reason on a session that does not have `public`
--       on its path.
--
--   (6) The canonical identity concatenated components with an unescaped `:`.
--
-- Forward-only, idempotent DDL. No feature flag (a correctness boundary, not a capability).

begin;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (1)(2) The dispatch marker: never lose the company, and settle a decided receipt's status
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.record_inbound_dispatch(
  p_event uuid,
  p_owner text,
  p_outcome text,
  p_company uuid default null,
  p_downstream_kind text default null,
  p_downstream_id uuid default null
)
returns table (dispatch_state text, consumer_ready boolean, already boolean)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v record;
  v_capture boolean;
  v_state text;
  v_company uuid;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'record_inbound_dispatch is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outcome not in ('customer_order', 'staff_finance', 'manual_review', 'recorded', 'clarification') then
    raise exception 'unsupported dispatch outcome %', p_outcome;
  end if;

  select s.id, s.dispatch_state, s.dispatch_owner, s.dispatch_outcome, s.company_id, s.status
    into v from public.source_events s where s.id = p_event for update;
  if not found then raise exception 'source event % not found', p_event; end if;

  if v.dispatch_state = 'superseded' then
    raise exception 'a superseded receipt cannot be dispatched';
  end if;

  v_company := coalesce(v.company_id, p_company);

  -- IDEMPOTENT REPLAY. A retry that already recorded this outcome succeeds and changes nothing —
  -- EXCEPT that it still fills a company that is missing. The production path records the capture
  -- marker BEFORE the company is threaded through, so a replay branch that ignored p_company left
  -- every finance capture permanently unattributed.
  if v.dispatch_state in ('dispatched', 'manual_review') then
    if v.dispatch_outcome is distinct from p_outcome then
      raise exception 'event % is already dispatched as % — refusing to rewrite it as %',
        p_event, v.dispatch_outcome, p_outcome;
    end if;
    if v.company_id is null and p_company is not null then
      update public.source_events set company_id = p_company where id = p_event;
    end if;
    return query select v.dispatch_state, (v.dispatch_outcome = 'staff_finance'), true;
    return;
  end if;

  if v.dispatch_owner is distinct from p_owner then
    raise exception 'dispatch lease is held by a different worker' using errcode = 'lock_not_available';
  end if;

  v_capture := (p_outcome = 'staff_finance');
  v_state := case when p_outcome = 'manual_review' then 'manual_review' else 'dispatched' end;

  update public.source_events
     set dispatch_state = v_state,
         dispatch_outcome = p_outcome,
         dispatched_at = now(),
         dispatch_owner = null,
         dispatch_lease_expires_at = null,
         downstream_kind = coalesce(p_downstream_kind, downstream_kind),
         downstream_id = coalesce(p_downstream_id, downstream_id),
         -- Company scope is a TRUSTED parameter and is only ever FILLED IN, never changed.
         company_id = v_company,
         -- Only a finance capture becomes consumer work. Everything else is DECIDED, and a decided
         -- receipt must stop counting as unprocessed — the raw status count is what /api/health
         -- reads, and leaving it 'received' kept the backlog signal permanently inflated.
         status = case
                    when v_capture then 'pending'
                    when status in ('received', 'pending') then 'processed'
                    else status
                  end,
         next_attempt_at = case when v_capture then now() else next_attempt_at end
   where id = p_event;

  return query select v_state, v_capture, false;
end;
$$;

-- Fail closed: a finance capture with no company is exactly the leak this migration exists to stop,
-- so the boundary refuses it rather than letting the caller create one. A trigger, so no future
-- writer — RPC or otherwise — can reintroduce it.
create or replace function public.source_events_capture_needs_company()
returns trigger
language plpgsql
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if new.dispatch_outcome = 'staff_finance' and new.dispatch_state = 'dispatched' and new.company_id is null then
    raise exception 'a staff_finance capture must be company-scoped (event %)', new.id
      using errcode = 'not_null_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists source_events_capture_company_trg on public.source_events;
create trigger source_events_capture_company_trg
  before insert or update on public.source_events
  for each row execute function public.source_events_capture_needs_company();

revoke all on function public.source_events_capture_needs_company() from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (3) Release, don't destroy: a row nothing can process yet is not a poison row
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.release_source_event(p_id uuid, p_owner text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v record;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'release_source_event is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  select s.id, s.status, s.lease_owner, s.attempts into v
    from public.source_events s where s.id = p_id for update;
  if not found then raise exception 'source event % not found', p_id; end if;
  if v.status in ('completed', 'dead_letter') then return false; end if;
  if v.lease_owner is distinct from p_owner then
    raise exception 'lease is held by a different worker' using errcode = 'lock_not_available';
  end if;

  -- The attempt is GIVEN BACK. `claim_source_events` increments attempts at claim time so a worker
  -- that dies still consumes one; a worker that correctly reports "nothing here can process this
  -- yet" has not tried, and charging it would dead-letter real captures while the processor is
  -- unbuilt.
  update public.source_events
     set status = 'pending',
         attempts = greatest(0, coalesce(v.attempts, 1) - 1),
         lease_owner = null,
         lease_acquired_at = null,
         lease_expires_at = null,
         next_attempt_at = now() + interval '10 minutes'
   where id = p_id;
  return true;
end;
$$;

revoke all on function public.release_source_event(uuid, text) from public, anon, authenticated;
grant execute on function public.release_source_event(uuid, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (4) `human` must name a real person in this company
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.route_task(
  p_company uuid,
  p_task uuid,
  p_desired_state text,
  p_reason_code text,
  p_required_capability text default null,
  p_proposed jsonb default '[]'::jsonb,
  p_assignee uuid default null,
  p_queue text default null,
  p_approval uuid default null,
  p_actor uuid default null,
  p_actor_source text default 'system',
  p_submitter uuid default null
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
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'route_task is a service-only boundary' using errcode = 'insufficient_privilege';
  end if;
  if p_company is null or p_task is null then raise exception 'company and task are required'; end if;

  -- A HUMAN decision must name a human. The guard that protects a person's assignment keys on this
  -- value, so accepting it on the caller's word alone made the protection a formality.
  if coalesce(p_actor_source, 'system') = 'human' then
    if p_actor is null then
      raise exception 'a human decision must name the person who made it';
    end if;
    if not exists (
      select 1 from public.memberships m
       where m.user_id = p_actor and m.company_id = p_company and m.status = 'active'
    ) then
      raise exception 'actor % is not an active member of this company', p_actor
        using errcode = 'insufficient_privilege';
    end if;
  end if;

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

  -- A PERSON'S DECISION STANDS.
  if v_prev.id is not null
     and v_prev.routing_state = 'assigned'
     and v_prev.decided_by_source = 'human'
     and coalesce(p_actor_source, 'system') in ('ai', 'system') then
    insert into public.task_routing_events (
      company_id, task_id, routing_id, from_state, to_state, reason_code, detail, actor_id, actor_source
    ) values (
      p_company, p_task, v_prev.id, v_prev.routing_state, v_prev.routing_state, 'automated_supersede_refused',
      jsonb_build_object('requested_state', p_desired_state, 'requested_reason', p_reason_code),
      p_actor, coalesce(p_actor_source, 'system')
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
    assignee_id, queue_name, approval_request_id, attempt_count, decided_by, decided_by_source
  ) values (
    p_company, p_task, v_state, v_reason, nullif(btrim(coalesce(p_required_capability, '')), ''),
    coalesce(p_proposed, '[]'::jsonb),
    case when v_state = 'assigned' then v_assignee else null end,
    case when v_state = 'assigned' then null else nullif(btrim(coalesce(p_queue, '')), '') end,
    case when v_state = 'awaiting_approval' then p_approval else null end,
    coalesce(v_prev.attempt_count, 0) + 1,
    p_actor, coalesce(p_actor_source, 'system')
  ) returning id into v_id;

  if v_prev.id is not null then
    update public.task_routing set superseded_by = v_id, updated_at = now() where id = v_prev.id;
  end if;

  insert into public.task_routing_events (company_id, task_id, routing_id, from_state, to_state, reason_code, detail, actor_id, actor_source)
  values (p_company, p_task, v_id, v_prev.routing_state, v_state, v_reason,
          jsonb_build_object('proposed', coalesce(p_proposed, '[]'::jsonb), 'refused_reason', v_bad),
          p_actor, coalesce(p_actor_source, 'system'));

  return query select v_id, v_state, v_reason;
end;
$$;

revoke all on function public.route_task(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.route_task(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid,text,uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (6) Canonical identity: escape the delimiter
--
-- Components were joined with a bare `:`, so `(account 'pn:one', id 'wamid.Y')` and
-- `(account 'pn', id 'one:wamid.Y')` produced the same key. Meta's own values contain no colon, so
-- this was theoretical — but a canonical key should not depend on that. Every existing identity is
-- RECOMPUTED below, so a value that did contain a colon is corrected rather than left inconsistent.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.canonical_event_identity(
  p_channel text,
  p_provider_account_id text,
  p_provider_message_id text,
  p_purpose text default 'inbound_message'
)
returns text
language sql
immutable
set search_path = pg_catalog, extensions, public, pg_temp
as $$
  -- Each component is percent-escaped for `%` and `:` before joining, so no combination of values
  -- can produce another combination's key.
  select case
    when nullif(btrim(coalesce(p_channel, '')), '') is null then null
    when nullif(btrim(coalesce(p_provider_message_id, '')), '') is null then null
    else 'ev1:'
      || replace(replace(lower(btrim(p_channel)), '%', '%25'), ':', '%3A')
      || ':' || replace(replace(coalesce(public.normalize_channel_account(p_provider_account_id), '-'), '%', '%25'), ':', '%3A')
      || ':' || replace(replace(btrim(p_provider_message_id), '%', '%25'), ':', '%3A')
      || ':' || replace(replace(lower(btrim(coalesce(nullif(btrim(p_purpose), ''), 'inbound_message'))), '%', '%25'), ':', '%3A')
  end;
$$;

revoke all on function public.canonical_event_identity(text, text, text, text) from public, anon, authenticated;
grant execute on function public.canonical_event_identity(text, text, text, text) to service_role;

-- Re-stamp: only rows whose key actually changes are touched, and a row that would now collide with
-- an existing key keeps its old one rather than failing the migration (it simply does not dedupe,
-- which is the safe direction).
do $$
declare r record; v_new text;
begin
  for r in
    select id, source, provider_account_id, provider_message_id, event_purpose, event_identity
      from public.source_events
     where event_identity is not null and dispatch_state <> 'superseded'
     order by received_at, id
  loop
    v_new := public.canonical_event_identity(r.source, r.provider_account_id, r.provider_message_id, r.event_purpose);
    if v_new is not null and v_new is distinct from r.event_identity
       and not exists (select 1 from public.source_events x where x.event_identity = v_new) then
      update public.source_events set event_identity = v_new where id = r.id;
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (5) The capability-owner assertion, done so it cannot abort for the wrong reason
-- ─────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_wrapper oid;
  v_inner   oid;
begin
  -- Matched on proname + identity ARGUMENTS rather than on unqualified `regprocedure` text, which
  -- renders schema-qualified when `public` is not on the session search_path and therefore matched
  -- nothing — aborting with "the wrapper is missing" on a database where it plainly exists.
  -- A SCHEMA-QUALIFIED regprocedure cast: resolved at parse time, independent of the session
  -- search_path, and it compares argument TYPES rather than the rendered text (which carries
  -- parameter NAMES and therefore never matched a bare type list).
  select 'public.has_capability(uuid,text)'::regprocedure::oid into v_wrapper;
  select 'public.actor_has_capability(uuid,uuid,text)'::regprocedure::oid into v_inner;
  if v_wrapper is null or v_inner is null then
    raise exception '0077 fail-closed: the capability wrapper or its implementation is missing';
  end if;
  if (select proowner from pg_catalog.pg_proc where oid = v_wrapper)
     is distinct from (select proowner from pg_catalog.pg_proc where oid = v_inner) then
    raise exception '0077 fail-closed: has_capability and actor_has_capability have different owners';
  end if;
  perform public.has_capability(gen_random_uuid(), 'operations.inbound.review');
end $$;

-- Fail closed on the new surface.
do $$
declare bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('release_source_event', 'source_events_capture_needs_company',
                       'record_inbound_dispatch', 'route_task', 'canonical_event_identity')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if bad is not null then
    raise exception '0077 fail-closed: % reachable by anon/authenticated', bad;
  end if;

  if exists (select 1 from public.source_events
              where dispatch_outcome = 'staff_finance' and dispatch_state = 'dispatched' and company_id is null) then
    raise exception '0077 fail-closed: a staff_finance capture exists with no company scope';
  end if;
end $$;

commit;
