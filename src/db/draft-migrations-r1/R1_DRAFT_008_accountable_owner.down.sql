-- R1 DRAFT ROLLBACK - NOT FOR HOSTED APPLICATION.
-- Restores the unit-002 transition function (no assignability assertion) and removes the
-- accountable-owner integrity added by unit 008, including the constraint added to the
-- BASE `memberships` table.
drop function if exists r1_draft_revalidate_owners(uuid);
drop function if exists r1_draft_assert_assignable(uuid);
drop function if exists r1_draft_membership_can_own(uuid, uuid);

alter table if exists public.management_items
  drop constraint if exists management_items_routing_reason_ck;
alter table if exists public.management_items
  drop constraint if exists management_items_owner_required_ck;
alter table if exists public.management_items
  drop constraint if exists management_items_owner_company_fk;

-- `memberships_id_company_uq` is dropped ONLY IF THIS UNIT CREATED IT.
--
-- The up migration adds it conditionally — `if not exists (…) then alter table … add constraint`
-- — because the RELEASED schema may already have it. Released migration 0024 builds exactly this
-- name dynamically (`parent || '_id_company_uq'`) and then hangs EIGHT composite foreign keys off
-- it: membership_roles, authority_rules, membership_assignments, employee_profiles,
-- capacity_snapshots, task_assignments and both delegation columns.
--
-- The down used to drop it unconditionally, so on any database carrying the released migrations
-- it tried to remove a RELEASED constraint that released objects depend on, and PostgreSQL
-- refused: "cannot drop constraint memberships_id_company_uq on table memberships because other
-- objects depend on it". The rollback then failed and left the draft chain half-removed. A down
-- migration that undoes more than its up created is not a rollback; it is a second migration
-- wearing the wrong name.
--
-- The test is dependency-based rather than a stored flag, and that is deliberate: by the time
-- this runs, the reverse rollback has already dropped units 017 and 016, whose tables carried the
-- only draft-side dependants. So anything STILL depending on this constraint belongs to the
-- released schema — which is precisely the case in which the up did not create it.
--
-- NESTED, not a single AND: SQL does not guarantee short-circuit evaluation, and
-- 'public.memberships'::regclass THROWS when the relation is absent. Combining both checks
-- in one condition broke rollback on a standalone draft database.
do $$
declare
  v_dependants int;
begin
  if to_regclass('public.memberships') is not null then
    if exists (select 1 from pg_constraint
                where conrelid = to_regclass('public.memberships')
                  and conname = 'memberships_id_company_uq') then

      -- Foreign keys on OTHER tables that reference memberships (id, company_id).
      select count(*) into v_dependants
        from pg_constraint con
       where con.confrelid = to_regclass('public.memberships')
         and con.contype = 'f'
         and array_length(con.confkey, 1) > 1;

      if v_dependants = 0 then
        alter table public.memberships drop constraint memberships_id_company_uq;
      else
        raise notice
          'R1_DRAFT_008 down: leaving memberships_id_company_uq in place — % composite foreign key(s) still depend on it, so this unit did not create it',
          v_dependants;
      end if;
    end if;
  end if;
end
$$;

-- Restore the unit-002 transition function verbatim (without the assignability check), so
-- rolling back 008 alone leaves a coherent lifecycle rather than a dangling reference.
create or replace function r1_draft_transition_item(
  p_item uuid, p_from text, p_to text, p_actor uuid, p_actor_type text,
  p_reason text default null, p_evidence jsonb default '[]'::jsonb
) returns jsonb
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_item record;
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
    else false end;
  if not v_legal then
    raise exception 'illegal management-item transition % -> %', p_from, p_to using errcode = 'check_violation';
  end if;
  if p_to in ('dismissed', 'rejected') and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'transition to % requires a reason', p_to using errcode = 'check_violation';
  end if;
  insert into public.management_item_transitions
    (company_id, item_id, from_state, to_state, actor_id, actor_type, reason, evidence)
  values (v_item.company_id, p_item, p_from, p_to, p_actor, p_actor_type, p_reason, coalesce(p_evidence, '[]'::jsonb));
  update public.management_items
     set state = p_to,
         outcome = case when p_to = 'verified' then 'resolved' when p_to = 'rejected' then 'rejected'
                        when p_to = 'dismissed' then 'dismissed' when p_to = 'expired' then 'expired'
                        else outcome end,
         outcome_reason = case when p_to in ('verified','rejected','dismissed','expired') then p_reason else outcome_reason end,
         outcome_at = case when p_to in ('verified','rejected','dismissed','expired') then now() else outcome_at end
   where id = p_item;
  return jsonb_build_object('ok', true, 'result', 'transitioned', 'from', p_from, 'to', p_to);
end;
$$;
