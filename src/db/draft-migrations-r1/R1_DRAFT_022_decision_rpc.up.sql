-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_022 — the management decision boundary (closes R2E-F-011 / R2F-F-002).
--
-- Nothing in the application could record a management decision: no route, action or command wrote
-- one, and `management_items.state` moves only through `r1_draft_transition_item()`. The queue
-- rendered `approved` and `rejected` states that no runtime path produced.
--
-- CORRECTION (R2-F-014). The Batch B audit said the table had "no INSERT policy at all". That was
-- wrong: draft 007 creates `management_item_decisions_ins`, so any authenticated holder of
-- `operations.task.manage` could already write a decision row DIRECTLY — unbound to any item state,
-- with no lifecycle transition and no audit event. Section 5 below closes that path.
--
-- ── Why an RPC and not an INSERT policy ──────────────────────────────────────────────────
--
-- An INSERT policy would let a client compose the row: the item it names, the company it claims,
-- the authority it asserts, the state it says the item was in. Every one of those is a thing the
-- client must NOT get to say. A policy can check `has_capability`; it cannot bind a decision to the
-- exact item version, action id and evidence digest that were on screen when the person decided,
-- and it cannot append the decision, the transition and the audit event as one indivisible act.
--
-- So there is exactly one narrow SECURITY DEFINER entry point, and section 5 removes the direct
-- INSERT policy. A direct insert by an authenticated session is then refused by RLS, not by this
-- function's politeness.
--
-- ── What the caller is allowed to say ────────────────────────────────────────────────────
--
-- The item, the decision, a reason, an idempotency key, and the four values that describe WHAT THEY
-- SAW: the item state, the canonical action id, the evidence digest and the parameter digest.
--
-- It cannot supply a company, a membership, an actor, an authority level or an execution identity.
-- Those are derived from `auth.uid()` and from the item's own row inside this transaction. A caller
-- that could assert them could approve another company's work by claiming to belong to it.
--
-- The four "what they saw" values are not trusted either — they are COMPARED. A decision made
-- against a screen that has since changed is refused rather than silently applied to the new state.
--
-- ── What this function deliberately does not do ──────────────────────────────────────────
--
-- It does not execute anything. Approval and execution are separate steps, and the executor
-- revalidates the approval, authority, evidence, policy, parameters, flags and idempotency
-- immediately before any effect. Approving an action whose policy has no handler produces an
-- honest approved-but-unavailable state and zero business effects.

-- ── 1. Binding columns on the existing decision log ──────────────────────────────────────
--
-- A decision is only meaningful against the thing that was decided. These record it.
alter table public.management_item_decisions
  add column if not exists idempotency_key        text,
  add column if not exists bound_state            text,
  add column if not exists bound_action_id        text,
  add column if not exists bound_evidence_digest  text,
  add column if not exists bound_parameter_digest text;

-- One decision per (company, item, key). A retry with the same key is recognised; a retry with the
-- same key and a DIFFERENT decision is refused rather than quietly returning the first one.
create unique index if not exists management_item_decisions_idem_uq
  on public.management_item_decisions (company_id, item_id, idempotency_key)
  where idempotency_key is not null;

