-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_010 — the lifecycle is RPC-ONLY (defect R1-F-002).
--
-- FOUND BY ADVERSARIAL SELF-REVIEW, reproduced before being fixed. Units 007/009 grant
-- `authenticated` an UPDATE policy on `management_items` gated on `operations.task.manage`,
-- so a manager could write:
--
--     update management_items set state = 'verified', outcome = 'resolved' where id = …;
--
-- and the item went straight from `observed` to `verified`, skipping the transition legality
-- map, the reason requirement, the assignability assertion — and writing ZERO transition
-- rows. The audit trail simply had a hole in it. Confirmed on a live database: the update
-- succeeded, state became `verified`, transition rows written = 0.
--
-- The evidence trigger from unit 003 did not catch it (the item had evidence), and the
-- owner-required constraint only caught it by accident when no owner was set.
--
-- This is the same class migration 0064 already closed for quotation delivery: the
-- privileged transitions are RPC-only, and a direct table UPDATE cannot bypass them. The
-- mechanism here is the same in spirit — a transaction-local token that ONLY
-- `r1_draft_transition_item()` can set, checked by a BEFORE UPDATE trigger.
--
-- Why a token and not a role check: the kernel's legitimate callers are ordinary
-- `authenticated` managers acting through the RPC, so "which role are you" cannot
-- distinguish a legal transition from an illegal one. "Did you come through the function"
-- can. The token names the exact item AND the exact target state, so it cannot be set once
-- and reused for a second, unrelated update in the same transaction.

create or replace function r1_draft_guard_state_change() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_token text;
begin
  if new.state is distinct from old.state then
    v_token := coalesce(current_setting('r1_draft.transition_token', true), '');
    if v_token is distinct from (new.id::text || ':' || new.state) then
      raise exception
        'management item % state may only change through r1_draft_transition_item() (attempted % -> %)',
        new.id, old.state, new.state
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists management_items_guard_state on management_items;
create trigger management_items_guard_state
  before update on management_items
  for each row execute function r1_draft_guard_state_change();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- The transition function, re-issued so it mints the token around its own UPDATE.
-- Signature, semantics and every guard from units 002/008 are unchanged; the only addition
-- is the token, set immediately before the write and CLEARED immediately after so it cannot
-- authorise a second update later in the same transaction.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function r1_draft_transition_item(
  p_item       uuid,
  p_from       text,
  p_to         text,
  p_actor      uuid,
  p_actor_type text,
  p_reason     text default null,
  p_evidence   jsonb default '[]'::jsonb
) returns jsonb
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_item  record;
  v_legal boolean;
begin
  select * into v_item from public.management_items where id = p_item for update;

  if not found then
    return jsonb_build_object('ok', false, 'result', 'not_found');
  end if;

  if v_item.state is distinct from p_from then
    return jsonb_build_object('ok', false, 'result', 'conflict',
                              'expected', p_from, 'actual', v_item.state);
  end if;

  v_legal := case p_from
    when 'observed'          then p_to in ('understood', 'dismissed', 'expired')
    when 'understood'        then p_to in ('prioritised', 'dismissed', 'expired')
    when 'prioritised'       then p_to in ('recommended', 'dismissed', 'expired')
    when 'recommended'       then p_to in ('awaiting_approval', 'needs_routing', 'assigned', 'dismissed', 'expired')
    when 'awaiting_approval' then p_to in ('approved', 'rejected', 'expired')
    when 'approved'          then p_to in ('needs_routing', 'assigned', 'expired')
    when 'needs_routing'     then p_to in ('assigned', 'escalated', 'dismissed', 'expired')
    when 'assigned'          then p_to in ('monitoring', 'escalated', 'dismissed')
    when 'monitoring'        then p_to in ('verifying', 'escalated', 'dismissed')
    when 'escalated'         then p_to in ('monitoring', 'verifying', 'needs_routing', 'dismissed')
    when 'verifying'         then p_to in ('verified', 'reopened')
    when 'reopened'          then p_to in ('prioritised', 'assigned', 'needs_routing', 'dismissed')
    else false
  end;

  if not v_legal then
    raise exception 'illegal management-item transition % -> %', p_from, p_to
      using errcode = 'check_violation';
  end if;

  if p_to in ('dismissed', 'rejected', 'needs_routing')
     and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'transition to % requires a reason', p_to using errcode = 'check_violation';
  end if;

  if p_to = 'assigned' then
    perform r1_draft_assert_assignable(p_item);
  end if;

  insert into public.management_item_transitions
    (company_id, item_id, from_state, to_state, actor_id, actor_type, reason, evidence)
  values
    (v_item.company_id, p_item, p_from, p_to, p_actor, p_actor_type, p_reason, coalesce(p_evidence, '[]'::jsonb));

  perform set_config('r1_draft.transition_token', p_item::text || ':' || p_to, true);

  update public.management_items
     set state = p_to,
         routing_reason = case when p_to = 'needs_routing' then p_reason else routing_reason end,
         routing_department = case when p_to = 'needs_routing'
                                   then coalesce(routing_department, department)
                                   else routing_department end,
         routing_requested_at = case when p_to = 'needs_routing' then now() else routing_requested_at end,
         accountable_owner_id = case when p_to = 'needs_routing' then null else accountable_owner_id end,
         outcome = case
           when p_to = 'verified'  then 'resolved'
           when p_to = 'rejected'  then 'rejected'
           when p_to = 'dismissed' then 'dismissed'
           when p_to = 'expired'   then 'expired'
           else outcome end,
         outcome_reason = case
           when p_to in ('verified', 'rejected', 'dismissed', 'expired') then p_reason
           else outcome_reason end,
         outcome_at = case
           when p_to in ('verified', 'rejected', 'dismissed', 'expired') then now()
           else outcome_at end
   where id = p_item;

  -- Burn the token immediately: it authorises exactly one state write.
  perform set_config('r1_draft.transition_token', '', true);

  return jsonb_build_object('ok', true, 'result', 'transitioned', 'from', p_from, 'to', p_to);
end;
$$;

-- The revalidation sweep also changes state, so it mints and burns the same token.
create or replace function r1_draft_revalidate_owners(p_company uuid)
returns integer
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_item  record;
  v_count integer := 0;
begin
  for v_item in
    select id, state, accountable_owner_id, department
      from public.management_items
     where company_id = p_company
       and accountable_owner_id is not null
       and state in ('assigned', 'monitoring', 'escalated', 'verifying')
     order by id
     for update
  loop
    if not r1_draft_membership_can_own(p_company, v_item.accountable_owner_id) then
      insert into public.management_item_transitions
        (company_id, item_id, from_state, to_state, actor_id, actor_type, reason, evidence)
      values
        (p_company, v_item.id, v_item.state, 'needs_routing', null, 'system',
         'accountable owner membership is no longer active or authorised', '[]'::jsonb);

      perform set_config('r1_draft.transition_token', v_item.id::text || ':needs_routing', true);

      update public.management_items
         set state = 'needs_routing',
             accountable_owner_id = null,
             routing_department = coalesce(routing_department, v_item.department),
             routing_reason = 'previous accountable owner lost active authorised membership',
             routing_requested_at = now(),
             routing_notified_at = null
       where id = v_item.id;

      perform set_config('r1_draft.transition_token', '', true);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;
