-- 0043_transactional_finance.sql
-- Production Security & Reliability Gate — WP B follow-up (review findings).
--   1. FULL-PAYLOAD idempotency: a reused key with the same total but DIFFERENT lines is a
--      conflict (previously only the total was compared). journal_entries gains payload_hash.
--   2. Invoice posting, bill posting and reimbursement become SINGLE-TRANSACTION RPCs
--      (journal + source-document update + audit commit or roll back together) — replacing
--      the app's post-then-separately-update pattern. Each enforces its own capability,
--      derives the actor from auth.uid(), locks the source row, and is idempotent.
--
-- FORWARD-ONLY, IDEMPOTENT. RECORDS accounting events; never moves money.

alter table journal_entries add column if not exists payload_hash text;

-- ── Internal poster: now also stores + compares a hash of the COMPLETE lines payload ──
create or replace function public._journal_post_internal(
  p_company uuid, p_date date, p_currency text, p_memo text, p_actor uuid, p_lines jsonb, p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_total_debit numeric := 0; v_total_credit numeric := 0; v_line jsonb; v_journal_id uuid;
  v_existing uuid; v_existing_total numeric; v_existing_hash text; v_hash text;
  v_period_id uuid; v_period_status text; v_line_no int := 0; v_debit numeric; v_credit numeric; v_code text;
begin
  if p_lines is null or jsonb_array_length(p_lines) < 2 then raise exception 'A journal needs at least two lines'; end if;

  select id, status into v_period_id, v_period_status
  from accounting_periods where company_id = p_company and p_date between start_date and end_date
  order by start_date desc limit 1;
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
    v_total_debit := v_total_debit + v_debit; v_total_credit := v_total_credit + v_credit;
  end loop;

  if round(v_total_debit, 2) <> round(v_total_credit, 2) then raise exception 'Journal is unbalanced: debit % <> credit %', v_total_debit, v_total_credit; end if;
  if round(v_total_debit, 2) = 0 then raise exception 'A zero-value journal is not allowed'; end if;

  v_hash := md5(p_lines::text);  -- hash of the COMPLETE lines payload

  if p_idempotency_key is not null then
    select id, total_debit, payload_hash into v_existing, v_existing_total, v_existing_hash
    from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key;
    if v_existing is not null then
      if round(v_existing_total, 2) <> round(v_total_debit, 2) or v_existing_hash is distinct from v_hash then
        raise exception 'idempotency key reused with a different payload (conflict)';
      end if;
      return v_existing;
    end if;
  end if;

  begin
    insert into journal_entries (
      company_id, period_id, posting_date, currency, exchange_rate, memo, status,
      correlation_id, idempotency_key, payload_hash, total_debit, total_credit, posted_at, posted_by, created_by
    ) values (
      p_company, v_period_id, p_date, p_currency, 1, p_memo, 'posted',
      'corr_' || gen_random_uuid(), coalesce(p_idempotency_key, 'jm_' || gen_random_uuid()), v_hash,
      round(v_total_debit, 2), round(v_total_credit, 2), now(), p_actor, p_actor
    ) returning id into v_journal_id;
  exception when unique_violation then
    if p_idempotency_key is not null then
      select id, total_debit, payload_hash into v_journal_id, v_existing_total, v_existing_hash
      from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key;
      if v_journal_id is not null then
        if round(v_existing_total, 2) <> round(v_total_debit, 2) or v_existing_hash is distinct from v_hash then
          raise exception 'idempotency key reused with a different payload (conflict)';
        end if;
        return v_journal_id;
      end if;
    end if;
    raise;
  end;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_line_no := v_line_no + 1;
    insert into journal_lines (journal_id, company_id, account_code, debit, credit, description, line_no)
    values (v_journal_id, p_company, v_line->>'account_code',
      round(coalesce((v_line->>'debit')::numeric, 0), 2), round(coalesce((v_line->>'credit')::numeric, 0), 2),
      v_line->>'description', v_line_no);
  end loop;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, 'user', p_actor, 'journal.posted', 'journal', v_journal_id,
          jsonb_build_object('total', round(v_total_debit, 2), 'memo', p_memo), p_idempotency_key);
  return v_journal_id;
end $$;

-- ── Post a customer invoice: one transaction (capability + lock + journal + status + audit) ──
create or replace function public.post_customer_invoice(
  p_company uuid, p_invoice uuid, p_receivable_code text, p_income_code text, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_currency text; v_total numeric; v_number text; v_journal uuid; v_existing uuid; v_lines jsonb;
begin
  if public.caller_jwt_role() = 'anon' then raise exception 'anonymous callers cannot post invoices'; end if;
  if auth.uid() is not null then
    if not public.has_capability(p_company, 'finance.invoice.post') then raise exception 'missing capability finance.invoice.post'; end if;
    v_actor := auth.uid();
  else v_actor := p_by; end if;

  select currency, total_amount, invoice_number, journal_id into v_currency, v_total, v_number, v_existing
  from customer_invoices where id = p_invoice and company_id = p_company for update;
  if v_currency is null then raise exception 'Invoice not found'; end if;
  if v_existing is not null then return v_existing; end if;  -- already posted → idempotent

  v_lines := jsonb_build_array(
    jsonb_build_object('account_code', p_receivable_code, 'debit', v_total, 'credit', 0, 'description', 'Invoice ' || v_number),
    jsonb_build_object('account_code', p_income_code, 'debit', 0, 'credit', v_total, 'description', 'Invoice ' || v_number)
  );
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Customer invoice ' || v_number, v_actor, v_lines, coalesce(p_idempotency_key, 'invoice_post:' || p_invoice));
  update customer_invoices set journal_id = v_journal, status = 'issued' where id = p_invoice and company_id = p_company;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, 'user', v_actor, 'customer_invoice.posted', 'customer_invoice', p_invoice, jsonb_build_object('journal_id', v_journal));
  return v_journal;
