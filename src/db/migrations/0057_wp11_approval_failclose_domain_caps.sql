-- 0057_wp11_approval_failclose_domain_caps.sql
-- Phase 1 external-review correction C — WP11 approval authority still had fail-open and audit
-- defects, and the generic `approve` capability was broader than the domain-specific model.
--
-- Confirmed defects (migration 0054 / 0046):
--   1. decide_approval enforced event authority only for `approve` — an out-of-scope holder of the
--      generic capability could `reject` another scope's request.
--   2. A missing/cross-company financial event, or a NULL event amount/currency, SKIPPED authority
--      enforcement and proceeded (fail-open).
--   3. A user who already approved a multi-approval request could call `reject`: the duplicate
--      action insert was swallowed, yet the request still transitioned to `rejected` with no
--      matching approval_actions row.
--   4. within_authority_for_event's delegation joins did not require the from/to memberships to
--      belong to p_company (a cross-company membership path under corrupt/adversarial data).
--   5. The generic `approve` capability was never replaced by domain-specific approval authority.
--
-- Fix (this migration): a deterministic, fail-closed domain->capability whitelist; authority
-- (capability + amount/currency/scope) enforced for BOTH approve and reject on a financial event;
-- fail-closed on missing/cross-company event and NULL amount/currency/unknown domain; duplicate
-- actor action is a conflict on a DIFFERENT action (no state/audit change) and idempotent on the
-- same; audit is written only for a persisted new action; delegation requires from/to memberships
-- active in p_company.
--
-- Legacy-data preflight (owner should run before enabling, remediate any rows):
--   -- approval requests whose financial event is in another company (should be 0):
--   --   select ar.id from approval_requests ar join financial_events fe on fe.id=ar.financial_event_id
--   --     where fe.company_id <> ar.company_id;
--   -- delegations whose memberships are in another company (should be 0):
--   --   select d.id from delegations d
--   --     join memberships fm on fm.id=d.from_membership join memberships tm on tm.id=d.to_membership
--   --     where fm.company_id <> d.company_id or tm.company_id <> d.company_id;
-- The RPC below fails closed on these regardless, so they cannot be exploited; hard composite FKs
-- are deferred to a preflight-gated follow-up to avoid failing a migration on legacy rows.
--
-- Forward-only. Permission-catalogue change authorised by the owner for this correction increment
-- (code only; not enabled in any hosted environment).

-- ── 1. Domain-specific approval capabilities (catalogue + role map) ───────────
insert into permissions(key, label) values
  ('finance.approve.payment','Approve payments'),
  ('finance.approve.expense','Approve expenses/claims'),
  ('finance.approve.sales','Approve sales documents'),
  ('finance.approve.purchase','Approve purchase documents')
on conflict do nothing;

insert into role_permissions (role_key, permission_key) values
  -- Broad financial approvers get every domain.
  ('owner_management','finance.approve.payment'), ('owner_management','finance.approve.expense'),
  ('owner_management','finance.approve.sales'),   ('owner_management','finance.approve.purchase'),
  ('finance_reviewer','finance.approve.payment'), ('finance_reviewer','finance.approve.expense'),
  ('finance_reviewer','finance.approve.sales'),   ('finance_reviewer','finance.approve.purchase'),
  ('system_administrator','finance.approve.payment'), ('system_administrator','finance.approve.expense'),
  ('system_administrator','finance.approve.sales'),   ('system_administrator','finance.approve.purchase'),
  -- Narrow approvers: project/division managers approve expenses/claims within scope; the payment
  -- approver approves payments only. Neither can approve unrelated domains (fail-closed matrix).
  ('project_manager','finance.approve.expense'),
  ('payment_approver','finance.approve.payment')
on conflict do nothing;

