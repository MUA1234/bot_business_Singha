-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- Reverse of R1_DRAFT_024: restore draft 023's predicate (owner/manager/staff only), restore the
-- raw observation_sources read, and drop the identity helpers.

do $$
begin
  if to_regprocedure('public.has_company_access(uuid)') is null then
    raise notice 'R1_DRAFT_024 down: base identity functions absent — SKIPPED';
    return;
  end if;
  for i in 1..1 loop
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'grant select on public.observation_sources to authenticated';
    end if;
    execute 'drop policy if exists observation_sources_sel on public.observation_sources';
    execute 'create policy observation_sources_sel on public.observation_sources
               for select to authenticated
               using (company_id is null or public.has_company_access(company_id))';
  end loop;
end $$;

drop function if exists public.r1_draft_source_health(uuid);
drop function if exists public.r1_draft_is_active_advisor(uuid, text);

-- The predicate reverts to draft 023's definition: owner, manager and own-work without a
-- capability requirement, and no advisor or delegate class.
create or replace function public.r1_draft_may_see_management_item(
  p_company uuid, p_department text, p_owner uuid
)
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_actor uuid := auth.uid();
  v_spec  text;
  v_dept  text;
begin
  if v_actor is null or p_company is null then return false; end if;
  if not exists (select 1 from public.memberships m
                  where m.user_id = v_actor and m.company_id = p_company and m.status = 'active')
  then return false; end if;
  v_spec := public.r1_draft_specialist_capability(p_department);
  if p_department in ('legal', 'workforce') then
    return coalesce(public.has_capability(p_company, v_spec), false);
  end if;
  if public.has_capability(p_company, 'management.queue.view_company') then return true; end if;
  v_dept := public.r1_draft_department_capability(p_department);
  if v_dept is not null and public.has_capability(p_company, v_dept) then return true; end if;
  if p_owner is not null and exists (
       select 1 from public.memberships m
        where m.id = p_owner and m.user_id = v_actor
          and m.company_id = p_company and m.status = 'active')
  then return true; end if;
  return false;
end;
$fn$;
