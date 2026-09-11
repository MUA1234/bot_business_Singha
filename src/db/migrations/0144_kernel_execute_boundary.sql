-- 0144_kernel_execute_boundary.sql
-- Close the EXECUTE grants the promoted kernel chain never wrote.
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
--
-- Supabase's default privileges grant EXECUTE on every new function in `public` to `anon` and
-- `authenticated`:
--
--     alter default privileges in schema public grant execute on functions to authenticated;
--
-- So a function in this schema is service-only ONLY IF a migration explicitly revokes it. Absence
-- of a grant is not a boundary; it is the widest possible one. The released chain knows this and
-- revokes deliberately, function by function.
--
-- The kernel chain did not, because it was never subject to the check. It lived in
-- `src/db/draft-migrations-r1/`, quarantined outside the numbered sequence under owner decision
-- R1-D-1, and the enumeration gates run against the CORE campaign, whose database has no draft
-- object on it. Promotion into 0112–0141 moved 46 kernel functions into the released lineage, and
-- the gates saw them for the first time. This migration is what they found.
--
-- ── WHAT WAS ACTUALLY REACHABLE ─────────────────────────────────────────────────────────────
--
-- Measured on a disposable PostgreSQL 16 carrying the whole chain, not read off the source:
--
--   * `r1_draft_ask_ai_purge_expired()` — SECURITY DEFINER, no caller gate, NO company scope. It
--     marks every expired Ask-AI thread across EVERY company and deletes their turns. Any
--     signed-in user could call it; verified by calling it as `authenticated` and watching it
--     return a row count rather than 42501. It only removes rows already past `expires_at`, so it
--     advances a purge that was going to happen — but it is a cross-tenant destructive entrypoint
--     that nobody decided to publish, and the operation belongs to the scheduled sweep.
--
--   * 28 TRIGGER functions — the append-only guards and company guards. Executable by `anon` and
--     `authenticated` alike. Calling one directly raises "trigger functions can only be called as
--     triggers", so this is surface rather than breach; it is still wrong, and the released chain
--     already treats a trigger function as reachable by nobody (`approval_requests_provenance_guard`,
--     `detect_management_directive_conflicts`, `tasks_set_identity_hash`).
--
--   * 6 helpers reachable by `anon`, including `r1_draft_transition_item` — the state-transition
--     RPC. It is NOT security definer, so RLS still governs what it can touch and `anon` sees no
--     rows; but an unauthenticated role should not be able to invoke the lifecycle at all.
--
-- ── WHAT IS DELIBERATELY LEFT ALONE ─────────────────────────────────────────────────────────
--
-- Nine kernel functions have an explicit `grant execute ... to authenticated` in the migration
-- that created them. Those are decisions, and this migration does not second-guess them:
-- `claim_task_completion`, `assign_management_item`, `record_management_decision`,
-- `evidence_digest`, `source_health`, `is_active_advisor`, `may_see_item`,
-- `may_see_management_item`, and the two capability helpers.
--
-- `may_see_item`, `may_see_management_item` and `ask_ai_expiry` are additionally evaluated INSIDE
-- RLS policies and default expressions. A policy predicate runs in the CALLER's role, so revoking
-- `authenticated` from those would not harden anything — it would break every read the policy
-- governs. They keep EXECUTE for `authenticated` and lose it for `anon`.
--
-- ── SAFETY ──────────────────────────────────────────────────────────────────────────────────
--
-- Revoking EXECUTE on a trigger function does not disarm its trigger: PostgreSQL checks EXECUTE
-- when the trigger is CREATED, not when it fires. The released chain relies on the same fact.
--
-- Idempotent: REVOKE of a privilege that is already absent is a no-op. Forward-only. No DDL on
-- any table, no data change.
--
-- ── NO ROLLBACK SCRIPT, DELIBERATELY ────────────────────────────────────────────────────────
--
-- There is no `src/db/rollback/0144_*.down.sql`, and there should not be. Reversing this
-- migration means handing `anon` back EXECUTE on the kernel, making the cross-company Ask-AI
-- purge callable by any signed-in user again, and re-opening `management_task_idempotency` to
-- every authenticated writer. A rollback script exists so an operator can undo a change safely
-- at 3am; a script that restores five security holes is a loaded gun in the repository, not a
-- safety net. 0142 and 0143 carry none for the same reason — they tighten bounds and referential
-- integrity, and "undo the tightening" is not an operation anyone should have ready to hand.
--
-- Nothing here can break a running system in a way that needs reversing: it removes privileges
-- nobody was using, on paths that were already refused by RLS or by a trigger. If that turns out
-- to be wrong, the fix is a forward migration that grants exactly what is missing, with the
-- reason written down — which is a review, not a rollback.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 1. Revoke, driven by the catalogue rather than by a hand-written list
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- A hand-written list is a list that goes stale the next time someone adds a function. The rules
-- below are stated as predicates over `pg_proc`, so a kernel function added later is covered by
-- the same reasoning without anyone remembering this file.
do $$
declare
  r record;
  v_trigger integer := 0;
  v_anon integer := 0;
  v_service_only integer := 0;
