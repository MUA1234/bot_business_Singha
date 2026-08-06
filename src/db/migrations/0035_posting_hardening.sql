-- 0035_posting_hardening.sql
-- WP2 (NEXT_PHASE_DEVELOPER_BRIEF §2/§3/§4/§9) — harden the accounting RPCs:
--   * SECURITY DEFINER + fixed search_path (so they post through the ledger's own
--     policies regardless of the caller's RLS), with an internal company guard.
--   * post_manual_journal gains a caller-provided idempotency key: a retry with the
--     same key returns the SAME journal (no duplicate), enforced by the existing
--     UNIQUE (company_id, idempotency_key).
--   * Fail-closed AUDIT in the same transaction as the posting (a failed audit rolls
--     the posting back).
--   * REVOKE from public; GRANT only to authenticated + service_role.
-- Preserves the (live-verified) posting logic exactly. FORWARD-ONLY, IDEMPOTENT.

-- Drop the old 6-arg signature so the new 7-arg (defaulted) version is unambiguous.
drop function if exists public.post_manual_journal(uuid, date, text, text, uuid, jsonb);
drop function if exists public.post_manual_journal(uuid, date, text, text, uuid, jsonb, text);

create function public.post_manual_journal(
  p_company uuid,
  p_date date,
  p_currency text,
  p_memo text,
  p_posted_by uuid,
  p_lines jsonb,
  p_idempotency_key text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_line jsonb;
  v_journal_id uuid;
  v_existing uuid;
  v_period_id uuid;
  v_period_status text;
  v_line_no int := 0;
  v_debit numeric;
  v_credit numeric;
  v_code text;
begin
  -- Internal authorisation: an AUTHENTICATED caller must belong to the company. A
  -- service-role/worker call (auth.uid() null) is trusted (app-layer capability checks).
  if auth.uid() is not null and not public.has_company_access(p_company) then
    raise exception 'no access to company %', p_company;
  end if;

  -- Idempotency: a retry with the same key returns the already-posted journal.
  if p_idempotency_key is not null then
    select id into v_existing from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key;
    if v_existing is not null then return v_existing; end if;
  end if;

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

  begin
    insert into journal_entries (
      company_id, period_id, posting_date, currency, exchange_rate, memo, status,
      correlation_id, idempotency_key, total_debit, total_credit, posted_at, posted_by, created_by
    ) values (
      p_company, v_period_id, p_date, p_currency, 1, p_memo, 'posted',
      'corr_' || gen_random_uuid(), coalesce(p_idempotency_key, 'jm_' || gen_random_uuid()),
      round(v_total_debit, 2), round(v_total_credit, 2), now(), p_posted_by, p_posted_by
    ) returning id into v_journal_id;
  exception when unique_violation then
    -- Concurrent retry with the same idempotency key — return the winner's journal.
    select id into v_journal_id from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key;
    return v_journal_id;
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

  -- Fail-closed audit in the SAME transaction (a failed audit rolls back the posting).
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, 'user', p_posted_by, 'journal.posted', 'journal', v_journal_id,
          jsonb_build_object('total', round(v_total_debit, 2), 'memo', p_memo));

  return v_journal_id;
end $$;

-- Settlement / reversal: same logic, now SECURITY DEFINER with the company guard.
create or replace function public.settle_customer_invoice(
  p_company uuid, p_invoice uuid, p_amount numeric, p_cash_code text, p_ar_code text, p_by uuid, p_date date
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_currency text; v_total numeric; v_settled numeric; v_customer uuid; v_number text;
  v_journal uuid; v_lines jsonb; v_new_settled numeric; v_status text;
begin
  if auth.uid() is not null and not public.has_company_access(p_company) then raise exception 'no access to company %', p_company; end if;
  select currency, total_amount, coalesce(amount_settled, 0), customer_id, invoice_number
    into v_currency, v_total, v_settled, v_customer, v_number
  from customer_invoices where id = p_invoice and company_id = p_company;
  if v_currency is null then raise exception 'Invoice not found'; end if;
  if p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if round(p_amount, 2) > round(v_total - v_settled, 2) then raise exception 'Amount exceeds outstanding %', (v_total - v_settled); end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_code', p_cash_code, 'debit', p_amount, 'credit', 0, 'description', 'Receipt ' || v_number),
    jsonb_build_object('account_code', p_ar_code, 'debit', 0, 'credit', p_amount, 'description', 'Receipt ' || v_number)
  );
  v_journal := public.post_manual_journal(p_company, p_date, v_currency, 'Receipt for ' || v_number, p_by, v_lines);

  insert into payments (company_id, direction, party_type, party_id, currency, amount, method, payment_date, journal_id, status)
  values (p_company, 'in', 'customer', v_customer, v_currency, round(p_amount, 2), 'record', p_date, v_journal, 'recorded');

  v_new_settled := v_settled + round(p_amount, 2);
  v_status := case when round(v_new_settled, 2) >= round(v_total, 2) then 'paid' else 'part_paid' end;
  update customer_invoices set amount_settled = v_new_settled, status = v_status where id = p_invoice and company_id = p_company;
  return v_journal;
end $$;

create or replace function public.settle_supplier_bill(
  p_company uuid, p_bill uuid, p_amount numeric, p_ap_code text, p_cash_code text, p_by uuid, p_date date
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_currency text; v_total numeric; v_settled numeric; v_supplier uuid; v_number text;
  v_journal uuid; v_lines jsonb; v_new_settled numeric; v_status text;
begin
  if auth.uid() is not null and not public.has_company_access(p_company) then raise exception 'no access to company %', p_company; end if;
  select currency, total_amount, coalesce(amount_settled, 0), supplier_id, bill_number
    into v_currency, v_total, v_settled, v_supplier, v_number
  from supplier_bills where id = p_bill and company_id = p_company;
  if v_currency is null then raise exception 'Bill not found'; end if;
  if p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if round(p_amount, 2) > round(v_total - v_settled, 2) then raise exception 'Amount exceeds outstanding %', (v_total - v_settled); end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_code', p_ap_code, 'debit', p_amount, 'credit', 0, 'description', 'Payment ' || v_number),
    jsonb_build_object('account_code', p_cash_code, 'debit', 0, 'credit', p_amount, 'description', 'Payment ' || v_number)
  );
  v_journal := public.post_manual_journal(p_company, p_date, v_currency, 'Payment for ' || v_number, p_by, v_lines);

  insert into payments (company_id, direction, party_type, party_id, currency, amount, method, payment_date, journal_id, status)
  values (p_company, 'out', 'supplier', v_supplier, v_currency, round(p_amount, 2), 'record', p_date, v_journal, 'recorded');

  v_new_settled := v_settled + round(p_amount, 2);
  v_status := case when round(v_new_settled, 2) >= round(v_total, 2) then 'paid' else 'part_paid' end;
  update supplier_bills set amount_settled = v_new_settled, status = v_status where id = p_bill and company_id = p_company;
  return v_journal;
end $$;

create or replace function public.reverse_journal(
  p_company uuid, p_journal uuid, p_by uuid, p_date date
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_currency text; v_status text; v_lines jsonb; v_rev uuid;
begin
  if auth.uid() is not null and not public.has_company_access(p_company) then raise exception 'no access to company %', p_company; end if;
  select currency, status into v_currency, v_status from journal_entries where id = p_journal and company_id = p_company;
  if v_currency is null then raise exception 'Journal not found'; end if;
  if v_status <> 'posted' then raise exception 'Only a posted journal can be reversed (is %)', v_status; end if;

  select jsonb_agg(jsonb_build_object('account_code', account_code, 'debit', credit, 'credit', debit, 'description', 'Reversal'))
    into v_lines from journal_lines where journal_id = p_journal and company_id = p_company;
  if v_lines is null then raise exception 'Journal has no lines'; end if;

  v_rev := public.post_manual_journal(p_company, p_date, v_currency, 'Reversal of journal ' || p_journal, p_by, v_lines);
  update journal_entries set status = 'reversed' where id = p_journal and company_id = p_company;
  update journal_entries set reversal_of_journal_id = p_journal where id = v_rev and company_id = p_company;
  return v_rev;
end $$;

-- REVOKE from public; GRANT only to app roles (guarded for non-Supabase Postgres).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.post_manual_journal(uuid,date,text,text,uuid,jsonb,text) from public;
    revoke all on function public.settle_customer_invoice(uuid,uuid,numeric,text,text,uuid,date) from public;
    revoke all on function public.settle_supplier_bill(uuid,uuid,numeric,text,text,uuid,date) from public;
    revoke all on function public.reverse_journal(uuid,uuid,uuid,date) from public;
    grant execute on function public.post_manual_journal(uuid,date,text,text,uuid,jsonb,text) to authenticated, service_role;
    grant execute on function public.settle_customer_invoice(uuid,uuid,numeric,text,text,uuid,date) to authenticated, service_role;
    grant execute on function public.settle_supplier_bill(uuid,uuid,numeric,text,text,uuid,date) to authenticated, service_role;
    grant execute on function public.reverse_journal(uuid,uuid,uuid,date) to authenticated, service_role;
  end if;
end $$;
