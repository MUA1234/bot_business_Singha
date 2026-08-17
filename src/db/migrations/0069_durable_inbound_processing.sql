-- 0069 — durable inbound processing: leases, bounded retry, dead-letter, fair eligibility.
--
-- WHY: the verification campaign had to retract a claim that a failed inbound message "is retried".
-- Nothing retried it: the webhook acknowledges 200 whatever happens, and no sweeper existed. It also
-- found that leaving a failing conversation permanently due let one poison row occupy every batch.
-- Both are the same missing thing — a durable processing model with attempts, backoff and leases.
--
-- DESIGN NOTES
--   * Fairness is by ELIGIBILITY, not by ordering. A failing row's `next_attempt_at` moves into the
--     future under bounded exponential backoff, so it stops being eligible and later work proceeds.
--     Ordering (`next_attempt_at`, `id`) only breaks ties among rows that are ALL already eligible.
--   * `attempts` increments at CLAIM time, not at failure. A worker that crashes mid-processing has
--     still consumed an attempt, so a row that reliably kills its worker eventually dead-letters
--     instead of being retried forever.
--   * Every function is service-only, SECURITY DEFINER, with the canonical search_path this
--     repository pins everywhere (`pg_catalog, extensions, public, pg_temp`, pg_temp LAST) — see
--     migration 0067. `caller_jwt_role()` gates each one so an unknown caller fails closed.
--
-- LIFECYCLE: pending → processing → (completed | retry_wait → processing … | dead_letter)
--   The legacy value 'received' written by the WhatsApp webhook is treated as pending-equivalent, so
--   this migration changes no existing writer. `source_events.status` already carries a CHECK
--   constraint from migration 0004 allowing received/processing/processed/failed/dead_letter/
--   duplicate; it is EXTENDED here (never narrowed) so the new lifecycle values are legal and every
--   existing writer keeps working. Without this the retry path would have failed at runtime — an
--   integration test caught it before it shipped.

begin;

-- ── Columns ────────────────────────────────────────────────────────────────────────────────────
alter table public.source_events
  add column if not exists next_attempt_at    timestamptz not null default now(),
  add column if not exists lease_owner        text,
  add column if not exists lease_acquired_at  timestamptz,
  add column if not exists lease_expires_at   timestamptz,
  add column if not exists last_error_code    text,
  add column if not exists dead_lettered_at   timestamptz,
  add column if not exists dead_letter_reason text;

-- Extend the status vocabulary ADDITIVELY: every legacy value stays legal.
alter table public.source_events drop constraint if exists source_events_status_check;
alter table public.source_events add constraint source_events_status_check
  check (status = any (array[
    -- legacy (migration 0004) — still written by existing routes
    'received', 'processing', 'processed', 'failed', 'dead_letter', 'duplicate',
    -- durable processing lifecycle (this migration)
    'pending', 'retry_wait', 'completed'
  ]));

comment on column public.source_events.next_attempt_at is
  'Earliest time this row may be claimed. Bounded exponential backoff moves it forward on failure — this is the fairness mechanism, not ordering.';
comment on column public.source_events.lease_owner is
  'Worker identity holding the current lease. Only the lease owner may complete or fail the row.';
comment on column public.source_events.dead_lettered_at is
  'Set when attempts are exhausted. A dead-lettered row is never claimed again.';

-- Eligibility scan: the sweeper reads (dead_lettered_at is null, status, next_attempt_at).
create index if not exists source_events_eligible_idx
  on public.source_events (next_attempt_at, id)
  where dead_lettered_at is null;

-- Expired-lease recovery scan.
create index if not exists source_events_lease_idx
  on public.source_events (lease_expires_at)
  where lease_expires_at is not null;

-- Health/backlog counts are always company-scoped.
create index if not exists source_events_company_status_idx
  on public.source_events (company_id, status);