-- ── 2. The evidence digest, defined once ─────────────────────────────────────────────────
--
-- Identical to the executor's: a content digest over the ordered `(source_table, source_id)` pairs.
-- A COUNT cannot serve — three overdue invoices replaced by three unrelated ones is still three.
-- Both sides must compute it the same way or the comparison means nothing, so it lives in one
-- place and both call it.
create or replace function public.r1_draft_evidence_digest(p_company uuid, p_item uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(
           md5(string_agg(source_table || ':' || source_id, '|'
                          order by source_table, source_id)),
           'empty')
    from public.management_item_evidence
   where company_id = p_company and item_id = p_item;
$$;

-- ── 3. The decision boundary ─────────────────────────────────────────────────────────────
create or replace function public.r1_draft_record_management_decision(
  p_item_id                  uuid,
  p_decision                 text,
  -- What the person SAW. Compared, never trusted.
  p_expected_state           text,
  p_expected_action_id       text,
  p_expected_evidence_digest text,
  p_expected_parameter_digest text,
  p_reason                   text default null,
  p_idempotency_key          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_actor      uuid := auth.uid();
  v_item       record;
  v_company    uuid;
  v_capability text;
  v_digest     text;
  v_to_state   text;
  v_existing   record;
  v_decision_id uuid;
  v_transition jsonb;
begin
  -- ── 1. A real authenticated person. Not a service role, not a claim in a payload. ──
  if v_actor is null then
    return jsonb_build_object('ok', false, 'refusal', 'unauthenticated');
  end if;

  if p_decision is null or p_decision not in ('approve', 'reject') then
    -- `dismiss`, `edit`, `delegate`, `postpone`, `route` and `request_evidence` are recognised by
    -- the existing decision guard but the repository defines NO permission that authorises them.
    -- Inventing one would be inventing an authority rule. Refused, and recorded as unresolved.
    return jsonb_build_object('ok', false, 'refusal', 'unresolved_authority',
                              'detail', 'no permission is defined for this decision type');
  end if;

  -- ── 2. Lock the item FIRST. This is the serialization point: two people deciding the same
  --       item queue here, and the second sees the first's committed state. ──
  select id, company_id, state, proposed_action_id, required_authority
    into v_item
    from public.management_items
   where id = p_item_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'refusal', 'not_found');
  end if;
  v_company := v_item.company_id;

  -- ── 3. Membership, derived from the ITEM's company and the authenticated actor. ──
  --
  -- A cross-company item is reported as `not_found`, identically to an absent one: telling a
  -- stranger that an item exists but is not theirs is itself a disclosure.
  if not exists (
    select 1 from public.memberships m
     where m.user_id = v_actor and m.company_id = v_company and m.status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'refusal', 'not_found');
  end if;

  -- ── 4. Capability, through the EXISTING mechanism. ──
  --
  -- `has_capability` reads `auth.uid()` and requires an active membership, so a membership revoked
  -- between the check above and this one fails here. It is the repository's own authorisation
  -- mechanism — every RLS policy in the codebase gates on it, and migration 0023 documents
  -- `has_capability(company,'approve')` as "manager/admin in company".
  v_capability := case p_decision when 'approve' then 'approve' else 'reject' end;
  if not public.has_capability(v_company, v_capability) then
    return jsonb_build_object('ok', false, 'refusal', 'insufficient_capability');
  end if;

  -- ── 5. Authority levels the repository cannot establish for a user. ──
  --
  -- `specialist_approval` and `owner_approval` exist in the TypeScript authority vocabulary but in
  -- NO database rule: there is no permission distinguishing a specialist or an owner from an
  -- ordinary approver. Recording such a decision would assert an authority this system cannot
  -- verify, so it fails closed and says which case is unresolved.
  if v_item.required_authority in ('specialist_approval', 'owner_approval') then
    return jsonb_build_object('ok', false, 'refusal', 'unresolved_authority',
                              'detail', 'no capability distinguishes ' || v_item.required_authority);
  end if;

  -- ── 6. A reason where the existing guard requires one. ──
  if p_decision = 'reject' and coalesce(btrim(p_reason), '') = '' then
    return jsonb_build_object('ok', false, 'refusal', 'reason_required');
  end if;

  -- ── 7. Idempotency, WITHOUT hiding a conflicting decision. ──
  if p_idempotency_key is not null and btrim(p_idempotency_key) <> '' then
    select id, decision into v_existing
      from public.management_item_decisions
     where company_id = v_company and item_id = p_item_id
       and idempotency_key = p_idempotency_key;

    if found then
      if v_existing.decision = p_decision then
        return jsonb_build_object('ok', true, 'result', 'duplicate',
                                  'decision_id', v_existing.id, 'decision', v_existing.decision);
      end if;
      -- Same key, different decision. Returning the first would hide that two different
      -- intentions were expressed under one identity.
      return jsonb_build_object('ok', false, 'refusal', 'conflicting_retry',
                                'detail', 'this idempotency key already recorded a different decision');
    end if;
  end if;

  -- ── 8. Bind to exactly what the person saw. ──
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

  -- ── 9. Only `awaiting_approval` admits an approve/reject decision. ──
  --
  -- Taken from the lifecycle map rather than restated: `awaiting_approval → approved | rejected`.
  -- A terminal, reopened or otherwise-positioned item is refused here, before anything is written.
  if v_item.state <> 'awaiting_approval' then
    return jsonb_build_object('ok', false, 'refusal', 'state_does_not_admit_decision',
                              'actual', v_item.state);
  end if;
  v_to_state := case p_decision when 'approve' then 'approved' else 'rejected' end;

  -- ── 10. Append the decision, the transition and the audit event as ONE act. ──
  --
  -- The whole function is a single transaction, so a failure at any write boundary leaves no
  -- decision, no transition and no audit row — never a decision the item does not reflect.
  insert into public.management_item_decisions (
    company_id, item_id, decision, actor_id, actor_type, authority_level, reason,
    idempotency_key, bound_state, bound_action_id, bound_evidence_digest, bound_parameter_digest
  ) values (
    v_company, p_item_id, p_decision, v_actor, 'user', v_item.required_authority,
    nullif(btrim(coalesce(p_reason, '')), ''),
    nullif(btrim(coalesce(p_idempotency_key, '')), ''),
    v_item.state, v_item.proposed_action_id, v_digest, p_expected_parameter_digest
  )
  returning id into v_decision_id;

  -- The lifecycle function re-locks the item, re-checks the from-state, and enforces the map. It
  -- is the only writer permitted to move state, so the decision cannot move it any other way.
  v_transition := public.r1_draft_transition_item(
    p_item_id, 'awaiting_approval', v_to_state, v_actor, 'user',
    nullif(btrim(coalesce(p_reason, '')), ''), '[]'::jsonb
  );

  if coalesce((v_transition ->> 'ok')::boolean, false) is not true then
    -- The transition refused. Abort so the decision does not outlive it.
    raise exception 'lifecycle transition refused: %', v_transition::text
      using errcode = 'check_violation';
  end if;

  insert into public.audit_events (
    company_id, actor_type, actor_id, action, entity_type, entity_id, payload
  ) values (
    v_company, 'user', v_actor::text, 'management_item.' || p_decision,
    'management_item', p_item_id::text,
    jsonb_build_object(
      'decision_id', v_decision_id,
      'to_state', v_to_state,
      'required_authority', v_item.required_authority,
      'action_id', v_item.proposed_action_id,
      'evidence_digest', v_digest
    )
  );

  return jsonb_build_object('ok', true, 'result', 'recorded',
                            'decision_id', v_decision_id, 'decision', p_decision,
                            'to_state', v_to_state);
end;
$fn$;

-- ── 4. Privileges ────────────────────────────────────────────────────────────────────────
do $$
begin
  execute 'revoke all on function public.r1_draft_record_management_decision(uuid, text, text, text, text, text, text, text) from public';
  execute 'revoke all on function public.r1_draft_evidence_digest(uuid, uuid) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.r1_draft_record_management_decision(uuid, text, text, text, text, text, text, text) from anon';
    execute 'revoke all on function public.r1_draft_evidence_digest(uuid, uuid) from anon';
  end if;
  -- The MINIMUM invocation required: a signed-in person, and nothing else. Deliberately NOT
  -- granted to `service_role` — a decision is a human act, and a service principal recording one
  -- would be exactly the impersonation this boundary exists to prevent.
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.r1_draft_record_management_decision(uuid, text, text, text, text, text, text, text) to authenticated';
    execute 'grant execute on function public.r1_draft_evidence_digest(uuid, uuid) to authenticated';
  end if;
end $$;

-- No INSERT, UPDATE or DELETE policy is added to `management_item_decisions`. The existing
-- append-only trigger already refuses updates and deletes; the absence of an insert policy is what
-- makes this function the only way in.

-- ── 5. Close the direct-write path (R2-F-014) ────────────────────────────────────────────
--
-- Draft 007 created `management_item_decisions_ins`, letting any authenticated holder of
-- `operations.task.manage` INSERT a decision row directly. That is not a smaller version of this
-- RPC — it is a way past all of it:
--
--   * the decision need not be bound to the item state, action or evidence the person saw;
--   * no lifecycle transition happens, so the log can say `approve` while the item sits in
--     `awaiting_approval` for ever, and the two never have to agree;
--   * no audit event is written;
--   * the actor, company and authority level are all whatever the payload says.
--
-- In the owner's words, a caller payload must never constitute approval. Dropping the policy is a
-- TIGHTENING — it removes a write path, grants nothing, and changes no authority rule. Reads are
-- untouched: `management_item_decisions_sel` still lets members see their company's decisions.
--
-- After this, the table has SELECT policies only, so the SECURITY DEFINER function above is the
-- single way a decision can come into existence.
do $$
begin
  execute 'drop policy if exists management_item_decisions_ins on public.management_item_decisions';
end $$;