-- ── 2. Deterministic domain -> capability whitelist (fail-closed) ─────────────
-- Maps a financial event's domain (event_type / authority domain) to the single approval capability
-- required. Unknown/unmapped domains return NULL, which the RPC treats as DENY. No AI/free-text path
-- chooses the capability.
create or replace function public._approval_capability(p_domain text)
returns text language sql immutable set search_path = public as $$
  select case lower(coalesce(p_domain,''))
    when 'payment' then 'finance.approve.payment'
    when 'expense_payment' then 'finance.approve.payment'
    when 'supplier_payment' then 'finance.approve.payment'
    when 'refund' then 'finance.approve.payment'
    when 'bank_transfer' then 'finance.approve.payment'
    when 'expense' then 'finance.approve.expense'
    when 'expense_claim' then 'finance.approve.expense'
    when 'reimbursement' then 'finance.approve.expense'
    when 'employee_advance' then 'finance.approve.expense'
    when 'advance_settlement' then 'finance.approve.expense'
    when 'customer_invoice' then 'finance.approve.sales'
    when 'customer_receipt' then 'finance.approve.sales'
    when 'credit_note' then 'finance.approve.sales'
    when 'supplier_bill' then 'finance.approve.purchase'
    when 'supplier_credit' then 'finance.approve.purchase'
    else null   -- unknown / 'unknown' / NULL → no capability → deny
  end;
$$;

-- ── 3. within_authority_for_event: delegation memberships must be in p_company ─
create or replace function public.within_authority_for_event(p_company uuid, p_event uuid)
returns boolean language sql stable security definer set search_path = public as $$
  with ev as (
    select amount, currency, coalesce(event_type, 'payment') as domain
    from financial_events where id = p_event and company_id = p_company
  ),
  alloc as (
    select division_id, project_id, site_id, cost_centre_id
    from financial_event_allocations where financial_event_id = p_event and company_id = p_company
  ),
  own_basis as (
    select ar.is_company_wide as cw, ar.division_id, ar.project_id, ar.site_id, ar.cost_centre_id
    from ev
    join memberships m on m.user_id = auth.uid() and m.company_id = p_company and m.status = 'active'
    join authority_rules ar on ar.membership_id = m.id and ar.company_id = p_company
    where ar.domain = ev.domain
      and ar.currency is not null and ar.currency = ev.currency
      and (ar.is_unlimited or (ar.max_amount is not null and ev.amount <= ar.max_amount))
  ),
  del_basis as (
    select d.is_company_wide as cw, d.division_id, d.project_id, d.site_id, d.cost_centre_id
    from ev
    join delegations d on d.company_id = p_company and now() between d.starts_at and d.ends_at
    join memberships tm on tm.id = d.to_membership and tm.user_id = auth.uid() and tm.status = 'active' and tm.company_id = p_company
    join memberships fm on fm.id = d.from_membership and fm.status = 'active' and fm.company_id = p_company
    where (d.domain = ev.domain or d.domain is null)
      and d.currency is not null and d.currency = ev.currency
      and d.max_amount is not null and ev.amount <= d.max_amount
      and exists (
        select 1 from authority_rules ar2
        where ar2.membership_id = fm.id and ar2.company_id = p_company and ar2.domain = ev.domain
          and ar2.currency is not null and ar2.currency = ev.currency
          and (ar2.is_unlimited or (ar2.max_amount is not null and ev.amount <= ar2.max_amount))
          and public._scope_covers(ar2.is_company_wide, ar2.division_id, ar2.project_id, ar2.site_id, ar2.cost_centre_id,
                                   d.is_company_wide, d.division_id, d.project_id, d.site_id, d.cost_centre_id)
      )
  ),
  basis as (select * from own_basis union all select * from del_basis)
  select case
    when not exists (select 1 from ev) then false
    when not exists (select 1 from alloc) then exists (select 1 from basis where cw)
    else
      exists (select 1 from basis)
      and not exists (
        select 1 from alloc a
        where not exists (
          select 1 from basis b
          where public._scope_covers(b.cw, b.division_id, b.project_id, b.site_id, b.cost_centre_id,
                                     false, a.division_id, a.project_id, a.site_id, a.cost_centre_id)
        )
      )
  end;
$$;

