-- 0046_authority_and_approvals.sql
-- Correction phase — WP7. Deny-by-default financial authority + a transactional approval RPC.
--   * authority_rules gains is_unlimited (explicit, owner-set) — unlimited is NEVER inferred
--     from a missing row or null amount.
--   * within_authority is now DENY-BY-DEFAULT: for a money domain, no applicable rule = NO
--     authority. Currency is matched; a delegate is bounded by the delegation AND by the
--     delegator's own active authority.
--   * settle_supplier_bill no longer carries an authority ceiling on the RECORDING of an
--     already-moved payment (capability finance.payment.record is the gate); the amount
--     ceiling belongs on the APPROVAL decision below.
--   * decide_approval: one transactional, idempotent, maker-checker approval decision that
--     validates lifecycle, capability, separation of duties and amount/currency authority,
--     records ONE append-only action and advances the request when approvals are satisfied.
--     Direct authenticated inserts into approval_actions are removed (RPC-only).
-- FORWARD-ONLY, IDEMPOTENT.

alter table authority_rules add column if not exists is_unlimited boolean not null default false;

-- ── Deny-by-default authority ────────────────────────────────────────────────
-- Drop the old 3-arg overload (0038) so the currency-aware version is unambiguous.
drop function if exists public.within_authority(uuid, text, numeric);
create or replace function public.within_authority(
  target_company uuid, target_domain text, amount numeric, p_currency text default null
) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    -- own authority rule (explicit unlimited or a sufficient ceiling; currency-matched)
    select 1 from memberships m join authority_rules ar on ar.membership_id = m.id
    where m.user_id = auth.uid() and m.company_id = target_company and m.status = 'active'
      and ar.domain = target_domain
      and (p_currency is null or ar.currency is null or ar.currency = p_currency)
      and (ar.is_unlimited or (ar.max_amount is not null and amount <= ar.max_amount))
    union all
    -- delegated authority: bounded by the delegation AND by the delegator's own authority
    select 1 from delegations d
    join memberships tm on tm.id = d.to_membership and tm.user_id = auth.uid() and tm.status = 'active'
    join memberships fm on fm.id = d.from_membership and fm.status = 'active'
    where d.company_id = target_company and now() between d.starts_at and d.ends_at
      and (d.domain = target_domain or d.domain is null)
      and (d.currency is null or p_currency is null or d.currency = p_currency)
      and d.max_amount is not null and amount <= d.max_amount
      and exists (
        select 1 from authority_rules ar2 where ar2.membership_id = fm.id and ar2.domain = target_domain
          and (ar2.is_unlimited or (ar2.max_amount is not null and amount <= ar2.max_amount))
      )
  );
$$;

-- ── settle_supplier_bill without the recording-time ceiling (capability is the gate) ──
create or replace function public.settle_supplier_bill(
  p_company uuid, p_bill uuid, p_amount numeric, p_ap_code text, p_cash_code text, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text; v_currency text; v_total numeric; v_settled numeric; v_supplier uuid; v_number text; v_journal uuid; v_lines jsonb; v_new_settled numeric; v_status text; v_idem text; v_ins int;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type='user' and not public.has_capability(p_company,'finance.payment.record') then raise exception 'missing capability finance.payment.record'; end if;
  select currency, total_amount, coalesce(amount_settled,0), supplier_id, bill_number into v_currency, v_total, v_settled, v_supplier, v_number
  from supplier_bills where id=p_bill and company_id=p_company for update;
  if v_currency is null then raise exception 'Bill not found'; end if;
  if p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if round(p_amount,2) > round(v_total - v_settled,2) then raise exception 'Amount exceeds outstanding %', (v_total - v_settled); end if;
  v_idem := coalesce(p_idempotency_key, 'settle_sb:'||p_bill||':'||round(p_amount,2)||':'||p_date);
  v_lines := jsonb_build_array(
    jsonb_build_object('account_code',p_ap_code,'debit',p_amount,'credit',0,'description','Payment '||v_number),
    jsonb_build_object('account_code',p_cash_code,'debit',0,'credit',p_amount,'description','Payment '||v_number));
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Payment for '||v_number, v_actor, v_type, v_lines, v_idem, 'supplier_bill.settle', 'supplier_bill', p_bill);
  insert into payments (company_id, direction, party_type, party_id, currency, amount, method, payment_date, journal_id, status, idempotency_key)
  values (p_company,'out','supplier',v_supplier,v_currency,round(p_amount,2),'record',p_date,v_journal,'recorded',v_idem)
  on conflict (company_id, idempotency_key) do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then return v_journal; end if;
  v_new_settled := v_settled + round(p_amount,2);
  v_status := case when round(v_new_settled,2) >= round(v_total,2) then 'paid' else 'part_paid' end;
  update supplier_bills set amount_settled=v_new_settled, status=v_status where id=p_bill and company_id=p_company;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, v_type, v_actor, 'supplier_bill.payment_recorded','supplier_bill',p_bill, jsonb_build_object('amount',round(p_amount,2),'journal_id',v_journal), v_idem);
  return v_journal;
end $$;

-- ── Approval decisions: RPC-only, transactional, idempotent, maker-checker ────
do $$
begin
  drop policy if exists approval_actions_cap_ins on approval_actions;   -- RPC-only now
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke insert, update, delete on approval_actions from authenticated;
  end if;
end $$;

create or replace function public.decide_approval(
  p_company uuid, p_request uuid, p_action text, p_note text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text; v_required int; v_maker uuid; v_fe uuid; v_amount numeric; v_ccy text; v_domain text; v_approvals int; v_new_status text;
begin
  if public.caller_jwt_role() = 'anon' or auth.uid() is null then raise exception 'approvals require an authenticated user'; end if;
  if p_action not in ('approve','reject') then raise exception 'action must be approve or reject'; end if;
  if not public.has_capability(p_company, 'approve') then raise exception 'missing capability approve'; end if;

  select status, approvals_required, submitted_by, financial_event_id
    into v_status, v_required, v_maker, v_fe
  from approval_requests where id = p_request and company_id = p_company for update;
  if not found then raise exception 'Approval request not found'; end if;
  if v_status <> 'pending' then raise exception 'Approval request is not pending (is %)', v_status; end if;
  if v_maker = auth.uid() then raise exception 'the maker cannot approve their own request (separation of duties)'; end if;

  -- Amount/currency authority (deny-by-default) when the request carries a financial event.
  if p_action = 'approve' and v_fe is not null then
    select amount, currency, event_type into v_amount, v_ccy, v_domain from financial_events where id = v_fe and company_id = p_company;
    if v_amount is not null and not public.within_authority(p_company, coalesce(v_domain,'payment'), round(v_amount,2), v_ccy) then
      raise exception 'amount %/% exceeds your approval authority', v_amount, v_ccy;
    end if;
  end if;

  -- One append-only action per approver (idempotent on double-click via the unique key).
  begin
    insert into approval_actions (approval_request_id, company_id, actor_user_id, action, note)
    values (p_request, p_company, auth.uid(), p_action, p_note);
  exception when unique_violation then
    -- already acted → no double count; fall through to recompute status.
    null;
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

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, 'user', auth.uid(), 'approval.' || p_action, 'approval_request', p_request, jsonb_build_object('status', v_new_status));
  return v_new_status;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.decide_approval(uuid,uuid,text,text) from public;
    grant execute on function public.decide_approval(uuid,uuid,text,text) to authenticated, service_role;
  end if;
end $$;