-- ── Deterministic backoff ──────────────────────────────────────────────────────────────────────
-- 30s, 60s, 120s, 240s … capped at 1 hour. Pure and deterministic: same attempt count, same delay.
create or replace function public.inbound_backoff_seconds(p_attempts integer)
returns integer
language sql
immutable
set search_path = pg_catalog, extensions, public, pg_temp
as $$
  select least(3600, 30 * (2 ^ greatest(0, least(p_attempts, 10) - 1)))::integer;
$$;

-- ── Claim ──────────────────────────────────────────────────────────────────────────────────────
-- Atomic, lease-taking claim. FOR UPDATE SKIP LOCKED so two workers never take the same row, and
-- a row locked by a concurrent claimer is skipped rather than waited on.
create or replace function public.claim_source_events(
  p_limit integer,
  p_owner text,
  p_lease_seconds integer default 120
)
returns setof public.source_events
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'claim_source_events is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_owner), '') = '' then
    raise exception 'p_owner is required — an unnamed lease cannot be recovered or audited';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'p_limit must be between 1 and 500 (got %)', p_limit;
  end if;

  return query
  with eligible as (
    select e.id
      from public.source_events e
     where e.dead_lettered_at is null
       and (
         -- Fresh or waiting-for-retry work whose time has come.
         (e.status in ('received', 'pending', 'retry_wait') and e.next_attempt_at <= now())
         -- …or a row whose worker died: the lease has expired and it is recoverable.
         or (e.status = 'processing' and e.lease_expires_at is not null and e.lease_expires_at < now())
       )
     order by e.next_attempt_at, e.id
     limit p_limit
     for update skip locked
  )
  update public.source_events s
     set status            = 'processing',
         attempts          = coalesce(s.attempts, 0) + 1,
         lease_owner       = p_owner,
         lease_acquired_at = now(),
         lease_expires_at  = now() + make_interval(secs => greatest(1, p_lease_seconds))
    from eligible
   where s.id = eligible.id
  returning s.*;
end;
$$;

