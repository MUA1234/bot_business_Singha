-- 0060_wp11_composite_fk_money_failclose.sql
-- Phase 1 SECOND external-review correction — WP11:
--   (1) add company-consistent COMPOSITE constraints so an approval_request cannot reference a
--       financial_event in another company, and an approval_action cannot reference an
--       approval_request in another company (defence beyond the RPC's fail-closed checks);
--   (2) decide_approval also fails closed on a non-positive/non-finite amount, an invalid currency,
--       and an invalid approvals_required.
--
-- Legacy-data preflight (owner runs before VALIDATE; NOT VALID already enforces new/updated rows):
--   select ar.id from approval_requests ar join financial_events fe on fe.id = ar.financial_event_id
--     where fe.company_id is distinct from ar.company_id;                       -- must be 0
--   select aa.id from approval_actions aa join approval_requests ar on ar.id = aa.approval_request_id
--     where ar.company_id is distinct from aa.company_id;                       -- must be 0
-- When both return 0 rows the owner may VALIDATE the two NOT VALID constraints below.
--
-- Forward-only, idempotent. `id` is already unique, so the composite UNIQUE targets always hold
-- (no data-rewrite risk). The FKs are NOT VALID (enforce new rows; legacy validated post-preflight).

-- Composite UNIQUE targets (superset of the existing PK on id → always satisfied).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'financial_events_company_id_uk') then
    alter table financial_events add constraint financial_events_company_id_uk unique (company_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_requests_company_id_uk') then
    alter table approval_requests add constraint approval_requests_company_id_uk unique (company_id, id);
  end if;
end $$;

-- Company-consistent composite FKs (MATCH SIMPLE: a NULL financial_event_id skips the check, so
-- non-financial approval requests are unaffected).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'approval_requests_fe_company_fk') then
    alter table approval_requests
      add constraint approval_requests_fe_company_fk
      foreign key (company_id, financial_event_id) references financial_events (company_id, id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_actions_request_company_fk') then
    alter table approval_actions
      add constraint approval_actions_request_company_fk
      foreign key (company_id, approval_request_id) references approval_requests (company_id, id) not valid;
  end if;
end $$;

-- decide_approval: add fail-closed money + approvals_required validation (everything else unchanged from 0057).
create or replace function public.decide_approval(
  p_company uuid, p_request uuid, p_action text, p_note text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text; v_required int; v_maker uuid; v_fe uuid;
        v_amount numeric; v_ccy text; v_domain text; v_cap text; v_prev text;
        v_approvals int; v_new_status text;
begin
  if public.caller_jwt_role() = 'anon' or auth.uid() is null then raise exception 'approvals require an authenticated user'; end if;
  if p_action not in ('approve','reject') then raise exception 'action must be approve or reject'; end if;

  select status, approvals_required, submitted_by, financial_event_id
    into v_status, v_required, v_maker, v_fe
  from approval_requests where id = p_request and company_id = p_company for update;
  if not found then raise exception 'Approval request not found'; end if;
  if v_status <> 'pending' then raise exception 'Approval request is not pending (is %)', v_status; end if;
  if v_required is null or v_required < 1 then raise exception 'invalid approvals_required % (fail-closed)', v_required; end if;
  if v_maker = auth.uid() then raise exception 'the maker cannot approve their own request (separation of duties)'; end if;

  if v_fe is not null then
    select amount, currency, coalesce(event_type,'payment') into v_amount, v_ccy, v_domain
    from financial_events where id = v_fe and company_id = p_company;
    if not found then raise exception 'financial event not found in this company (fail-closed)'; end if;
    if v_amount is null or v_ccy is null then raise exception 'financial event is missing amount/currency (fail-closed)'; end if;
    if not (v_amount > 0 and v_amount < 'Infinity'::numeric) then
      raise exception 'financial event amount must be positive and finite (is %) (fail-closed)', v_amount;
    end if;
    if v_ccy !~ '^[A-Za-z]{3}$' then raise exception 'financial event currency is invalid (fail-closed)'; end if;
    v_cap := public._approval_capability(v_domain);
    if v_cap is null then raise exception 'no approval capability defined for domain % (fail-closed)', v_domain; end if;
    if not public.has_capability(p_company, v_cap) then raise exception 'missing approval capability %', v_cap; end if;
    if not public.within_authority_for_event(p_company, v_fe) then
      raise exception 'event %/% is outside your approval authority (amount, currency or organisational scope)', v_amount, v_ccy;
    end if;
  else
    if not public.has_capability(p_company, p_action) then raise exception 'missing capability %', p_action; end if;
  end if;

  select action into v_prev from approval_actions where approval_request_id = p_request and actor_user_id = auth.uid() limit 1;
  if v_prev is not null then
    if v_prev <> p_action then raise exception 'conflicting decision: this actor already recorded a %; refusing %', v_prev, p_action; end if;
    return v_status;
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