end $$;

-- ── Post a supplier bill: one transaction ──
create or replace function public.post_supplier_bill(
  p_company uuid, p_bill uuid, p_expense_code text, p_payable_code text, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_currency text; v_total numeric; v_number text; v_journal uuid; v_existing uuid; v_lines jsonb;
begin
  if public.caller_jwt_role() = 'anon' then raise exception 'anonymous callers cannot post bills'; end if;
  if auth.uid() is not null then
    if not public.has_capability(p_company, 'finance.bill.post') then raise exception 'missing capability finance.bill.post'; end if;
    v_actor := auth.uid();
  else v_actor := p_by; end if;

  select currency, total_amount, bill_number, journal_id into v_currency, v_total, v_number, v_existing
  from supplier_bills where id = p_bill and company_id = p_company for update;
  if v_currency is null then raise exception 'Bill not found'; end if;
  if v_existing is not null then return v_existing; end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_code', p_expense_code, 'debit', v_total, 'credit', 0, 'description', 'Bill ' || coalesce(v_number,'')),
    jsonb_build_object('account_code', p_payable_code, 'debit', 0, 'credit', v_total, 'description', 'Bill ' || coalesce(v_number,''))
  );
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Supplier bill ' || coalesce(v_number,''), v_actor, v_lines, coalesce(p_idempotency_key, 'bill_post:' || p_bill));
  update supplier_bills set journal_id = v_journal, status = 'approved' where id = p_bill and company_id = p_company;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, 'user', v_actor, 'supplier_bill.posted', 'supplier_bill', p_bill, jsonb_build_object('journal_id', v_journal));
  return v_journal;
end $$;

-- ── Reimburse an approved expense claim: one transaction, SoD + lifecycle enforced ──
create or replace function public.reimburse_expense_claim(
  p_company uuid, p_claim uuid, p_expense_code text, p_cash_code text, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_currency text; v_amount numeric; v_status text; v_employee uuid; v_claimant uuid; v_journal uuid; v_lines jsonb; v_existing uuid;
begin
  if public.caller_jwt_role() = 'anon' then raise exception 'anonymous callers cannot reimburse'; end if;
  if auth.uid() is not null then
    if not public.has_capability(p_company, 'finance.payment.record') then raise exception 'missing capability finance.payment.record'; end if;
    v_actor := auth.uid();
  else v_actor := p_by; end if;

  select currency, amount, status, employee_id into v_currency, v_amount, v_status, v_employee
  from expense_claims where id = p_claim and company_id = p_company for update;
  if v_currency is null then raise exception 'Claim not found'; end if;
  if v_status = 'reimbursed' then
    select journal_id into v_existing from payments p join reimbursements r on r.payment_id = p.id where r.expense_claim_id = p_claim and r.company_id = p_company limit 1;
    return v_existing;  -- already reimbursed → idempotent (journal may be null if legacy)
  end if;
  if v_status <> 'approved' then raise exception 'Only an approved claim can be reimbursed (is %)', v_status; end if;

  -- Separation of duties: you cannot reimburse your OWN claim.
  select user_id into v_claimant from employees where id = v_employee and company_id = p_company;
  if v_claimant is not null and v_claimant = v_actor then raise exception 'cannot reimburse your own expense claim'; end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_code', p_expense_code, 'debit', v_amount, 'credit', 0, 'description', 'Expense reimbursement'),
    jsonb_build_object('account_code', p_cash_code, 'debit', 0, 'credit', v_amount, 'description', 'Expense reimbursement')
  );
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Expense reimbursement', v_actor, v_lines, coalesce(p_idempotency_key, 'reimburse:' || p_claim));

  insert into payments (company_id, direction, party_type, party_id, currency, amount, method, payment_date, journal_id, status, idempotency_key)
  values (p_company, 'out', 'employee', v_employee, v_currency, round(v_amount,2), 'record', p_date, v_journal, 'recorded', coalesce(p_idempotency_key, 'reimburse:' || p_claim))
  on conflict (company_id, idempotency_key) do nothing;
  insert into reimbursements (company_id, expense_claim_id, employee_id, currency, amount, status, payment_id)
  values (p_company, p_claim, v_employee, v_currency, round(v_amount,2), 'paid',
          (select id from payments where company_id = p_company and idempotency_key = coalesce(p_idempotency_key, 'reimburse:' || p_claim)));
  update expense_claims set status = 'reimbursed' where id = p_claim and company_id = p_company;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, 'user', v_actor, 'expense_claim.reimbursed', 'expense_claim', p_claim, jsonb_build_object('journal_id', v_journal));
  return v_journal;
end $$;

-- ── Grants ──
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.post_customer_invoice(uuid,uuid,text,text,uuid,date,text) from public;
    revoke all on function public.post_supplier_bill(uuid,uuid,text,text,uuid,date,text) from public;
    revoke all on function public.reimburse_expense_claim(uuid,uuid,text,text,uuid,date,text) from public;
    grant execute on function public.post_customer_invoice(uuid,uuid,text,text,uuid,date,text) to authenticated, service_role;
    grant execute on function public.post_supplier_bill(uuid,uuid,text,text,uuid,date,text) to authenticated, service_role;
    grant execute on function public.reimburse_expense_claim(uuid,uuid,text,text,uuid,date,text) to authenticated, service_role;
  end if;
end $$;