begin
  -- 1a. Trigger functions: reachable by nobody. They are fired, never called.
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'r1\_%'
       and pg_get_function_result(p.oid) = 'trigger'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
    v_trigger := v_trigger + 1;
  end loop;

  -- 1b. The retention purge: service-only maintenance, like every other scheduled sweep.
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'r1_draft_ask_ai_purge_expired'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    v_service_only := v_service_only + 1;
  end loop;

  -- 1c. Everything else in the kernel chain loses `anon`. No part of this chain is a public
  --     surface: there is no anonymous management, no anonymous Ask-AI, no anonymous lifecycle.
  --
  --     `revoke ... from anon` ALONE DOES NOTHING HERE, and the first draft of this migration
  --     aborted on its own assertion proving it. PostgreSQL grants EXECUTE on every new function
  --     to the PUBLIC pseudo-role, and `anon` reaches these through that, not through a grant of
  --     its own — so the privilege to remove is PUBLIC's. That is also why the released chain
  --     writes `revoke all on function ... from public` and not `from anon`.
  --
  --     Revoking PUBLIC would take the function away from `authenticated` and `service_role` too
  --     wherever they hold it only through PUBLIC. So each role's access is READ FIRST and put
  --     back after: this migration removes anonymous reach and changes nothing else. Preserving
  --     the surface explicitly beats assuming a deployment's default privileges match the shim's.
  for r in
    select p.oid::regprocedure::text as sig,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
           has_function_privilege('service_role', p.oid, 'execute') as svc_x
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'r1\_%'
       and pg_get_function_result(p.oid) <> 'trigger'
       and p.proname <> 'r1_draft_ask_ai_purge_expired'   -- handled above, and stays service-only
       and has_function_privilege('anon', p.oid, 'execute')
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    if r.auth_x then execute format('grant execute on function %s to authenticated', r.sig); end if;
    if r.svc_x then execute format('grant execute on function %s to service_role', r.sig); end if;
    v_anon := v_anon + 1;
  end loop;

  raise notice '0144: % trigger fn(s) closed, % service-only, % anon revocation(s)',
    v_trigger, v_service_only, v_anon;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 1d. `management_task_idempotency` — the one table the same omission reached
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- 0132 creates it with no RLS and no revoke. The shim's default privileges then hand
-- `authenticated` SELECT, INSERT, UPDATE and DELETE on it, so any signed-in user could read every
-- company's execution idempotency keys — and, worse, INSERT one. The keys are how
-- `r1_draft_create_internal_task` decides a request is a duplicate: planting a key for another
-- company's pending action makes the real call return "already done" and the approved action
-- never happens. A suppressed execution that reports success is a worse failure than a refused
-- one.
--
-- It is worker-only by nature. It is written exclusively by `r1_draft_create_internal_task`,
-- which is SECURITY DEFINER and service-only, and no screen reads it. So: RLS on, FORCE on (the
-- table owner is not exempt either), no policy at all — deny is the whole policy — and the DML
-- grants withdrawn from everyone but `service_role`.
--
-- All 25 other tables in the promoted chain were checked the same way and are already correct;
-- this is the only one.
do $$
begin
  if to_regclass('public.management_task_idempotency') is null then
    raise notice '0144: management_task_idempotency absent — skipped';
    return;
  end if;
  execute 'alter table public.management_task_idempotency enable row level security';
  execute 'alter table public.management_task_idempotency force row level security';
  execute 'revoke all on table public.management_task_idempotency from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.management_task_idempotency from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.management_task_idempotency from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on table public.management_task_idempotency to service_role';
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 1e. A table with no write policy should not carry a write GRANT either
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Seventeen kernel tables have RLS on, a read policy, and NO write policy — so every
-- authenticated INSERT, UPDATE and DELETE is already refused. The DML grant is nonetheless still
-- there, because Supabase's default privileges hand it out and nobody took it back.
--
-- RLS alone is one mechanism deep. The day RLS is disabled on one of these tables — a migration,
-- a restore, a `force` that gets dropped — the grant is live and the table is writable by every
-- signed-in user, with no policy to stop it. The released chain's convention is to revoke the
-- grant AND rely on the policy, and `security/rls-classification.json` calls these tables
-- `service_only` / `rpc_only`, which is a claim about privilege, not only about policy.
--
-- The rule is computed rather than listed: for each table of the promoted chain, if no policy
-- permits `authenticated` to INSERT, UPDATE or DELETE, then `authenticated` does not need the
-- privilege. SELECT is untouched — these tables are read by real screens through their read
-- policies. A table that later gains a write policy keeps its grant automatically, and a table
-- that loses one is re-closed the next time this runs.
do $$
declare
  t text;
  v_closed integer := 0;
  promoted text[] := array[
    'advisor_relationships', 'ask_ai_citations', 'ask_ai_safety_events', 'ask_ai_suggested_actions',
    'ask_ai_threads', 'ask_ai_turns', 'consultant_engagements', 'management_completion_claims',
    'management_cycle_leases', 'management_cycle_runs', 'management_execution_attempts',
    'management_execution_enablement', 'management_item_assignments', 'management_item_decisions',
    'management_item_evidence', 'management_item_feedback', 'management_item_recommendations',
    'management_item_transitions', 'management_items', 'management_kernel_enablement',
    'management_task_idempotency', 'management_verification_attempts',
    'management_verification_schedule', 'membership_languages', 'observation_source_cursors',
    'observation_sources', 'skill_record_events', 'skill_records'
  ];
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise notice '0144: no authenticated role — grant tightening skipped';
    return;
  end if;
  foreach t in array promoted loop
    if to_regclass('public.' || t) is null then continue; end if;
    if exists (
      select 1 from pg_policy p
       where p.polrelid = ('public.' || t)::regclass
         and p.polcmd in ('a', 'w', 'd', '*')
         and (p.polroles = '{0}'::oid[]                       -- PUBLIC: applies to every role
           or 'authenticated'::regrole::oid = any(p.polroles))
    ) then
      continue;  -- a write policy exists; the grant is part of a working path
    end if;
    execute format('revoke insert, update, delete on table public.%I from authenticated', t);
    v_closed := v_closed + 1;
  end loop;
  raise notice '0144: write grants withdrawn from authenticated on % policy-less table(s)', v_closed;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 2. Self-verification — fail closed
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- A migration that revokes and then trusts itself has verified nothing. These re-read the
-- catalogue AFTER the work and abort the whole migration if any of it did not take, naming what
-- is still open. That is the difference between "we ran a revoke" and "nothing is reachable".
do $$
declare
  v_bad text;
