-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- Reverse of R1_DRAFT_022.

drop function if exists public.r1_draft_record_management_decision(uuid, text, text, text, text, text, text, text);
drop function if exists public.r1_draft_evidence_digest(uuid, uuid);

drop index if exists management_item_decisions_idem_uq;

alter table public.management_item_decisions
  drop column if exists idempotency_key,
  drop column if exists bound_state,
  drop column if exists bound_action_id,
  drop column if exists bound_evidence_digest,
  drop column if exists bound_parameter_digest;

-- Restore the direct-insert policy draft 007 created, so the down migration truly reverses.
do $$
begin
  if to_regprocedure('public.has_capability(uuid, text)') is not null then
    begin
      execute 'create policy management_item_decisions_ins on public.management_item_decisions
                 for insert to authenticated
                 with check (public.has_capability(company_id, ''operations.task.manage''))';
    exception when duplicate_object then null; end;
  end if;
end $$;
