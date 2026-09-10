-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_028 — the automatic-authorisation edge, and the human assignment boundary.
--
-- Two things, both required before an item filed by the cycle can reach a person:
--
--   1. R2F-F-018 — an automatically-authorised item had no way to become `approved`.
--   2. R2F-F-014 — nothing in the application performed a binding assignment.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 1. R2F-F-018 — `recommended → approved`, for a genuinely automatic action ONLY
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- The only route to `approved` was `awaiting_approval → approved`, which requires a person. The
-- map's approval-skipping edge went straight to `assigned` — a state that asserts an assignee,
-- which the one automatic action must not have, because it creates the task UNASSIGNED.
--
-- So the action the owner authorised as automatic could not execute at all: `approved` and
-- `assigned` are the only states that admit execution, and neither was reachable without either a
-- human decision or a false claim about assignment.
--
-- The new edge is guarded by the ITEM'S OWN COLUMNS, read under the same lock as the transition.
-- A caller cannot present the authority; the row either says it or it does not.
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
    -- `approved` added (R2F-F-018), gated below.
    when 'recommended'       then p_to in ('awaiting_approval', 'approved', 'needs_routing', 'assigned', 'dismissed', 'expired')
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

  -- D-9, at the database. Skipping approval requires the item's OWN row to say all three things:
  -- the exact owner-authorised action, `automatic` authority, and the unattended flag the
  -- recommender only sets when six independent facts agree. A caller asserts none of it.
  if p_from = 'recommended' and p_to in ('approved', 'assigned') then
    if v_item.proposed_action_id is distinct from 'ops.task.create_internal'
       or v_item.required_authority is distinct from 'automatic'
       or coalesce(v_item.may_run_unattended, false) is not true then
      raise exception
        'approval may only be skipped at automatic authority for the one authorised action'
        using errcode = 'insufficient_privilege';
    end if;
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

  -- Reproduced verbatim from draft 010. The first version of this unit wrote only `state` and
  -- silently dropped the routing columns, the outcome and the accountable-owner clear — a
  -- redefinition that keeps the signature and loses the behaviour is the worst kind, because
  -- everything still compiles and calls it.
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

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 2. Assignment history — who was accountable, when, and why they were chosen
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Reassignment must PRESERVE the previous owner. A column that is overwritten answers "who is
-- accountable now" and destroys "who was accountable then", which is the question that matters
-- after something goes wrong.
create table if not exists management_item_assignments (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  item_id              uuid not null references management_items(id) on delete cascade,
  task_id              uuid not null references tasks(id) on delete cascade,

  -- The membership made accountable, and the user behind it. Both, because the item names a
  -- membership and the task names a user, and the whole point is that they agree.
  membership_id        uuid not null,
  assignee_user_id     uuid not null,

  -- Who assigned. An authenticated human holding operations.task.manage — never a service.
  assigned_by_user_id  uuid not null,

  -- What the system had RECOMMENDED, and whether this differs from it.
  recommended_ref      text,
  is_override          boolean not null default false,
  -- Required when overriding. "The manager knows better" has to be written down to be reviewable.
  override_reason      text,

  -- The eligibility evidence this assignment was made against, so a later reader can ask whether
  -- it was still true.
  eligibility_digest   text,

  previous_membership_id uuid,
  idempotency_key      text,
  assigned_at          timestamptz not null default now(),

  constraint mia_override_needs_reason check (
    is_override = false or btrim(coalesce(override_reason, '')) <> ''
  )
);

