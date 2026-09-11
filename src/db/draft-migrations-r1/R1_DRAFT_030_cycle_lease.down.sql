-- R1 DRAFT ROLLBACK - NOT FOR HOSTED APPLICATION.
--
-- Removes the cycle lease (unit 030) and restores the advisory-lock functions unit 011 created,
-- because this unit dropped them. A down migration that removed the replacement without restoring
-- what it replaced would leave the chain with no cycle lock at all — which is worse than either
-- state, and is the kind of asymmetry `R1_DRAFT_008` was corrected for.

drop function if exists public.r1_draft_release_cycle_lease(uuid, text);
drop function if exists public.r1_draft_acquire_cycle_lease(uuid, integer);
drop function if exists public.r1_draft_acquire_cycle_lease(uuid, text, integer);
drop table if exists public.management_cycle_leases;

-- Restored verbatim from R1_DRAFT_011_runtime.up.sql.
create or replace function r1_draft_try_cycle_lock(p_company uuid)
returns boolean
language sql
set search_path = pg_catalog, public, pg_temp
as $$
  select pg_try_advisory_lock(hashtext('r1_management_cycle'), hashtext(p_company::text));
$$;

create or replace function r1_draft_release_cycle_lock(p_company uuid)
returns boolean
language sql
set search_path = pg_catalog, public, pg_temp
as $$
  select pg_advisory_unlock(hashtext('r1_management_cycle'), hashtext(p_company::text));
$$;

do $$
begin
  execute 'revoke all on function public.r1_draft_try_cycle_lock(uuid) from public';
  execute 'revoke all on function public.r1_draft_release_cycle_lock(uuid) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.r1_draft_try_cycle_lock(uuid) from anon';
    execute 'revoke all on function public.r1_draft_release_cycle_lock(uuid) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.r1_draft_try_cycle_lock(uuid) from authenticated';
    execute 'revoke all on function public.r1_draft_release_cycle_lock(uuid) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.r1_draft_try_cycle_lock(uuid) to service_role';
    execute 'grant execute on function public.r1_draft_release_cycle_lock(uuid) to service_role';
  end if;
end
$$;
