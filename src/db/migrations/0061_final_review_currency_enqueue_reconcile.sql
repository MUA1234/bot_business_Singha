-- 0061_final_review_currency_enqueue_reconcile.sql
-- Phase 1 FINAL external-review corrections:
--   (2) sent-outbox / source reconciliation — an idempotent, service-only RPC to advance a
--       quotation whose outbox row is already `sent` (or to prove it cannot, so the caller fails
--       closed) — so `already_sent` is never returned with sent=false;
--   (3) financial-event currency validated against a currencies CATALOGUE (not a bare regex);
--   (4) an atomic, service-only enqueue RPC that the real application wrapper (enqueueOutbox) calls,
--       so concurrent finalisers are proven to create exactly one outbox row through the real path.
--
-- Forward-only, idempotent. Service-only grants. No feature flag involved (these are active whenever
-- the corresponding code path runs — they are NOT gated by RLS_*/WHATSAPP_ASYNC).

-- ── (3) Currencies catalogue (reference data; no company scope) ───────────────
-- The `currencies` reference table ALREADY exists (migration 0002: code, name, minor_units) but ships
-- unseeded. Rather than a second table, make THIS one the supported-currency catalogue: add an
-- is_active flag (idempotent), seed the supported ISO codes, and lock it read-only for app roles.
-- decide_approval (below) fails closed unless the event currency is an active row here.
-- UPGRADE NOTE: after this migration a financial event whose currency is not seeded here can no longer
-- be approved (fail-closed by design). An operator upgrading a live DB must seed any additional
-- in-use currencies (insert … on conflict do nothing) before enabling approvals for them.
alter table currencies add column if not exists is_active boolean not null default true;
insert into currencies (code, name) values
  ('LKR','Sri Lankan Rupee'), ('USD','US Dollar'), ('EUR','Euro'), ('GBP','Pound Sterling'),
  ('INR','Indian Rupee'), ('AUD','Australian Dollar'), ('CAD','Canadian Dollar'), ('SGD','Singapore Dollar'),
  ('JPY','Japanese Yen'), ('CNY','Chinese Yuan'), ('AED','UAE Dirham'), ('CHF','Swiss Franc'),
  ('NZD','New Zealand Dollar'), ('HKD','Hong Kong Dollar'), ('MYR','Malaysian Ringgit'), ('THB','Thai Baht')
on conflict (code) do nothing;

do $$
begin
  execute 'alter table currencies enable row level security';
  execute 'drop policy if exists currencies_read on currencies';
  execute 'create policy currencies_read on currencies for select using (true)';   -- public reference read
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on currencies to authenticated';                          -- reads allowed…
    execute 'revoke insert, update, delete on currencies from authenticated';        -- …writes never
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke insert, update, delete on currencies from anon';
  end if;
end $$;

-- ── (4) Atomic enqueue RPC (the real enqueueOutbox wrapper calls this) ────────
create or replace function public.enqueue_outbox_row(
  p_company uuid, p_channel text, p_recipient text, p_body text, p_idempotency_key text,
  p_correlation_id text default null, p_template_name text default null, p_template_params jsonb default null,
  p_source_type text default null, p_source_id uuid default null, p_message_purpose text default null
) returns text language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, attempts,
                              correlation_id, template_name, template_params, source_type, source_id, message_purpose)
  values (p_company, p_channel, p_recipient, p_body, p_idempotency_key, 'pending', 0,
          p_correlation_id, p_template_name, p_template_params, p_source_type, p_source_id, p_message_purpose)
  on conflict (idempotency_key) do nothing;   -- idempotency_key is globally unique (SHA of channel+dedupe)
  get diagnostics v_n = row_count;
  return case when v_n = 1 then 'enqueued' else 'duplicate' end;   -- atomic dedup under concurrency
end $$;