-- ── Complete ───────────────────────────────────────────────────────────────────────────────────
-- Idempotent: completing an already-completed row succeeds and changes nothing.
create or replace function public.complete_source_event(p_id uuid, p_owner text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_status text;
  v_owner  text;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'complete_source_event is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  select s.status, s.lease_owner into v_status, v_owner
    from public.source_events s where s.id = p_id for update;
  if not found then
    raise exception 'source event % not found', p_id;
  end if;

  if v_status = 'completed' then
    return true; -- idempotent replay of a successful completion
  end if;
  if v_status = 'dead_letter' then
    return false; -- a dead-lettered row is terminal; completing it would rewrite history
  end if;
  -- Only the lease holder may complete. A stale worker whose lease was reassigned must not be able
  -- to mark the row done after another worker has taken it.
  if v_owner is distinct from p_owner then
    raise exception 'lease is held by a different worker' using errcode = 'lock_not_available';
  end if;

  update public.source_events
     set status = 'completed',
         processed_at = now(),
         lease_owner = null,
         lease_expires_at = null,
         last_error = null,
         last_error_code = null
   where id = p_id;
  return true;
end;
$$;

-- ── Fail ───────────────────────────────────────────────────────────────────────────────────────
-- Records the error, applies bounded backoff, and dead-letters once attempts are exhausted.
create or replace function public.fail_source_event(
  p_id uuid,
  p_owner text,
  p_error_code text,
  p_error text,
  p_max_attempts integer default 5
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_attempts integer;
  v_status   text;
  v_owner    text;
  v_delay    integer;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'fail_source_event is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  select s.attempts, s.status, s.lease_owner into v_attempts, v_status, v_owner
    from public.source_events s where s.id = p_id for update;
  if not found then
    raise exception 'source event % not found', p_id;
  end if;
  if v_status in ('completed', 'dead_letter') then
    return v_status; -- terminal states are not reopened by a late failure report
  end if;
  if v_owner is distinct from p_owner then
    raise exception 'lease is held by a different worker' using errcode = 'lock_not_available';
  end if;

  if coalesce(v_attempts, 0) >= greatest(1, p_max_attempts) then
    update public.source_events
       set status = 'dead_letter',
           dead_lettered_at = now(),
           dead_letter_reason = left(coalesce(p_error, 'unknown'), 500),
           last_error = left(coalesce(p_error, 'unknown'), 2000),
           last_error_code = left(coalesce(p_error_code, 'unknown'), 100),
           lease_owner = null,
           lease_expires_at = null
     where id = p_id;
    return 'dead_letter';
  end if;

  v_delay := public.inbound_backoff_seconds(coalesce(v_attempts, 0));
  update public.source_events
     set status = 'retry_wait',
         next_attempt_at = now() + make_interval(secs => v_delay),
         last_error = left(coalesce(p_error, 'unknown'), 2000),
         last_error_code = left(coalesce(p_error_code, 'unknown'), 100),
         lease_owner = null,
         lease_expires_at = null
   where id = p_id;
  return 'retry_wait';
end;
$$;

-- ── Health / backlog ───────────────────────────────────────────────────────────────────────────
-- Company-scoped by parameter so one company's backlog can never be reported to another. The
-- campaign found a dashboard counting every tenant's dead letters; this signature makes that
-- mistake impossible to write.
create or replace function public.source_event_backlog(p_company uuid)
returns table (
  pending bigint,
  processing bigint,
  retry_wait bigint,
  expired_lease bigint,
  dead_letter bigint,
  oldest_pending_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'source_event_backlog is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if p_company is null then
    raise exception 'p_company is required — an unscoped backlog count leaks across companies';
  end if;

  return query
  select
    count(*) filter (where s.dead_lettered_at is null and s.status in ('received','pending'))::bigint,
    count(*) filter (where s.status = 'processing')::bigint,
    count(*) filter (where s.status = 'retry_wait')::bigint,
    count(*) filter (where s.status = 'processing' and s.lease_expires_at is not null and s.lease_expires_at < now())::bigint,
    count(*) filter (where s.status = 'dead_letter')::bigint,
    min(s.received_at) filter (where s.dead_lettered_at is null and s.status in ('received','pending'))
  from public.source_events s
  where s.company_id = p_company;
end;
$$;

-- ── Privileges: service-only, fail closed for everyone else ─────────────────────────────────────
-- REVOKE FROM PUBLIC IS NOT ENOUGH. Supabase ships
--   `alter default privileges in schema public grant execute on functions to authenticated`
-- so every newly created function is granted EXECUTE to `authenticated` DIRECTLY, and a revoke
-- aimed only at PUBLIC leaves that grant in place. The fail-closed assertion at the end of this
-- migration caught exactly that, which is why it is written the way it is. Name the roles.
revoke all on function public.claim_source_events(integer, text, integer) from public, anon, authenticated;
revoke all on function public.complete_source_event(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_source_event(uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.source_event_backlog(uuid) from public, anon, authenticated;
revoke all on function public.inbound_backoff_seconds(integer) from public, anon, authenticated;

grant execute on function public.claim_source_events(integer, text, integer) to service_role;
grant execute on function public.complete_source_event(uuid, text) to service_role;
grant execute on function public.fail_source_event(uuid, text, text, text, integer) to service_role;
grant execute on function public.source_event_backlog(uuid) to service_role;
grant execute on function public.inbound_backoff_seconds(integer) to service_role;

-- Fail closed at migration time if any of these ended up reachable by an untrusted role.
do $$
declare
  bad text;
begin
  select string_agg(p.proname, ', ')
    into bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('claim_source_events','complete_source_event','fail_source_event','source_event_backlog')
     and (
       has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE')
     );
  if bad is not null then
    raise exception '0069 fail-closed: % reachable by anon/authenticated', bad;
  end if;
end $$;

commit;
