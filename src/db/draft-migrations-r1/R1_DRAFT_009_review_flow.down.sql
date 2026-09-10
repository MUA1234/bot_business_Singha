-- R1 DRAFT ROLLBACK - NOT FOR HOSTED APPLICATION.
drop trigger if exists management_item_decisions_no_self_approval on management_item_decisions;
drop function if exists r1_draft_no_self_approval();

alter table if exists public.management_items
  drop constraint if exists management_items_unattended_ck,
  drop constraint if exists management_items_evidence_quality_ck,
  drop constraint if exists management_items_evidence_request_ck,
  drop constraint if exists management_items_snooze_ck;

drop index if exists management_items_snoozed_idx;

alter table if exists public.management_items
  drop column if exists may_run_unattended,
  drop column if exists evidence_quality,
  drop column if exists proposed_action_id,
  drop column if exists evidence_request_reason,
  drop column if exists evidence_requested_at,
  drop column if exists snooze_reason,
  drop column if exists snoozed_until;

alter table if exists public.management_item_decisions
  drop constraint if exists management_item_decisions_decision_check;
alter table if exists public.management_item_decisions
  add constraint management_item_decisions_decision_check
  check (decision in ('approve', 'reject', 'edit', 'delegate'));

-- Restore the unit-004 decision guard (no reason requirement beyond reject/delegate/edit).
create or replace function r1_draft_decision_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_item_company uuid;
begin
  select company_id into v_item_company from public.management_items where id = new.item_id;
  if v_item_company is null then
    raise exception 'decision references a non-existent management item'
      using errcode = 'foreign_key_violation';
  end if;
  if v_item_company is distinct from new.company_id then
    raise exception 'cross-company decision refused: item company %, decision company %',
      v_item_company, new.company_id using errcode = 'insufficient_privilege';
  end if;
  if new.decision = 'reject' and (new.reason is null or btrim(new.reason) = '') then
    raise exception 'a reject decision requires a reason' using errcode = 'check_violation';
  end if;
  if new.decision = 'delegate' and new.delegated_to is null then
    raise exception 'a delegate decision requires delegated_to' using errcode = 'check_violation';
  end if;
  if new.decision = 'edit' and new.edited_action is null then
    raise exception 'an edit decision requires edited_action' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Restore the CASCADE child foreign keys created by units 002-004/006.
do $$
declare
  t text;
begin
  foreach t in array array['management_item_evidence', 'management_item_transitions',
                           'management_item_decisions', 'management_item_feedback'] loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_item_fk');
    execute format(
      'alter table public.%I add constraint %I foreign key (item_id)
         references public.management_items(id) on delete cascade', t, t || '_item_id_fkey');
  end loop;
end
$$;
