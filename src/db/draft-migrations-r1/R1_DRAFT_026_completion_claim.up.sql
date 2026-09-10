-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_026 — the completion-claim boundary (R2F-F-008, R2F-F-013).
--
-- ── What a claim is ──────────────────────────────────────────────────────────────────────
--
-- Exactly one thing: **the assigned person reports that their work is complete.**
--
-- It does NOT mean the action succeeded, the business condition is resolved, evidence was
-- verified, the worker performed well, the item may be closed, or that learning may be updated.
-- This function performs no verification and writes no learning signal.
--
-- ── Who may claim (owner decision) ───────────────────────────────────────────────────────
--
-- Only the active user currently assigned to the linked underlying task. A manager or owner may
-- not claim on someone's behalf — they keep their assignment, review, rejection, reopening and
-- verification powers, but a staff member's report of their own work is theirs to make.
--
-- The AI, the cycle, the executor and the service role may not fabricate one: the claimant is
-- `auth.uid()`, and a caller with no JWT subject has none.
--
-- Being `management_items.accountable_owner_id` is NOT sufficient. The task assignment must
-- resolve to the same authenticated user.
--
-- ── Why the task's status is not enough on its own ───────────────────────────────────────
--
-- `completeTask` gates on `requireOps()` and never checks the assignee (R2F-F-011), so a manager
-- can move anyone's task to `completed`. "The task is completed" therefore does not imply "the
-- assigned person said their work is done", and this boundary checks `assigned_to = auth.uid()`
-- itself rather than inheriting the task API's authority.

-- ── 1. The claim record ──────────────────────────────────────────────────────────────────
--
-- The transition log records who, when and why, with a database timestamp — but it has nowhere to
-- put which task the claim was about, the idempotency key, or the item version and evidence digest
-- the claimant saw. Without those an exact retry cannot be recognised and a conflicting one cannot
-- be refused.
create table if not exists management_completion_claims (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null,
  item_id                uuid not null references management_items(id) on delete cascade,
  task_id                uuid not null references tasks(id) on delete cascade,
  -- The authenticated claimant. Never a caller-supplied value.
  claimant_user_id       uuid not null,

  -- What the claimant SAW. Compared, never trusted.
  bound_state            text not null,
  bound_action_id        text,
  bound_evidence_digest  text not null,

  -- How the task was linked to the item, recorded so the two relationships stay distinguishable.
  link_kind              text not null check (link_kind in ('originating', 'effect')),

  note                   text,
  idempotency_key        text,

  -- THE claim time. The database's, not the browser's, and not `tasks.updated_at`, which moves
  -- whenever anything about a row changes.
  claimed_at             timestamptz not null default now()
);