begin
  -- No kernel function is reachable by anon. None. There is no anonymous surface here.
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'r1\_%'
     and has_function_privilege('anon', p.oid, 'execute');
  if v_bad is not null then
    raise exception '0144 ABORT: anon can still execute: %', v_bad;
  end if;

  -- No trigger function is reachable by any API role.
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'r1\_%'
     and pg_get_function_result(p.oid) = 'trigger'
     and (has_function_privilege('authenticated', p.oid, 'execute')
       or has_function_privilege('service_role', p.oid, 'execute'));
  if v_bad is not null then
    raise exception '0144 ABORT: a trigger function is still callable: %', v_bad;
  end if;

  -- The purge is service-only, and it is still service-callable — a revoke that took away the
  -- scheduled sweep's own access would be a different kind of failure, and a silent one.
  select string_agg(p.oid::regprocedure::text, ', ')
    into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'r1_draft_ask_ai_purge_expired'
     and (has_function_privilege('authenticated', p.oid, 'execute')
      or not has_function_privilege('service_role', p.oid, 'execute'));
  if v_bad is not null then
    raise exception '0144 ABORT: the Ask-AI purge is not service-only-and-reachable: %', v_bad;
  end if;

  -- The three caller-evaluated helpers MUST still be executable by `authenticated`, or every RLS
  -- policy and default expression that names them starts failing for real users. Asserting this
  -- is how a "hardening" migration proves it did not break the product.
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('r1_draft_may_see_item', 'r1_draft_may_see_management_item', 'r1_draft_ask_ai_expiry')
     and not has_function_privilege('authenticated', p.oid, 'execute');
  if v_bad is not null then
    raise exception '0144 ABORT: a policy-evaluated helper lost authenticated EXECUTE: %', v_bad;
  end if;

  -- The idempotency table is closed, and closed the whole way: RLS on, FORCED, and no DML for
  -- anon or authenticated. Checking only `relrowsecurity` would pass a table whose owner still
  -- bypasses every policy.
  if to_regclass('public.management_task_idempotency') is not null then
    if not exists (select 1 from pg_class where oid = 'public.management_task_idempotency'::regclass
                    and relrowsecurity and relforcerowsecurity) then
      raise exception '0144 ABORT: management_task_idempotency does not have RLS enabled AND forced';
    end if;
    select string_agg(distinct grantee || ':' || privilege_type, ', ')
      into v_bad
      from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'management_task_idempotency'
       and grantee in ('anon', 'authenticated', 'PUBLIC');
    if v_bad is not null then
      raise exception '0144 ABORT: management_task_idempotency is still granted to a user role: %', v_bad;
    end if;
  end if;

  raise notice '0144: verified — no anon reach, no callable trigger function, purge service-only, policy helpers intact, idempotency table closed';
end $$;
