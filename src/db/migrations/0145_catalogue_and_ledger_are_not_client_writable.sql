-- 0145_catalogue_and_ledger_are_not_client_writable.sql
--
-- CRITICAL. Any signed-in user could grant themselves any permission, and forge a migration
-- ledger row, over the public data API.
--
-- ── What was demonstrated ───────────────────────────────────────────────────────────────────
--
-- Against the hard-scenario stack — real GoTrue, real PostgREST, real RLS — using a genuine
-- access token for `fixture.staff`, the LOWEST-privilege fixture user:
--
--     POST /rest/v1/role_permissions
--     {"role_key":"staff_submitter","permission_key":"admin.organisation.manage"}
--     → HTTP 201
--
-- After that one request, `actor_has_capability(user, company, 'admin.organisation.manage')`
-- returned TRUE for every staff member — in BOTH fixture companies. The capability engine reads
-- `role_permissions`, so writing that table IS granting capability. There is no separate check to
-- fail: `actor_has_capability` joins `membership_roles` to `role_permissions` and asks whether a
-- row exists. The attacker supplied the row.
--
-- The same token also did this:
--
--     POST /rest/v1/schema_migrations {"version":"9999","filename":"attack_never_ran.sql"}
--     → HTTP 201
--
-- `migrate.mjs` keys the ledger on the four-digit prefix and SKIPS A RECORDED VERSION SILENTLY —
-- defect class PR-F-001, the reason the collision gate exists. A client that can insert into the
-- ledger can make any future migration never run, with no error anywhere. It is the same attack
-- the migration campaign simulates as attack 7 by inserting the row itself; nobody had asked
-- whether a browser could do it.
--
-- ── Why it was open ─────────────────────────────────────────────────────────────────────────
--
-- Four tables — `roles`, `permissions`, `role_permissions`, `schema_migrations` — have RLS
-- DISABLED and hold `INSERT, UPDATE, DELETE` for `authenticated`, purely from Supabase's default
-- privileges. Nobody granted that; nobody revoked it either, and for these four tables there is no
-- policy layer behind the grant to catch it.
--
-- It survived every existing gate because each gate looks somewhere this is not:
--
--   * `rls-coverage` and `rls-matrix-coverage` enumerate tables WITH a `company_id`. These four are
--     global reference tables and have none, so they are outside the population.
--   * `f004-bounded-text` and the write-policy matrix select tables that HAVE a write policy. A
--     table with no policy at all is not in their subquery — RLS-off plus no policy reads to those
--     gates as "not user-writable", which is exactly backwards.
--   * The SECURITY DEFINER allowlists govern FUNCTIONS. This needs no function.
--
-- The blind spot is precise and worth naming: **every gate assumed a table was protected by RLS,
-- so none of them asked which tables have no RLS at all.** `tests/integration/catalogue-and-ledger-
-- boundary.test.ts` now asks exactly that question, of every table in `public`.
--
-- ── The fix ─────────────────────────────────────────────────────────────────────────────────
--
-- These tables are read by the application and written only by migrations, which run as the table
-- OWNER. So `authenticated` and `anon` lose INSERT, UPDATE and DELETE, and keep SELECT where the
-- product reads them.
--
--   `roles`, `permissions`, `role_permissions` — SELECT stays. `src/lib/access.ts` and
--   `src/lib/auth.ts` read them through the caller's client, and with `RLS_READS=on` that read
--   happens in the caller's role. They also get RLS with a read-all policy: the table owner is
--   exempt (no FORCE), so migrations still seed them, but a future stray grant cannot silently
--   reopen writes because the policy layer would refuse them too. Two locks, not one.
--
--   `schema_migrations` — every privilege goes, SELECT included. No application path reads the
--   ledger; the runner connects as owner. RLS is deliberately NOT enabled on it: if a deployment's
--   migration runner ever connects as a non-owner, a table with RLS on and no policy would refuse
--   the runner itself and break migrations everywhere. Removing the grant closes the demonstrated
--   attack completely and cannot break a runner that is the owner or a superuser.
--
-- Idempotent, forward-only, no data change. No rollback script: reversing it restores a
-- privilege-escalation path.

do $$
declare
  t text;
  v_role_exists boolean;
begin
  -- ── 1. The capability catalogue ───────────────────────────────────────────────────────────
  foreach t in array array['roles', 'permissions', 'role_permissions'] loop
    if to_regclass('public.' || t) is null then continue; end if;

    execute format('revoke insert, update, delete, truncate on table public.%I from public', t);
    for v_role_exists in select true from pg_roles where rolname in ('anon', 'authenticated') loop null; end loop;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete, truncate on table public.%I from authenticated', t);
      execute format('grant select on table public.%I to authenticated', t);
    end if;

    -- The second lock. Owner-exempt, so the 19 migrations that seed the catalogue are unaffected.
    execute format('alter table public.%I enable row level security', t);
    begin
      execute format(
        'create policy %I on public.%I for select to authenticated using (true)',
        t || '_read_all', t);
    exception when duplicate_object then null;
    end;
  end loop;

  -- ── 2. The ledger ─────────────────────────────────────────────────────────────────────────
  if to_regclass('public.schema_migrations') is not null then
    execute 'revoke all on table public.schema_migrations from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute 'revoke all on table public.schema_migrations from anon';
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'revoke all on table public.schema_migrations from authenticated';
    end if;
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Self-verification — fail closed, and check the ATTACK, not just the grant
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_bad text;
begin
  select string_agg(distinct g.table_name || ':' || g.grantee || ':' || g.privilege_type, ', ')
    into v_bad
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name in ('roles', 'permissions', 'role_permissions', 'schema_migrations')
     and g.grantee in ('anon', 'authenticated', 'PUBLIC')
     and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if v_bad is not null then
    raise exception '0145 ABORT: a client role can still write the catalogue or the ledger: %', v_bad;
  end if;

  -- The ledger is not even readable by a client.
  if exists (select 1 from information_schema.role_table_grants
              where table_schema = 'public' and table_name = 'schema_migrations'
                and grantee in ('anon', 'authenticated', 'PUBLIC')) then
    raise exception '0145 ABORT: schema_migrations is still reachable by a client role';
  end if;

  -- And the product can still READ the catalogue, or every capability check fails closed and
  -- nobody can do anything. A hardening migration that silently breaks authorisation would be
  -- worse than the hole it closed.
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    select string_agg(t, ', ') into v_bad from unnest(array['roles', 'permissions', 'role_permissions']) t
     where to_regclass('public.' || t) is not null
       and not has_table_privilege('authenticated', ('public.' || t)::regclass, 'SELECT');
    if v_bad is not null then
      raise exception '0145 ABORT: authenticated lost SELECT on the capability catalogue: %', v_bad;
    end if;
  end if;

  raise notice '0145: catalogue and ledger are not client-writable; catalogue still readable';
end $$;