-- ── (2) Idempotent, service-only reconcile of a quotation from a SENT outbox row ──
create or replace function public.reconcile_quotation_from_outbox(p_outbox_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_src_type text; v_src_id uuid; v_status text; v_body text; v_provider text;
        v_order uuid; v_conv uuid; v_qstatus text;
begin
  select company_id, source_type, source_id, status, body, provider_message_id
    into v_company, v_src_type, v_src_id, v_status, v_body, v_provider
  from message_outbox where id = p_outbox_id;
  if not found or v_status <> 'sent' or v_src_type <> 'quotation' or v_src_id is null then
    return false;   -- only a SENT quotation-outbox can advance a quotation
  end if;
  select status into v_qstatus from quotations where id = v_src_id and company_id = v_company for update;
  if not found then return false; end if;         -- cross-company / missing → inconsistent (caller fails closed)
  if v_qstatus = 'sent' then return true; end if; -- already consistent (idempotent)
  if v_qstatus not in ('queued','ready') then return false; end if;  -- terminal/other → never force

  update quotations set status = 'sent', sent_at = now()
    where id = v_src_id and company_id = v_company and status in ('queued','ready')
    returning order_id into v_order;
  if not found then return false; end if;
  if v_order is not null then
    update orders set status = 'quoted', updated_at = now()
      where id = v_order and company_id = v_company and status not in ('confirmed','cancelled');
    select conversation_id into v_conv from orders where id = v_order and company_id = v_company;
    if v_conv is not null then
      update wa_conversations set status = 'quoted', updated_at = now()
        where id = v_conv and company_id = v_company and status <> 'closed';
      -- idempotent history: only if this provider message is not already recorded.
      insert into wa_messages (conversation_id, company_id, direction, body, wa_message_id)
      select v_conv, v_company, 'outbound', v_body, v_provider
      where not exists (
        select 1 from wa_messages where conversation_id = v_conv and direction = 'outbound'
          and wa_message_id is not distinct from v_provider
      );
    end if;
  end if;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (v_company, 'system', null, 'quotation.sent_reconciled', 'quotation', v_src_id,
          jsonb_build_object('outbox_id', p_outbox_id, 'provider_message_id', v_provider));
  return true;
end $$;

-- ── (3) decide_approval: validate currency against the catalogue (replaces the bare regex) ──
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
    if not exists (select 1 from currencies where code = upper(btrim(v_ccy)) and is_active) then
      raise exception 'financial event currency % is not a supported currency (fail-closed)', v_ccy;
    end if;
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

-- ── Grants: service-only for the new RPCs; decide_approval unchanged (authenticated + service) ──
do $$
begin
  -- enqueue_outbox_row + reconcile_quotation_from_outbox are SERVICE-ONLY. Revoke from PUBLIC *and*
  -- from authenticated/anon explicitly — Supabase (and the test shim, via ALTER DEFAULT PRIVILEGES)
  -- grant EXECUTE on public functions to authenticated by default, so a bare `revoke … from public`
  -- would leave authenticated able to call them. Fail closed: only service_role may.
  revoke all on function public.enqueue_outbox_row(uuid,text,text,text,text,text,text,jsonb,text,uuid,text) from public;
  revoke all on function public.reconcile_quotation_from_outbox(uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.enqueue_outbox_row(uuid,text,text,text,text,text,text,jsonb,text,uuid,text) from authenticated;
    revoke all on function public.reconcile_quotation_from_outbox(uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.enqueue_outbox_row(uuid,text,text,text,text,text,text,jsonb,text,uuid,text) from anon;
    revoke all on function public.reconcile_quotation_from_outbox(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.enqueue_outbox_row(uuid,text,text,text,text,text,text,jsonb,text,uuid,text) to service_role;
    grant execute on function public.reconcile_quotation_from_outbox(uuid) to service_role;
  end if;
  -- decide_approval stays authenticated + service (an authenticated user records the decision).
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.decide_approval(uuid,uuid,text,text) from public;
    grant execute on function public.decide_approval(uuid,uuid,text,text) to authenticated, service_role;
  end if;
end $$;