create unique index if not exists management_completion_claims_idem_uq
  on management_completion_claims (company_id, item_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists management_completion_claims_item
  on management_completion_claims (company_id, item_id, claimed_at desc);

-- A claim is history. It is never rewritten and never deleted.
create or replace function r1_draft_completion_claims_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $fn$
begin
  -- Refused by RAISING. A BEFORE trigger returning NULL skips the operation silently, which is
  -- the defect R2D-F-006 was.
  raise exception 'management_completion_claims is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$fn$;

drop trigger if exists management_completion_claims_guard on management_completion_claims;
create trigger management_completion_claims_guard
  before update or delete on management_completion_claims
  for each row execute function r1_draft_completion_claims_append_only();

-- ── 2. The boundary ──────────────────────────────────────────────────────────────────────
create or replace function public.r1_draft_claim_task_completion(
  p_item_id                  uuid,
  p_task_id                  uuid,
  -- What the claimant saw. Compared, never trusted.
  p_expected_state           text,
  p_expected_action_id       text,
  p_expected_evidence_digest text,
  p_note                     text default null,
  p_idempotency_key          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_actor     uuid := auth.uid();
  v_item      record;
  v_task      record;
  v_company   uuid;
  v_link      text;
  v_digest    text;
  v_existing  record;
  v_evidence  int;
  v_claim_id  uuid;
  v_transition jsonb;
begin
  -- ── 1. A real authenticated person. Not a service role, not a payload claim. ──
  if v_actor is null then
    return jsonb_build_object('ok', false, 'refusal', 'unauthenticated');
  end if;

  -- ── 2. Lock the item FIRST, then the task. One order, always, so two concurrent claims
  --       queue rather than deadlock. ──
  select id, company_id, state, department, subject_table, subject_id, proposed_action_id
    into v_item
    from public.management_items
   where id = p_item_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'refusal', 'not_found');
  end if;
  v_company := v_item.company_id;

  select id, company_id, assigned_to, status, requires_evidence
    into v_task
    from public.tasks
   where id = p_task_id
   for update;
  if not found or v_task.company_id is distinct from v_company then
    -- A task in another company is not this item's task. Reported as absent, because telling a
    -- caller that a foreign task exists is itself a disclosure.
    return jsonb_build_object('ok', false, 'refusal', 'not_found');
  end if;

  -- ── 3. The task must actually be LINKED to this item, by one of the two real relationships. ──
  --
  -- Neither can be inferred from the other: the originating task is the one whose condition raised
  -- the item, and the effect task is the one the executor created in response. Completing them
  -- means different things.
  v_link := null;
  if v_item.subject_table = 'tasks' and v_item.subject_id = p_task_id::text then
    v_link := 'originating';
  elsif exists (
    select 1 from public.management_execution_attempts a
     where a.company_id = v_company and a.item_id = p_item_id
       and a.status = 'executed' and a.effect_ref = p_task_id::text
  ) then
    v_link := 'effect';
  end if;
  if v_link is null then
    return jsonb_build_object('ok', false, 'refusal', 'task_not_linked');
  end if;

  -- ── 4. Active membership, then capability, through the existing mechanism. ──
  if not exists (
    select 1 from public.memberships m
     where m.user_id = v_actor and m.company_id = v_company and m.status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'refusal', 'not_found');
  end if;
  if not public.has_capability(v_company, 'operations.task.work') then
    return jsonb_build_object('ok', false, 'refusal', 'insufficient_capability');
  end if;

  -- ── 5. The claimant must BE the assignee. ──
  --
  -- An unassigned task fails here too: NULL is not equal to anything, so there is nobody whose
  -- work this is to report on.
  if v_task.assigned_to is null then
    return jsonb_build_object('ok', false, 'refusal', 'task_unassigned');
  end if;
  if v_task.assigned_to is distinct from v_actor then
    -- A manager or owner reaching this point is refused: they may assign, review, reject, reopen
    -- and verify, but a person's report of their own work is not theirs to make.
    return jsonb_build_object('ok', false, 'refusal', 'not_assignee');
  end if;

  -- ── 6. The task's REAL status, from the record. ──
  if v_task.status not in ('completed', 'cancelled') then
    return jsonb_build_object('ok', false, 'refusal', 'task_not_terminal',
                              'actual', v_task.status);
  end if;

  -- ── 7. Evidence the task itself demands. ──
  if v_task.requires_evidence then
    select count(*)::int into v_evidence
      from public.task_evidence e
     where e.task_id = p_task_id and e.company_id = v_company;
    if v_evidence < 1 then
      return jsonb_build_object('ok', false, 'refusal', 'evidence_required');
    end if;
  end if;

  -- ── 8. Idempotency, checked BEFORE the binding comparison. ──
  --
  -- A successful claim moves the item to `verifying`, so an exact retry carrying the state the
  -- claimant saw would be refused as stale before it could be recognised as the same claim. The
  -- identity checks above have already run: a retry is only recognised for the same person and the
  -- same task.
  if p_idempotency_key is not null and btrim(p_idempotency_key) <> '' then
    select id, task_id, claimant_user_id into v_existing
      from public.management_completion_claims
     where company_id = v_company and item_id = p_item_id
       and idempotency_key = p_idempotency_key;
    if found then
      if v_existing.task_id = p_task_id and v_existing.claimant_user_id = v_actor then
        return jsonb_build_object('ok', true, 'result', 'duplicate', 'claim_id', v_existing.id);
      end if;
      -- Same key, different task or different person. Returning the first would hide that two
      -- different claims were made under one identity.
      return jsonb_build_object('ok', false, 'refusal', 'conflicting_retry');
    end if;
  end if;

  -- ── 9. Bound to what the claimant saw. ──
  if v_item.state is distinct from p_expected_state then
    return jsonb_build_object('ok', false, 'refusal', 'stale_item',
                              'expected', p_expected_state, 'actual', v_item.state);
  end if;
  if coalesce(v_item.proposed_action_id, '') is distinct from coalesce(p_expected_action_id, '') then
    return jsonb_build_object('ok', false, 'refusal', 'action_changed');
  end if;
  v_digest := public.r1_draft_evidence_digest(v_company, p_item_id);
  if v_digest is distinct from p_expected_evidence_digest then
    return jsonb_build_object('ok', false, 'refusal', 'evidence_changed');
  end if;

  -- ── 10. The state must admit a claim. ──
  --
  -- Taken from the lifecycle map, not restated: `monitoring → verifying` and
  -- `escalated → verifying` are legal; `assigned → verifying` is not.
  if v_item.state not in ('monitoring', 'escalated') then
    return jsonb_build_object('ok', false, 'refusal', 'state_does_not_admit_claim',
                              'actual', v_item.state);
  end if;

  -- ── 11. Append the claim, the transition and the audit event as ONE act. ──
  insert into public.management_completion_claims (
    company_id, item_id, task_id, claimant_user_id,
    bound_state, bound_action_id, bound_evidence_digest, link_kind, note, idempotency_key
  ) values (
    v_company, p_item_id, p_task_id, v_actor,
    v_item.state, v_item.proposed_action_id, v_digest, v_link,
    nullif(btrim(coalesce(p_note, '')), ''),
    nullif(btrim(coalesce(p_idempotency_key, '')), '')
  )
  returning id into v_claim_id;

  -- The lifecycle function re-locks the item and re-checks the from-state. It is the only writer
  -- permitted to move state.
  v_transition := public.r1_draft_transition_item(
    p_item_id, v_item.state, 'verifying', v_actor, 'user',
    coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'completion claimed by the assignee'),
    '[]'::jsonb
  );
  if coalesce((v_transition ->> 'ok')::boolean, false) is not true then
    raise exception 'lifecycle transition refused: %', v_transition::text
      using errcode = 'check_violation';
  end if;

  insert into public.audit_events (
    company_id, actor_type, actor_id, action, entity_type, entity_id, payload
  ) values (
    v_company, 'user', v_actor::text, 'management_item.completion_claimed',
    'management_item', p_item_id::text,
    jsonb_build_object(
      'claim_id', v_claim_id, 'task_id', p_task_id, 'link_kind', v_link,
      'evidence_digest', v_digest, 'action_id', v_item.proposed_action_id
    )
  );

  -- No verification is performed and no learning signal is written. Whether the business condition
  -- is resolved is a separate question, answered by re-observation.
  return jsonb_build_object('ok', true, 'result', 'claimed',
                            'claim_id', v_claim_id, 'link_kind', v_link,
                            'to_state', 'verifying');