-- ── 4. decide_approval: fail-closed, domain-capability, reject-authority, audit-only-persisted ──
create or replace function public.decide_approval(
  p_company uuid, p_request uuid, p_action text, p_note text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text; v_required int; v_maker uuid; v_fe uuid;
        v_amount numeric; v_ccy text; v_domain text; v_cap text; v_prev text;
        v_found boolean; v_approvals int; v_new_status text;
begin
  if public.caller_jwt_role() = 'anon' or auth.uid() is null then raise exception 'approvals require an authenticated user'; end if;
  if p_action not in ('approve','reject') then raise exception 'action must be approve or reject'; end if;

  select status, approvals_required, submitted_by, financial_event_id
    into v_status, v_required, v_maker, v_fe
  from approval_requests where id = p_request and company_id = p_company for update;
  if not found then raise exception 'Approval request not found'; end if;
  if v_status <> 'pending' then raise exception 'Approval request is not pending (is %)', v_status; end if;
  if v_maker = auth.uid() then raise exception 'the maker cannot approve their own request (separation of duties)'; end if;

  if v_fe is not null then
    -- A financial-event decision (approve OR reject) is deny-by-default: the event must exist in
    -- THIS company with valid money fields and a known domain; the caller must hold the
    -- domain-specific approval capability AND be within amount/currency/organisational scope.
    select amount, currency, coalesce(event_type,'payment') into v_amount, v_ccy, v_domain
    from financial_events where id = v_fe and company_id = p_company;
    if not found then raise exception 'financial event not found in this company (fail-closed)'; end if;
    if v_amount is null or v_ccy is null then raise exception 'financial event is missing amount/currency (fail-closed)'; end if;
    v_cap := public._approval_capability(v_domain);
    if v_cap is null then raise exception 'no approval capability defined for domain % (fail-closed)', v_domain; end if;
    if not public.has_capability(p_company, v_cap) then raise exception 'missing approval capability %', v_cap; end if;
    if not public.within_authority_for_event(p_company, v_fe) then
      raise exception 'event %/% is outside your approval authority (amount, currency or organisational scope)', v_amount, v_ccy;
    end if;
  else
    -- Non-financial request: the baseline approve/reject capability gates the matching action.
    if not public.has_capability(p_company, p_action) then raise exception 'missing capability %', p_action; end if;
  end if;

  -- Duplicate actor action: conflict on a DIFFERENT action (no state/audit change); idempotent on
  -- the same action (no re-transition, no new audit).
  select action into v_prev from approval_actions where approval_request_id = p_request and actor_user_id = auth.uid() limit 1;
  if v_prev is not null then
    if v_prev <> p_action then raise exception 'conflicting decision: this actor already recorded a %; refusing %', v_prev, p_action; end if;
    return v_status;  -- same action again → idempotent
  end if;
  begin
    insert into approval_actions (approval_request_id, company_id, actor_user_id, action, note)
    values (p_request, p_company, auth.uid(), p_action, p_note);
  exception when unique_violation then
    select action into v_prev from approval_actions where approval_request_id = p_request and actor_user_id = auth.uid() limit 1;
    if v_prev is distinct from p_action then raise exception 'conflicting decision: this actor already recorded a %; refusing %', v_prev, p_action; end if;
    return v_status;
  end;

  if p_action = 'reject' then
    v_new_status := 'rejected';
    update approval_requests set status = 'rejected' where id = p_request and company_id = p_company and status = 'pending';
  else
    select count(distinct actor_user_id) into v_approvals from approval_actions where approval_request_id = p_request and action = 'approve';
    if v_approvals >= v_required then
      v_new_status := 'approved';
      update approval_requests set status = 'approved' where id = p_request and company_id = p_company and status = 'pending';
    else
      v_new_status := 'pending';
    end if;
  end if;

  -- Audit only the action that actually persisted (linked to this actor's decision).
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, 'user', auth.uid(), 'approval.' || p_action, 'approval_request', p_request,
          jsonb_build_object('status', v_new_status, 'actor_action', p_action));
  return v_new_status;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.decide_approval(uuid,uuid,text,text) from public;
    grant execute on function public.decide_approval(uuid,uuid,text,text) to authenticated, service_role;
  end if;
end $$;
