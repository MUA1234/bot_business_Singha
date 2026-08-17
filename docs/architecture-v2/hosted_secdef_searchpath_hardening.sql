-- hosted_secdef_searchpath_hardening.sql
-- OWNER APPROVAL REQUIRED BEFORE EXECUTION. (This header states a REQUIREMENT; it is NOT a record that
-- approval has been granted.) Run ONLY:
--   * after the owner has explicitly approved running it, AND
--   * after `hosted_secdef_searchpath_check.sql` shows unsafe application SECURITY DEFINER / trigger
--     functions on the hosted DB (the 0038–0041 functions were applied with `SET search_path = public`).
-- It is the break-glass equivalent of migration 0067's systemic hardening, scoped to whatever the hosted
-- database actually carries. Applying migration 0067 afterwards is a no-op on these functions.
--
-- SAFETY. Self-verifying and fail-closed:
--   * targets EXACT `regprocedure` identities discovered from the catalog (no signature hardcoded, so it
--     is correct whether the hosted DB is at 0041 or fully migrated);
--   * ABORTS if the targeted application functions do not all share ONE owner, or that owner is an API
--     role (anon/authenticated/service_role) — an unexpected owner means the hosted state differs from
--     expectation and must be reviewed by the owner;
--   * alters ONLY `search_path` (never body, owner, args, return type, SECURITY DEFINER/INVOKER, or ACL);
--   * after the ALTERs, RE-VERIFIES in the same transaction that EVERY targeted signature now pins
--     `pg_temp` LAST with no `$user`, and RAISES (rolling back the whole transaction) if any residual
--     unsafe signature remains — so a partial hardening can never be committed from a SQL-editor batch.
--
-- This development process has NOT run this against the hosted database (owner authorisation not given).
-- It does NOT touch privileges; pair it with `hosted_secdef_privilege_check.sql` /
-- `hosted_secdef_emergency_revoke.sql` for the EXECUTE-privilege remediation.

begin;

do $$
declare
  r record; n int := 0; residual int; owner_oid oid; owners oid[]; sp text;
begin
  -- (0) Owner-consistency guard.
  select array_agg(distinct p.proowner) into owners
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace nsp on nsp.oid = p.pronamespace
  where nsp.nspname = 'public'
    and (p.prosecdef or p.prorettype = 'pg_catalog.trigger'::regtype)
    and not exists (select 1 from pg_catalog.pg_depend d
                     where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');
  if owners is null then
    raise exception 'hosted hardening ABORTED: no application SECURITY DEFINER / trigger functions found in public';
  end if;
  if array_length(owners, 1) <> 1 then
    raise exception 'hosted hardening ABORTED: targeted functions do not share ONE owner (owners: %) — hosted state differs from expectation; owner review required', owners;
  end if;
  owner_oid := owners[1];
  if owner_oid::regrole::text in ('anon','authenticated','service_role') then
    raise exception 'hosted hardening ABORTED: the function owner is an API role (%) — refuse', owner_oid::regrole::text;
  end if;

  -- (1) Harden every targeted function by its EXACT regprocedure identity; alter ONLY search_path.
  for r in
    select p.oid::regprocedure as sig
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace nsp on nsp.oid = p.pronamespace
    where nsp.nspname = 'public'
      and (p.prosecdef or p.prorettype = 'pg_catalog.trigger'::regtype)
      and p.proowner = owner_oid
      and not exists (select 1 from pg_catalog.pg_depend d
                       where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set search_path = pg_catalog, extensions, public, pg_temp', r.sig);
    n := n + 1;
  end loop;

  -- (2) Self-verify: no residual unsafe signature (pg_temp must be LAST; no $user; path must be set).
  residual := 0;
  for r in
    select p.oid,
           (select c from unnest(coalesce(p.proconfig,'{}'::text[])) c where c like 'search_path=%') as search_path
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace nsp on nsp.oid = p.pronamespace
    where nsp.nspname = 'public'
      and (p.prosecdef or p.prorettype = 'pg_catalog.trigger'::regtype)
      and p.proowner = owner_oid
      and not exists (select 1 from pg_catalog.pg_depend d
                       where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    sp := r.search_path;
    if sp is null
       or position('$user' in sp) > 0
       or btrim(split_part(sp, ',', array_length(string_to_array(sp, ','), 1))) <> 'pg_temp' then
      residual := residual + 1;
    end if;
  end loop;
  if residual > 0 then
    raise exception 'hosted hardening ABORTED: % function(s) still have an unsafe search_path after the ALTERs — the whole transaction is rolled back', residual
      using hint = 'investigate before retrying; nothing was committed';
  end if;

  raise notice 'hosted hardening OK: % application SECURITY DEFINER / trigger function(s) pinned to (pg_catalog, extensions, public, pg_temp); zero residual unsafe', n;
end $$;

-- Reached only when the self-verify above found zero residual unsafe signatures.
commit;
