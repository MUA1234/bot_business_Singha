-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_002 — append-only transition history + the concurrency-safe transition function.
--
-- The lifecycle is enforced in TWO places deliberately:
--   * src/kernel/lifecycle.ts  — the pure, testable transition map used by application code;
--   * r1_draft_transition_item() — the database boundary, so a direct writer cannot bypass it.
-- The two must agree; tests/kernel/lifecycle.test.ts and the integration test pin both.

create table if not exists management_item_transitions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  item_id      uuid not null references management_items(id) on delete cascade,
  from_state   text,                      -- null only for the initial `observed` row
  to_state     text not null,
  actor_id     uuid,
  actor_type   text not null check (actor_type in ('user', 'system', 'ai')),
  reason       text,
  evidence     jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists management_item_transitions_item_idx
  on management_item_transitions (item_id, created_at);
create index if not exists management_item_transitions_company_idx
  on management_item_transitions (company_id, created_at);

-- APPEND-ONLY. History that can be rewritten is not an audit trail.
create or replace function r1_draft_transitions_append_only() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  raise exception 'management_item_transitions is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists management_item_transitions_no_update on management_item_transitions;
create trigger management_item_transitions_no_update
  before update or delete on management_item_transitions
  for each row execute function r1_draft_transitions_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- The transition function.
--
-- Concurrency (acceptance D4/D5): the item row is locked FOR UPDATE and the caller's
-- expected `from` state is asserted under that lock. Two concurrent transitions therefore
-- serialise, and the loser gets `conflict` — it does NOT silently overwrite.
--
-- Returns jsonb: { ok, result, from, to } where result is one of
--   'transitioned' | 'conflict' | 'illegal' | 'not_found' | 'reason_required'
-- Illegal transitions and missing reasons RAISE for a programming error, but a `conflict`
-- is a legitimate concurrent outcome and is returned rather than thrown.
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
  -- Lock the item. SKIP LOCKED is deliberately NOT used: the second writer must observe the
  -- committed state and report a conflict, not silently do nothing.
  select * into v_item from public.management_items where id = p_item for update;

  if not found then
    return jsonb_build_object('ok', false, 'result', 'not_found');
  end if;

  -- Expected-from assertion under the lock. This is the concurrency control.
  if v_item.state is distinct from p_from then
    return jsonb_build_object(
      'ok', false, 'result', 'conflict',
      'expected', p_from, 'actual', v_item.state
    );
  end if;

  -- Legality, mirroring src/kernel/lifecycle.ts exactly.
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
    else false                            -- verified / rejected / dismissed / expired are terminal
  end;

  if not v_legal then
    raise exception 'illegal management-item transition % -> %', p_from, p_to
      using errcode = 'check_violation';
  end if;

  -- A dismissal or rejection without a reason destroys the learning signal (IMP-001).
  if p_to in ('dismissed', 'rejected') and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'transition to % requires a reason', p_to
      using errcode = 'check_violation';
  end if;

  insert into public.management_item_transitions
    (company_id, item_id, from_state, to_state, actor_id, actor_type, reason, evidence)
  values
    (v_item.company_id, p_item, p_from, p_to, p_actor, p_actor_type, p_reason, coalesce(p_evidence, '[]'::jsonb));

  update public.management_items
     set state = p_to,
         outcome = case
           when p_to = 'verified'  then 'resolved'
           when p_to = 'rejected'  then 'rejected'
           when p_to = 'dismissed' then 'dismissed'
           when p_to = 'expired'   then 'expired'
           else outcome
         end,
         outcome_reason = case
           when p_to in ('verified', 'rejected', 'dismissed', 'expired') then p_reason
           else outcome_reason
         end,
         outcome_at = case
           when p_to in ('verified', 'rejected', 'dismissed', 'expired') then now()
           else outcome_at
         end
   where id = p_item;

  return jsonb_build_object('ok', true, 'result', 'transitioned', 'from', p_from, 'to', p_to);
end;
$$;

do $$
begin
  if to_regprocedure('public.has_company_access(uuid)') is not null then
    execute 'alter table management_item_transitions enable row level security';
    begin
      execute 'create policy management_item_transitions_read on management_item_transitions
                 for select using (has_company_access(company_id))';
    exception when duplicate_object then null;
    end;
  end if;
end
$$;
