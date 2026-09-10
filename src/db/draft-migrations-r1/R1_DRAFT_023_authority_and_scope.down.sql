-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- Reverse of R1_DRAFT_023. Restores draft 007's company-wide SELECT policies, which is what
-- "reverse" means here even though those policies are the defect this unit fixes.

do $$
begin
  if to_regprocedure('public.has_company_access(uuid)') is null then
    raise notice 'R1_DRAFT_023 down: base identity functions absent — policies SKIPPED';
    return;
  end if;

  for i in 1..1 loop
    execute 'drop policy if exists management_items_sel on public.management_items';
    execute 'create policy management_items_sel on public.management_items
               for select to authenticated using (public.has_company_access(company_id))';

    execute 'drop policy if exists management_item_evidence_sel on public.management_item_evidence';
    execute 'create policy management_item_evidence_sel on public.management_item_evidence
               for select to authenticated using (public.has_company_access(company_id))';

    execute 'drop policy if exists management_item_transitions_sel on public.management_item_transitions';
    execute 'create policy management_item_transitions_sel on public.management_item_transitions
               for select to authenticated using (public.has_company_access(company_id))';

    execute 'drop policy if exists management_item_decisions_sel on public.management_item_decisions';
    execute 'create policy management_item_decisions_sel on public.management_item_decisions
               for select to authenticated using (public.has_company_access(company_id))';

    execute 'drop policy if exists management_item_feedback_sel on public.management_item_feedback';
    execute 'create policy management_item_feedback_sel on public.management_item_feedback
               for select to authenticated using (public.has_company_access(company_id))';
  end loop;
end $$;

drop function if exists public.r1_draft_may_see_item(uuid);
drop function if exists public.r1_draft_may_see_management_item(uuid, text, uuid);
drop function if exists public.r1_draft_department_capability(text);
drop function if exists public.r1_draft_specialist_capability(text);

delete from public.role_permissions
 where permission_key in ('management.decision.approve_owner', 'management.queue.view_company');
delete from public.permissions
 where key in ('management.decision.approve_owner', 'management.queue.view_company');