end;
$fn$;

-- ── 3. RLS and privileges ────────────────────────────────────────────────────────────────
do $$
declare
  v_role text;
begin
  if to_regprocedure('public.has_capability(uuid, text)') is null then
    raise notice 'R1_DRAFT_026: base identity functions absent — policies SKIPPED';
    return;
  end if;

  -- Supabase's default privileges hand `authenticated` full DML on every new table. RLS with no
  -- write policy would already refuse it, and the append-only trigger would refuse it again, but a
  -- privilege that is only harmless because two later guards hold is not a privilege worth keeping.
  execute 'revoke all on table public.management_completion_claims from public, anon';
  foreach v_role in array array['authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on table public.management_completion_claims from %I', v_role);
    end if;
  end loop;
  execute 'alter table public.management_completion_claims enable row level security';

  -- Read follows the ITEM: someone who may not see an item may not see who claimed its work.
  begin
    execute 'create policy management_completion_claims_sel
               on public.management_completion_claims
               for select to authenticated using (public.r1_draft_may_see_item(item_id))';
  exception when duplicate_object then null; end;

  -- No insert policy. The RPC is the only way a claim comes into existence, so a session cannot
  -- compose one naming another person as claimant.
end $$;

do $$
declare
  v_role text;
begin
  execute 'revoke all on function public.r1_draft_claim_task_completion(uuid, uuid, text, text, text, text, text) from public';
  -- `service_role` is revoked EXPLICITLY, and that is the point of this block.
  --
  -- Supabase's default privileges grant EXECUTE on every new function to `authenticated` AND
  -- `service_role`, so revoking from PUBLIC and `anon` alone leaves the service principal able to
  -- call it. A revoke naming only the roles you happened to think of is not a boundary — the first
  -- version of this file had exactly that hole, and the privilege test is what found it.
  foreach v_role in array array['anon', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format(
        'revoke all on function public.r1_draft_claim_task_completion(uuid, uuid, text, text, text, text, text) from %I',
        v_role);
    end if;
  end loop;
  -- Granted to `authenticated` ONLY. Deliberately not to `service_role`: a claim is a human act,
  -- and a service principal making one would be the impersonation this boundary exists to prevent.
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.r1_draft_claim_task_completion(uuid, uuid, text, text, text, text, text) to authenticated';
    execute 'grant select on public.management_completion_claims to authenticated';
  end if;
end $$;
