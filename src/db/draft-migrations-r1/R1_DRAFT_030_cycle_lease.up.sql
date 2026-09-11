-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_030 — the cycle lock becomes a LEASE, because an advisory lock cannot survive a
-- connection pool.
--
-- ── The defect ──────────────────────────────────────────────────────────────────────────────
--
-- `r1_draft_try_cycle_lock` (draft 011) is `pg_try_advisory_lock`, which is SESSION-scoped: the
-- lock belongs to the PostgreSQL backend that took it and only that backend can release it.
--
-- The deployed application reaches the database through PostgREST, which holds a CONNECTION POOL.
-- So `tryLock` takes the lock on whichever pooled backend served that request, and `releaseLock`
-- arrives later on whichever backend is free then — usually a different one. `pg_advisory_unlock`
-- on a lock this session does not hold returns false and releases nothing. The original backend
-- keeps the lock for as long as it stays in the pool.
--
-- Measured on the hard-scenario stack, through real PostgREST:
--
--     try_lock    -> true      (taken on pooled backend A)
--     release     -> FALSE     (ran on backend B; released nothing)
--     try_lock    -> FALSE     (A still holds it)
--     pg_locks    -> 2 advisory locks held by 2 distinct "PostgREST 16.1" backends
--
-- The consequence in production is not subtle: the scheduled management cycle runs ONCE per
-- company and every run after it returns `skipped_locked`, until Supabase happens to recycle that
-- pooled connection. The loop stops, and the status it reports for stopping — "another cycle is
-- already running for this company" — is untrue.
--
-- ── Why no test caught it ───────────────────────────────────────────────────────────────────
--
-- Every existing suite reaches the database through `pgSupabase`, this repository's substitution
-- of the HTTP transport for a direct pg connection. That double uses ONE dedicated client, so
-- lock and unlock always land on the same session and the advisory lock works perfectly. The
-- substitution is declared and it is honest; it simply cannot exhibit a pooling defect, because it
-- does not pool. It took a real PostgREST in front of a real pool to show it.
--
-- ── The replacement ─────────────────────────────────────────────────────────────────────────
--
-- A LEASE row, which is the pattern this repository already uses for the outbox
-- (`locked_at`/`lock_owner`/`lease_expires_at` on `message_outbox`). It is owned by the CYCLE, not
-- by a connection, so any backend can release it — and it EXPIRES, so a cycle that crashes without
-- releasing heals itself instead of blocking the company for ever, which the advisory lock did not
-- do either.
--
-- The owner token is supplied by the caller and compared on release: a cycle may only release the
-- lease it holds. A caller that passes somebody else's token releases nothing.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 1. The lease table
-- ═════════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.management_cycle_leases (
  company_id  uuid primary key,
  owner       text        not null,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);

alter table public.management_cycle_leases enable row level security;
-- No policy: the lease is service-only, reached exclusively through the functions below.
revoke all on public.management_cycle_leases from public, anon, authenticated;

comment on table public.management_cycle_leases is
  'Cycle mutual exclusion, owned by the cycle rather than by a database session. Replaces the '
  'advisory lock of draft 011, which a connection pool made unreleasable (R1_DRAFT_030).';

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 2. Acquire
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- One statement. The `on conflict` arbitrates, so two callers racing cannot both succeed: the
-- loser's `where` clause fails and the update affects no row.
--
-- A lease is takeable when there is none, when it has EXPIRED, or when the same owner is
-- re-entering — the last so that a retry inside one cycle is not a deadlock against itself.

create or replace function public.r1_draft_acquire_cycle_lease(
  p_company uuid,
  p_owner   text,
  p_ttl_seconds int default 900
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_got boolean;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'r1_draft_acquire_cycle_lease is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if p_owner is null or btrim(p_owner) = '' then
    raise exception 'an owner token is required' using errcode = 'null_value_not_allowed';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 or p_ttl_seconds > 3600 then
    raise exception 'ttl must be between 1 and 3600 seconds' using errcode = 'check_violation';
  end if;

  insert into public.management_cycle_leases (company_id, owner, acquired_at, expires_at)
  values (p_company, p_owner, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (company_id) do update
     set owner = excluded.owner,
         acquired_at = excluded.acquired_at,
         expires_at = excluded.expires_at
   where public.management_cycle_leases.expires_at <= now()
      or public.management_cycle_leases.owner = excluded.owner;

  get diagnostics v_got = row_count;
  return v_got;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 3. Release
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Only the holder may release. Returns whether it did, so a caller that has lost its lease to an
-- expiry learns that rather than assuming success.

create or replace function public.r1_draft_release_cycle_lease(
  p_company uuid,
  p_owner   text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_done boolean;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'r1_draft_release_cycle_lease is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  delete from public.management_cycle_leases
   where company_id = p_company and owner = p_owner;

  get diagnostics v_done = row_count;
  return v_done;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 4. Grants — service-only
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
declare v_sig text;
begin
  foreach v_sig in array array[
    'public.r1_draft_acquire_cycle_lease(uuid,text,integer)',
    'public.r1_draft_release_cycle_lease(uuid,text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_sig);
    execute format('grant execute on function %s to service_role', v_sig);
  end loop;
end
$$;

grant select, insert, update, delete on public.management_cycle_leases to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 5. The advisory-lock functions are REMOVED, not left beside the replacement
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Leaving them would leave a working-looking cycle lock that silently stops the loop, one import
-- away from being used again. A function that cannot do its job on the deployed transport should
-- not be reachable on it.

drop function if exists public.r1_draft_try_cycle_lock(uuid);
drop function if exists public.r1_draft_release_cycle_lock(uuid);

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 6. Fail-closed self-verification
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
declare v_bad text;
begin
  if to_regprocedure('public.r1_draft_try_cycle_lock(uuid)') is not null then
    raise exception 'R1_DRAFT_030 ABORT: the session-scoped advisory lock function still exists';
  end if;

  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'r1_draft_%cycle_lease'
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'R1_DRAFT_030 ABORT: lease functions reachable by anon/authenticated: %', v_bad;
  end if;

  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'management_cycle_leases'
         and c.relrowsecurity) <> 1 then
    raise exception 'R1_DRAFT_030 ABORT: the lease table must have RLS enabled';
  end if;
end
$$;