create unique index if not exists mia_idem_uq
  on management_item_assignments (company_id, item_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists mia_item_idx
  on management_item_assignments (company_id, item_id, assigned_at desc);

create or replace function r1_draft_assignments_append_only()
returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $fn$
begin
  raise exception 'management_item_assignments is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$fn$;

drop trigger if exists mia_no_update on management_item_assignments;
create trigger mia_no_update
  before update or delete on management_item_assignments
  for each row execute function r1_draft_assignments_append_only();

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 3. The assignment boundary
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Owner decision 2: AI assignment is RECOMMENDATION-ONLY. The system may rank and propose; a
-- binding assignment requires an authenticated human holding the task-management authority in the
-- relevant company. Staff cannot self-assign, and no service principal may assign at all.
--
-- Owner decision 3: `accountable_owner_id` may be set only when a real binding assignment occurs,
-- and the item and the task must never name different people.
create or replace function public.r1_draft_assign_management_item(
  p_item_id                  uuid,
  -- The MEMBERSHIP to make accountable. Resolved to a user here; the caller does not supply one.
  p_membership_id            uuid,
  -- What the assigner saw. Compared, never trusted.
  p_expected_state           text,
  p_expected_condition_digest text,
  p_expected_eligibility_digest text,
  p_override_reason          text default null,
  p_idempotency_key          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_actor        uuid := auth.uid();
  v_item         record;
  v_company      uuid;
  v_target       record;
  v_task_id      uuid;
  v_task         record;
  v_rec          record;
  v_existing     record;
  v_is_override  boolean := false;
  v_prev         uuid;
  v_assignment   uuid;
  v_transition   jsonb;
  v_condition    text;
begin
  -- ── 1. A real authenticated person. ──
  if v_actor is null then
    return jsonb_build_object('ok', false, 'refusal', 'unauthenticated');
  end if;

  -- ── 2. Lock the item, then the target membership, then the task. One order, always. ──
  select id, company_id, state, department, accountable_owner_id, proposed_action_id
    into v_item
    from public.management_items
   where id = p_item_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'refusal', 'not_found');
  end if;
  v_company := v_item.company_id;

  -- ── 3. The assigner's authority, in THIS company. Derived, never supplied. ──
  if not exists (
    select 1 from public.memberships m
     where m.user_id = v_actor and m.company_id = v_company and m.status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'refusal', 'not_found');
  end if;
  if not public.has_capability(v_company, 'operations.task.manage') then
    return jsonb_build_object('ok', false, 'refusal', 'insufficient_capability');
  end if;

  -- ── 4. The target: active, same company, internal, and able to do the work. ──
  select m.id, m.user_id, m.company_id, m.status
    into v_target
    from public.memberships m
   where m.id = p_membership_id
   for update;
  if not found or v_target.company_id is distinct from v_company then
    return jsonb_build_object('ok', false, 'refusal', 'target_not_in_company');
  end if;
  if v_target.status is distinct from 'active' then
    return jsonb_build_object('ok', false, 'refusal', 'target_not_active',
                              'actual', v_target.status);
  end if;

  -- The capability is the TARGET's, not the assigner's. A manager may not hand work to somebody
  -- who is not permitted to do it.
  if not exists (
    select 1
      from public.membership_roles mr
      join public.role_permissions rp on rp.role_key = mr.role_key
     where mr.membership_id = v_target.id
       and rp.permission_key = 'operations.task.work'
  ) then
    return jsonb_build_object('ok', false, 'refusal', 'target_lacks_capability');
  end if;

  -- Approved leave makes someone unavailable. Assigning them anyway would be the system ignoring
  -- a fact it holds.
  -- `leave_requests` is keyed on `profile_id`, which is the USER id (profiles.id references
  -- auth.users). Checked through the target's user rather than their membership, because that is
  -- how the existing table actually records it.
  if to_regclass('public.leave_requests') is not null then
    if exists (
      select 1 from public.leave_requests l
       where l.company_id = v_company
         and l.profile_id = v_target.user_id
         and l.status = 'approved'
         and current_date between l.start_date and l.end_date
    ) then
      return jsonb_build_object('ok', false, 'refusal', 'target_unavailable');
    end if;
  end if;

  -- ── 5. The task this assignment is about: the effect execution created. ──
  select a.effect_ref into v_task_id
    from public.management_execution_attempts a
   where a.company_id = v_company and a.item_id = p_item_id and a.status = 'executed'
     and a.effect_ref is not null
   order by a.created_at desc
   limit 1;
  if v_task_id is null then
    -- Assignment without a task is assignment of nothing. The effect has to exist first.
    return jsonb_build_object('ok', false, 'refusal', 'no_effect_to_assign');
  end if;

  select id, company_id, assigned_to, status into v_task
    from public.tasks where id = v_task_id for update;
  if not found or v_task.company_id is distinct from v_company then
    return jsonb_build_object('ok', false, 'refusal', 'not_found');
  end if;

  -- ── 6. Bound to what the assigner saw. ──
  if v_item.state is distinct from p_expected_state then
    return jsonb_build_object('ok', false, 'refusal', 'stale_item',
                              'expected', p_expected_state, 'actual', v_item.state);
  end if;
  v_condition := public.r1_draft_evidence_digest(v_company, p_item_id);
  if v_condition is distinct from p_expected_condition_digest then
    return jsonb_build_object('ok', false, 'refusal', 'condition_changed');
  end if;

  -- ── 7. The CANDIDATE evidence, revalidated (R2F-F-017, the assignment half). ──
  --
  -- A stale candidate snapshot did not stop the unassigned task being created — correctly, because
  -- the task is about the problem and not about the person. It stops the task being GIVEN to
  -- someone, because that is the decision the eligibility evidence was about.
  -- The snapshot for THIS TARGET, not "the latest snapshot".
  --
  -- The resolver records one row per ranked candidate, all written in the same statement and so
  -- all carrying the same `created_at`. Taking `order by created_at desc limit 1` picked an
  -- arbitrary one of them, which meant the eligibility evidence being revalidated belonged to
  -- whichever candidate the planner happened to return first — not to the person being assigned.
  -- The tie-break on `id` makes the read deterministic; keying on `candidate_ref` makes it
  -- CORRECT, because the evidence that matters is the evidence about this person.
  select candidate_ref, eligibility_evidence_digest
    into v_rec
    from public.management_item_recommendations
   where company_id = v_company and item_id = p_item_id and purpose = 'assignee'
     and candidate_ref = p_membership_id::text
   order by created_at desc, id desc
   limit 1;

  if found then
    -- A recommended candidate. Their eligibility evidence is revalidated against what the manager
    -- saw; if the person's roles, capacity or leave have moved since, this is refused.
    v_is_override := false;
    if v_rec.eligibility_evidence_digest is distinct from p_expected_eligibility_digest then
      return jsonb_build_object('ok', false, 'refusal', 'recommendation_stale');
    end if;
  else
    -- Nobody recommended this person. That is an OVERRIDE — permitted, because a manager may know
    -- something the resolver does not, and required to be explained, because "the manager knew
    -- better" has to be written down to be reviewable. There is no candidate evidence to
    -- revalidate: the target's membership, capability, availability and scope were all checked
    -- above, against the live record rather than against a snapshot.
    v_is_override := true;
    if coalesce(btrim(p_override_reason), '') = '' then
      select candidate_ref into v_rec
        from public.management_item_recommendations
       where company_id = v_company and item_id = p_item_id and purpose = 'assignee'
         and candidate_ref is not null
       order by rank_position asc nulls last, created_at desc, id desc
       limit 1;
      return jsonb_build_object('ok', false, 'refusal', 'override_reason_required',
                                'recommended', v_rec.candidate_ref);
    end if;
  end if;

  -- ── 8. Idempotency, before the state comparison so an honest resend is recognised. ──
  if p_idempotency_key is not null and btrim(p_idempotency_key) <> '' then
    select id, membership_id, assigned_by_user_id into v_existing
      from public.management_item_assignments
     where company_id = v_company and item_id = p_item_id
       and idempotency_key = p_idempotency_key;
    if found then
      if v_existing.membership_id = p_membership_id and v_existing.assigned_by_user_id = v_actor then
        return jsonb_build_object('ok', true, 'result', 'duplicate',
                                  'assignment_id', v_existing.id);
      end if;
      return jsonb_build_object('ok', false, 'refusal', 'conflicting_retry');
    end if;
  end if;

  -- ── 9. The state must admit an assignment. ──
  if v_item.state not in ('needs_routing', 'approved', 'reopened', 'assigned') then
    return jsonb_build_object('ok', false, 'refusal', 'state_does_not_admit_assignment',
                              'actual', v_item.state);
  end if;

  v_prev := v_item.accountable_owner_id;

  -- ── 10. ONE act: the task's assignee, the item's accountable owner, the history, the
  --        transition and the audit. They can never disagree because they are written together.
  update public.tasks set assigned_to = v_target.user_id where id = v_task_id;
  update public.management_items set accountable_owner_id = v_target.id where id = p_item_id;

  insert into public.management_item_assignments (
    company_id, item_id, task_id, membership_id, assignee_user_id, assigned_by_user_id,
    recommended_ref, is_override, override_reason, eligibility_digest,
    previous_membership_id, idempotency_key
  ) values (
    v_company, p_item_id, v_task_id, v_target.id, v_target.user_id, v_actor,
    v_rec.candidate_ref, v_is_override, nullif(btrim(coalesce(p_override_reason, '')), ''),
    v_rec.eligibility_evidence_digest, v_prev,
    nullif(btrim(coalesce(p_idempotency_key, '')), '')
  ) returning id into v_assignment;

  -- Already `assigned` means this is a REASSIGNMENT: the history above records it and the state
  -- does not move, because it is already where it belongs.
  if v_item.state <> 'assigned' then
    v_transition := public.r1_draft_transition_item(
      p_item_id, v_item.state, 'assigned', v_actor, 'user',
      case when v_is_override then 'assigned by a manager, overriding the recommendation'
           else 'assigned by a manager' end,
      '[]'::jsonb
    );
    if coalesce((v_transition ->> 'ok')::boolean, false) is not true then
      raise exception 'lifecycle transition refused: %', v_transition::text
        using errcode = 'check_violation';
    end if;
  end if;

  insert into public.audit_events (
    company_id, actor_type, actor_id, action, entity_type, entity_id, payload
  ) values (
    v_company, 'user', v_actor::text, 'management_item.assigned',
    'management_item', p_item_id::text,
    jsonb_build_object(
      'assignment_id', v_assignment, 'task_id', v_task_id,
      'membership_id', v_target.id, 'is_override', v_is_override,
      'previous_membership_id', v_prev
    )
  );

  return jsonb_build_object('ok', true, 'result', 'assigned',
                            'assignment_id', v_assignment, 'task_id', v_task_id,
                            'is_override', v_is_override, 'to_state', 'assigned');
end;
$fn$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 4. RLS and privileges
-- ═════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_role text;
begin
  if to_regprocedure('public.has_capability(uuid, text)') is null then
    raise notice 'R1_DRAFT_028: base identity functions absent — policies SKIPPED';
    return;
  end if;

  execute 'revoke all on table public.management_item_assignments from public, anon';
  foreach v_role in array array['authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on table public.management_item_assignments from %I', v_role);
    end if;
  end loop;
  execute 'alter table public.management_item_assignments enable row level security';

  -- Read follows the ITEM. No write policy: the RPC is the only way an assignment comes into
  -- existence, so a session cannot compose one naming another assigner.
  begin
    execute 'create policy management_item_assignments_sel
               on public.management_item_assignments
               for select to authenticated using (public.r1_draft_may_see_item(item_id))';
  exception when duplicate_object then null; end;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.management_item_assignments to authenticated';
  end if;
end $$;

do $$
declare
  v_role text;
  sig text := 'public.r1_draft_assign_management_item(uuid, uuid, text, text, text, text, text)';
begin
  execute format('revoke all on function %s from public', sig);
  -- `service_role` is revoked EXPLICITLY. Supabase's default privileges grant EXECUTE on every new
  -- function to `authenticated` AND `service_role`, so revoking from PUBLIC and `anon` alone would
  -- leave the service principal able to assign — which is precisely the automatic binding
  -- assignment the owner's decision forbids for this phase.
  foreach v_role in array array['anon', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on function %s from %I', sig, v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute format('grant execute on function %s to authenticated', sig);
  end if;
end $$;
