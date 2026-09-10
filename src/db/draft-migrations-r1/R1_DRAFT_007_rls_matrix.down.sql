-- R1 DRAFT ROLLBACK - NOT FOR HOSTED APPLICATION.
-- Drops the full policy matrix and restores the simple company-scoped read policies that
-- units 001-006 created, so rolling back 007 alone leaves the tables protected rather than
-- open.
drop trigger if exists management_item_feedback_company on management_item_feedback;
drop trigger if exists management_item_transitions_company on management_item_transitions;
drop function if exists r1_draft_child_company_guard();

do $$
declare
  t text;
  r1_tables text[] := array[
    'management_items', 'management_item_transitions', 'management_item_evidence',
    'management_item_decisions', 'observation_sources', 'management_item_feedback'
  ];
begin
  foreach t in array r1_tables loop
    execute format('drop policy if exists %I on public.%I', t || '_sel', t);
    execute format('drop policy if exists %I on public.%I', t || '_ins', t);
    execute format('drop policy if exists %I on public.%I', t || '_upd', t);
  end loop;

  if to_regprocedure('public.has_company_access(uuid)') is not null then
    foreach t in array r1_tables loop
      if t = 'observation_sources' then
        execute format('create policy %I on public.%I for select
                          using (company_id is null or public.has_company_access(company_id))', t || '_read', t);
      else
        execute format('create policy %I on public.%I for select
                          using (public.has_company_access(company_id))', t || '_read', t);
      end if;
    end loop;
  end if;
end
$$;
