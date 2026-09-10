-- R1 DRAFT ROLLBACK - NOT FOR HOSTED APPLICATION.
-- Narrows the managed-domain vocabulary back to the five R1 domains. Rolling this back with
-- R2A items already present would violate the narrowed CHECK, so the constraints are only
-- re-added when no row outside the five domains exists; otherwise the wide constraint is
-- retained and a notice explains why. Failing loudly here would strand the rollback.
alter table public.management_items
  drop constraint if exists management_items_department_check;
alter table public.observation_sources
  drop constraint if exists observation_sources_department_check;

do $$
declare
  v_wide int;
begin
  select count(*) into v_wide from public.management_items
   where department not in ('finance','workforce','operations','crm','system');

  if v_wide > 0 then
    raise notice 'R1_DRAFT_013 down: % item(s) exist in R2A domains - keeping the twelve-domain CHECK', v_wide;
    alter table public.management_items
      add constraint management_items_department_check check (
        department in ('finance','workforce','operations','crm','system',
                       'governance','objectives','marketing','procurement','assets','legal','providers'));
    alter table public.observation_sources
      add constraint observation_sources_department_check check (
        department in ('finance','workforce','operations','crm','system',
                       'governance','objectives','marketing','procurement','assets','legal','providers'));
  else
    alter table public.management_items
      add constraint management_items_department_check check (
        department in ('finance','workforce','operations','crm','system'));
    alter table public.observation_sources
      add constraint observation_sources_department_check check (
        department in ('finance','workforce','operations','crm','system'));
  end if;
end
$$;
