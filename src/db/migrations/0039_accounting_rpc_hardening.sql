-- 0039_accounting_rpc_hardening.sql
-- Production Security & Reliability Gate — Work Package B (Accounting atomicity,
-- authority & idempotency). Makes every accounting RPC safe against retries, concurrent
-- requests, partial failures and direct RPC calls:
--
--   * Reject ANONYMOUS callers (JWT role 'anon').
--   * AUTHENTICATED callers: actor is derived from auth.uid() (p_posted_by/p_by is
--     IGNORED — no actor spoofing), and the operation-specific capability is required.
--   * SERVICE/worker callers (no JWT): trusted; the explicit actor is recorded.
--   * A shared internal poster (_journal_post_internal) does the balanced-journal insert +
--     lines + fail-closed audit. Settlement/reversal call it directly, so recording a
--     receipt/payment/reversal needs its OWN capability (finance.receipt.record /
--     finance.payment.record / finance.journal.reverse) — not finance.journal.post.
--   * Settlement/reversal take a caller idempotency key: idempotency check + journal +
--     payment + source-document update + audit all commit or roll back TOGETHER, in one
--     transaction. A failed operation does NOT consume the key. A repeated key with the
--     SAME amount returns the SAME journal and re-applies NOTHING (ROW_COUNT guard); a
--     repeated key with a DIFFERENT amount is rejected as a CONFLICT. Concurrent
--     duplicates collapse to exactly one journal + one payment + one settlement.
--   * unique_violation handling is NARROWED to the idempotency case (re-query the key;
--     re-raise any unrelated unique violation).
--   * Source rows are locked FOR UPDATE (kept from 0037) so partial settlements cannot
--     exceed the outstanding balance and a double-reverse is serialised.
--
-- These functions RECORD authorised accounting events; they never move money.
-- Preserves the (live-verified) validation logic exactly. FORWARD-ONLY, IDEMPOTENT.

-- Audit needs an idempotency column so a financial audit row can carry its key.
alter table audit_events add column if not exists idempotency_key text;

