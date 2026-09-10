-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_008 — accountable-owner integrity (security baseline B).
--
-- `accountable_owner_id` referenced nothing. This binds it to the existing membership
-- identity using the repository's composite (id, company_id) pattern — the same mechanism
-- migrations 0009/0024/0060 use — so an owner from ANOTHER COMPANY is not merely rejected
-- by application code, it is unrepresentable.

do $$
begin
  if to_regclass('public.memberships') is null then
    raise notice 'R1_DRAFT_008: memberships absent — accountable-owner integrity SKIPPED (standalone draft database)';
    return;
  end if;

  -- 1. The parent needs a unique (id, company_id) to be referenced compositely.
  --    Additive and reversible; the down migration removes it.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.memberships'::regclass and conname = 'memberships_id_company_uq'
  ) then
    alter table public.memberships add constraint memberships_id_company_uq unique (id, company_id);
  end if;

  -- 2. The composite foreign key. An accountable owner must be a membership OF THE SAME
  --    COMPANY — a cross-company owner cannot be stored at all.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.management_items'::regclass
       and conname = 'management_items_owner_company_fk'
  ) then
    alter table public.management_items
      add constraint management_items_owner_company_fk
      foreign key (accountable_owner_id, company_id)
      references public.memberships (id, company_id)
      on delete restrict;
  end if;
end
$$;

-- 3. accountable_owner_id may be NULL only where having no owner is legitimate.
--    Working states MUST name an accountable person. This is what stops an item drifting
--    through the loop with nobody responsible for it.
alter table public.management_items
  drop constraint if exists management_items_owner_required_ck;
alter table public.management_items
  add constraint management_items_owner_required_ck check (
    accountable_owner_id is not null
    or state in (
      -- pre-assignment: nobody is accountable yet, by definition
      'observed', 'understood', 'prioritised', 'recommended', 'awaiting_approval', 'approved',
      -- R1-D-3: explicitly unrouted, with a reason recorded
      'needs_routing',
      -- terminal without ever being worked
      'rejected', 'dismissed', 'expired',
      -- re-opened work returns to routing before it is re-owned
      'reopened'
    )
  );

-- 4. `needs_routing` must be honest: it requires the reason and the department, so an item
--    can never sit unrouted without saying why. R1-D-3 forbids a silent administrator
--    fallback, and this is what makes the absence of one visible instead of invisible.
alter table public.management_items
  drop constraint if exists management_items_routing_reason_ck;
alter table public.management_items
  add constraint management_items_routing_reason_ck check (
    state <> 'needs_routing'
    or (routing_reason is not null and btrim(routing_reason) <> ''
        and routing_department is not null)
  );

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 5. May this membership hold accountability?
--
-- Evaluates the ASSIGNEE, not the caller: it reads membership status and role grants
-- directly and never consults auth.uid(). Active membership in the item's company, holding
-- a task capability through the EXISTING role_permissions mapping — no parallel authority
-- table, no new capability key.
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- `language plpgsql` with dynamic SQL, deliberately: a `language sql` body is parsed and
-- validated at CREATE time, so it could not be created on a standalone draft database where
-- `memberships` does not exist. The identity tables are resolved when the function RUNS.
--
-- FAILS CLOSED: if the identity schema is absent, no membership can be proven authorised, so
-- the answer is false. It never assumes authorisation it cannot verify.
create or replace function r1_draft_membership_can_own(p_company uuid, p_membership uuid)
returns boolean
language plpgsql stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ok boolean;
begin
  if to_regclass('public.memberships') is null
     or to_regclass('public.membership_roles') is null
     or to_regclass('public.role_permissions') is null then
    return false;
  end if;

  execute $q$
    select exists (
      select 1
        from public.memberships m
        join public.membership_roles mr on mr.membership_id = m.id
        join public.role_permissions rp on rp.role_key = mr.role_key
       where m.id = $2
         and m.company_id = $1
         and m.status = 'active'
         and rp.permission_key in ('operations.task.work', 'operations.task.manage')
    )
  $q$ into v_ok using p_company, p_membership;

  return coalesce(v_ok, false);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 6. Assignment requires a valid, active, authorised membership.
--
-- Enforced inside the transition boundary rather than in application code, so a direct
-- writer cannot assign work to a suspended, ended, foreign-company or unauthorised person.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function r1_draft_assert_assignable(p_item uuid)
returns void
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v record;
begin
  select company_id, accountable_owner_id into v
    from public.management_items where id = p_item;

  if v.accountable_owner_id is null then
    raise exception 'cannot assign management item % with no accountable owner — route it to needs_routing instead', p_item
      using errcode = 'check_violation';
  end if;

  -- Only relevant where the base identity schema exists.
  if to_regclass('public.memberships') is not null
     and not r1_draft_membership_can_own(v.company_id, v.accountable_owner_id) then
    raise exception 'accountable owner % is not an active authorised membership of company %', v.accountable_owner_id, v.company_id
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 7. Revocation produces TRUTHFUL handling, never a silent reassignment.
--
-- When an item's owner stops being an active authorised membership, the item returns to
-- `needs_routing` with a reason naming the revocation. It is NOT reassigned to an
-- administrator, and it is NOT left claiming an owner who no longer exists.
-- Returns the number of items re-routed.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function r1_draft_revalidate_owners(p_company uuid)
returns integer
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_item record;
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

      update public.management_items
         set state = 'needs_routing',
             accountable_owner_id = null,
             routing_department = coalesce(routing_department, v_item.department),
             routing_reason = 'previous accountable owner lost active authorised membership',
             routing_requested_at = now(),
             routing_notified_at = null   -- a genuinely new routing need may notify once
       where id = v_item.id;

      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 8. Wire the assignment check into the transition boundary.
--    Same signature and semantics as unit 002; the only addition is the assignability
--    assertion on entry to `assigned`.
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
  v_item    record;
  v_legal   boolean;
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

  -- `needs_routing` joins dismissed/rejected as reason-requiring. R1-D-3 forbids unrouted
  -- work sitting silently, so the reason is demanded at the boundary rather than hoped for
  -- in a follow-up UPDATE that a caller could simply omit.
  if p_to in ('dismissed', 'rejected', 'needs_routing')
     and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'transition to % requires a reason', p_to using errcode = 'check_violation';
  end if;

  -- NEW in unit 008: entering `assigned` requires a valid active authorised owner.
  if p_to = 'assigned' then
    perform r1_draft_assert_assignable(p_item);
  end if;

  insert into public.management_item_transitions
    (company_id, item_id, from_state, to_state, actor_id, actor_type, reason, evidence)
  values
    (v_item.company_id, p_item, p_from, p_to, p_actor, p_actor_type, p_reason, coalesce(p_evidence, '[]'::jsonb));

  update public.management_items
     set state = p_to,
         -- Routing provenance is written BY the transition, so `needs_routing` can never
         -- exist without saying why or which department owns the queue (R1-D-3).
         routing_reason = case when p_to = 'needs_routing' then p_reason else routing_reason end,
         routing_department = case when p_to = 'needs_routing'
                                   then coalesce(routing_department, department)
                                   else routing_department end,
         routing_requested_at = case when p_to = 'needs_routing' then now() else routing_requested_at end,
         -- Leaving an assigned/working state releases the accountable owner rather than
         -- leaving a stale name attached to work nobody is doing.
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

  return jsonb_build_object('ok', true, 'result', 'transitioned', 'from', p_from, 'to', p_to);
end;
$$;