-- ─────────────────────────────────────────────────────────────────────────────
-- Caller role helper: the JWT role, or NULL when there is no JWT (trusted server).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.caller_jwt_role()
returns text language sql stable set search_path = public as $$
  select nullif(current_setting('request.jwt.claims', true), '')::json->>'role';
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Internal poster — NO caller-capability check (the calling function already gated).
-- Validates + totals BEFORE the idempotency compare, so a reused key with a changed
-- amount is a conflict. SECURITY DEFINER, fixed search_path. NOT granted to
-- authenticated: only the definer functions (run as owner) and service_role may call it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._journal_post_internal(
  p_company uuid,
  p_date date,
  p_currency text,
  p_memo text,
  p_actor uuid,
  p_lines jsonb,
  p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_line jsonb;
  v_journal_id uuid;
  v_existing uuid;
  v_existing_total numeric;
  v_period_id uuid;
  v_period_status text;
  v_line_no int := 0;
  v_debit numeric;
  v_credit numeric;
  v_code text;
begin
  if p_lines is null or jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal needs at least two lines';
  end if;

  select id, status into v_period_id, v_period_status
  from accounting_periods
  where company_id = p_company and p_date between start_date and end_date
  order by start_date desc
  limit 1;
  if v_period_status is not null and v_period_status in ('closed', 'locked') then
    raise exception 'Accounting period is % for %', v_period_status, p_date;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_code := v_line->>'account_code';
    v_debit := round(coalesce((v_line->>'debit')::numeric, 0), 2);
    v_credit := round(coalesce((v_line->>'credit')::numeric, 0), 2);
    if v_debit < 0 or v_credit < 0 then raise exception 'Line has a negative amount'; end if;
    if v_debit > 0 and v_credit > 0 then raise exception 'Line % has both a debit and a credit', v_code; end if;
    if not exists (select 1 from chart_of_accounts where company_id = p_company and code = v_code and is_active) then
      raise exception 'Account % not found or inactive in this company', v_code;
    end if;
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
  end loop;

  if round(v_total_debit, 2) <> round(v_total_credit, 2) then
    raise exception 'Journal is unbalanced: debit % <> credit %', v_total_debit, v_total_credit;
  end if;
  if round(v_total_debit, 2) = 0 then raise exception 'A zero-value journal is not allowed'; end if;

  -- Deterministic idempotency: a repeated key with the SAME total returns the original;
  -- a repeated key with a DIFFERENT total is a conflict.
  if p_idempotency_key is not null then
    select id, total_debit into v_existing, v_existing_total
    from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key;
    if v_existing is not null then
      if round(v_existing_total, 2) <> round(v_total_debit, 2) then
        raise exception 'idempotency key reused with a different amount (conflict)';
      end if;
      return v_existing;
    end if;
  end if;

  begin
    insert into journal_entries (
      company_id, period_id, posting_date, currency, exchange_rate, memo, status,
      correlation_id, idempotency_key, total_debit, total_credit, posted_at, posted_by, created_by
    ) values (
      p_company, v_period_id, p_date, p_currency, 1, p_memo, 'posted',
      'corr_' || gen_random_uuid(), coalesce(p_idempotency_key, 'jm_' || gen_random_uuid()),
      round(v_total_debit, 2), round(v_total_credit, 2), now(), p_actor, p_actor
    ) returning id into v_journal_id;
  exception when unique_violation then
    -- NARROWED: only idempotent if the key row now exists AND its total matches; any
    -- unrelated unique violation propagates.
    if p_idempotency_key is not null then
      select id, total_debit into v_journal_id, v_existing_total
      from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key;
      if v_journal_id is not null then
        if round(v_existing_total, 2) <> round(v_total_debit, 2) then
          raise exception 'idempotency key reused with a different amount (conflict)';
        end if;
        return v_journal_id;
      end if;
    end if;
    raise;
  end;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_line_no := v_line_no + 1;
    insert into journal_lines (journal_id, company_id, account_code, debit, credit, description, line_no)
    values (
      v_journal_id, p_company, v_line->>'account_code',
      round(coalesce((v_line->>'debit')::numeric, 0), 2),
      round(coalesce((v_line->>'credit')::numeric, 0), 2),
      v_line->>'description', v_line_no
    );
  end loop;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, 'user', p_actor, 'journal.posted', 'journal', v_journal_id,
          jsonb_build_object('total', round(v_total_debit, 2), 'memo', p_memo), p_idempotency_key);

  return v_journal_id;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Public: post a manual journal. Requires finance.journal.post for authenticated users.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.post_manual_journal(
  p_company uuid, p_date date, p_currency text, p_memo text, p_posted_by uuid,
  p_lines jsonb, p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_actor uuid;
begin
  if public.caller_jwt_role() = 'anon' then raise exception 'anonymous callers cannot post journals'; end if;
  if auth.uid() is not null then
    if not public.has_capability(p_company, 'finance.journal.post') then
      raise exception 'missing capability finance.journal.post';
    end if;
    v_actor := auth.uid();
  else
    v_actor := p_posted_by;
  end if;
  return public._journal_post_internal(p_company, p_date, p_currency, p_memo, v_actor, p_lines, p_idempotency_key);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Customer receipt. Requires finance.receipt.record. Fully idempotent on the key.
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists public.settle_customer_invoice(uuid,uuid,numeric,text,text,uuid,date);
create or replace function public.settle_customer_invoice(
  p_company uuid, p_invoice uuid, p_amount numeric, p_cash_code text, p_ar_code text, p_by uuid, p_date date,
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_currency text; v_total numeric; v_settled numeric; v_customer uuid; v_number text;
  v_journal uuid; v_lines jsonb; v_new_settled numeric; v_status text; v_actor uuid; v_idem text; v_ins int;
begin
  if public.caller_jwt_role() = 'anon' then raise exception 'anonymous callers cannot record receipts'; end if;
  if auth.uid() is not null then
    if not public.has_capability(p_company, 'finance.receipt.record') then raise exception 'missing capability finance.receipt.record'; end if;
    v_actor := auth.uid();
  else
    v_actor := p_by;
  end if;

  select currency, total_amount, coalesce(amount_settled, 0), customer_id, invoice_number
    into v_currency, v_total, v_settled, v_customer, v_number
  from customer_invoices where id = p_invoice and company_id = p_company
  for update;                                            -- lock the source row
  if v_currency is null then raise exception 'Invoice not found'; end if;
  if p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if round(p_amount, 2) > round(v_total - v_settled, 2) then raise exception 'Amount exceeds outstanding %', (v_total - v_settled); end if;

  v_idem := coalesce(p_idempotency_key, 'settle_ci:' || p_invoice || ':' || round(p_amount,2) || ':' || p_date);
  v_lines := jsonb_build_array(
    jsonb_build_object('account_code', p_cash_code, 'debit', p_amount, 'credit', 0, 'description', 'Receipt ' || v_number),
    jsonb_build_object('account_code', p_ar_code, 'debit', 0, 'credit', p_amount, 'description', 'Receipt ' || v_number)
  );
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Receipt for ' || v_number, v_actor, v_lines, v_idem);

  -- Payment carries the key (payments UNIQUE(company_id, idempotency_key)). If nothing
  -- was inserted, this is a retry of an already-recorded receipt → re-apply NOTHING.
  insert into payments (company_id, direction, party_type, party_id, currency, amount, method, payment_date, journal_id, status, idempotency_key)
  values (p_company, 'in', 'customer', v_customer, v_currency, round(p_amount, 2), 'record', p_date, v_journal, 'recorded', v_idem)
  on conflict (company_id, idempotency_key) do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then return v_journal; end if;   -- idempotent retry: invoice already settled by this key

  v_new_settled := v_settled + round(p_amount, 2);
  v_status := case when round(v_new_settled, 2) >= round(v_total, 2) then 'paid' else 'part_paid' end;
  update customer_invoices set amount_settled = v_new_settled, status = v_status where id = p_invoice and company_id = p_company;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, 'user', v_actor, 'customer_invoice.receipt_recorded', 'customer_invoice', p_invoice,
          jsonb_build_object('amount', round(p_amount,2), 'journal_id', v_journal), v_idem);
  return v_journal;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Supplier payment. Requires finance.payment.record + amount within authority ceiling.
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists public.settle_supplier_bill(uuid,uuid,numeric,text,text,uuid,date);
create or replace function public.settle_supplier_bill(
  p_company uuid, p_bill uuid, p_amount numeric, p_ap_code text, p_cash_code text, p_by uuid, p_date date,
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_currency text; v_total numeric; v_settled numeric; v_supplier uuid; v_number text;
  v_journal uuid; v_lines jsonb; v_new_settled numeric; v_status text; v_actor uuid; v_idem text; v_ins int;
begin
  if public.caller_jwt_role() = 'anon' then raise exception 'anonymous callers cannot record payments'; end if;
  if auth.uid() is not null then
    if not public.has_capability(p_company, 'finance.payment.record') then raise exception 'missing capability finance.payment.record'; end if;
    if not public.within_authority(p_company, 'payment', round(p_amount,2)) then raise exception 'amount exceeds your payment authority ceiling'; end if;
    v_actor := auth.uid();
  else
    v_actor := p_by;
  end if;

  select currency, total_amount, coalesce(amount_settled, 0), supplier_id, bill_number
    into v_currency, v_total, v_settled, v_supplier, v_number
  from supplier_bills where id = p_bill and company_id = p_company
  for update;
  if v_currency is null then raise exception 'Bill not found'; end if;
  if p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if round(p_amount, 2) > round(v_total - v_settled, 2) then raise exception 'Amount exceeds outstanding %', (v_total - v_settled); end if;

  v_idem := coalesce(p_idempotency_key, 'settle_sb:' || p_bill || ':' || round(p_amount,2) || ':' || p_date);
  v_lines := jsonb_build_array(
    jsonb_build_object('account_code', p_ap_code, 'debit', p_amount, 'credit', 0, 'description', 'Payment ' || v_number),
    jsonb_build_object('account_code', p_cash_code, 'debit', 0, 'credit', p_amount, 'description', 'Payment ' || v_number)
  );
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Payment for ' || v_number, v_actor, v_lines, v_idem);

  insert into payments (company_id, direction, party_type, party_id, currency, amount, method, payment_date, journal_id, status, idempotency_key)
  values (p_company, 'out', 'supplier', v_supplier, v_currency, round(p_amount, 2), 'record', p_date, v_journal, 'recorded', v_idem)
  on conflict (company_id, idempotency_key) do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then return v_journal; end if;

  v_new_settled := v_settled + round(p_amount, 2);
  v_status := case when round(v_new_settled, 2) >= round(v_total, 2) then 'paid' else 'part_paid' end;
  update supplier_bills set amount_settled = v_new_settled, status = v_status where id = p_bill and company_id = p_company;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, 'user', v_actor, 'supplier_bill.payment_recorded', 'supplier_bill', p_bill,
          jsonb_build_object('amount', round(p_amount,2), 'journal_id', v_journal), v_idem);
  return v_journal;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Reversal. Requires finance.journal.reverse. Idempotent + serialised double-reverse.
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists public.reverse_journal(uuid,uuid,uuid,date);
create or replace function public.reverse_journal(
  p_company uuid, p_journal uuid, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_currency text; v_status text; v_lines jsonb; v_rev uuid; v_actor uuid; v_idem text;
begin
  if public.caller_jwt_role() = 'anon' then raise exception 'anonymous callers cannot reverse journals'; end if;
  if auth.uid() is not null then
    if not public.has_capability(p_company, 'finance.journal.reverse') then raise exception 'missing capability finance.journal.reverse'; end if;
    v_actor := auth.uid();
  else
    v_actor := p_by;
  end if;

  select currency, status into v_currency, v_status from journal_entries where id = p_journal and company_id = p_company
  for update;                                            -- lock so a double-reverse serialises
  if v_currency is null then raise exception 'Journal not found'; end if;

  v_idem := coalesce(p_idempotency_key, 'reverse:' || p_journal);
  if v_status = 'reversed' then
    -- Idempotent retry OR concurrent double-reverse: return the reversal made by this key.
    select id into v_rev from journal_entries where company_id = p_company and idempotency_key = v_idem;
    if v_rev is not null then return v_rev; end if;
    raise exception 'Journal already reversed';
  elsif v_status <> 'posted' then
    raise exception 'Only a posted journal can be reversed (is %)', v_status;
  end if;

  select jsonb_agg(jsonb_build_object('account_code', account_code, 'debit', credit, 'credit', debit, 'description', 'Reversal'))
    into v_lines from journal_lines where journal_id = p_journal and company_id = p_company;
  if v_lines is null then raise exception 'Journal has no lines'; end if;

  v_rev := public._journal_post_internal(p_company, p_date, v_currency, 'Reversal of journal ' || p_journal, v_actor, v_lines, v_idem);
  update journal_entries set status = 'reversed' where id = p_journal and company_id = p_company;
  update journal_entries set reversal_of_journal_id = p_journal where id = v_rev and company_id = p_company;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, 'user', v_actor, 'journal.reversed', 'journal', p_journal,
          jsonb_build_object('reversal_journal_id', v_rev), v_idem);
  return v_rev;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants: internal poster is NOT for authenticated. Public RPCs are.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public._journal_post_internal(uuid,date,text,text,uuid,jsonb,text) from public;
    revoke all on function public.post_manual_journal(uuid,date,text,text,uuid,jsonb,text) from public;
    revoke all on function public.settle_customer_invoice(uuid,uuid,numeric,text,text,uuid,date,text) from public;
    revoke all on function public.settle_supplier_bill(uuid,uuid,numeric,text,text,uuid,date,text) from public;
    revoke all on function public.reverse_journal(uuid,uuid,uuid,date,text) from public;

    grant execute on function public._journal_post_internal(uuid,date,text,text,uuid,jsonb,text) to service_role;
    grant execute on function public.post_manual_journal(uuid,date,text,text,uuid,jsonb,text) to authenticated, service_role;
    grant execute on function public.settle_customer_invoice(uuid,uuid,numeric,text,text,uuid,date,text) to authenticated, service_role;
    grant execute on function public.settle_supplier_bill(uuid,uuid,numeric,text,text,uuid,date,text) to authenticated, service_role;
    grant execute on function public.reverse_journal(uuid,uuid,uuid,date,text) to authenticated, service_role;
  end if;
end $$;
