-- 0016_settlement_and_reversal.sql
-- Architecture V2 change plan §8.3 (settlement) + §8.1 (reversals). Three atomic
-- RPCs that REUSE post_manual_journal (0015) so all posting rules are enforced once.
-- All are human-initiated (permission-checked server actions); the LLM never calls
-- them. Recording a settlement is NOT executing a bank payment — it records money
-- already moved. Forward-only, idempotent (create or replace).

-- Receipt against a customer invoice: Dr Cash, Cr Receivables; record the payment
-- and advance the invoice's settled amount/status. Returns the settlement journal id.
create or replace function public.settle_customer_invoice(
  p_company uuid, p_invoice uuid, p_amount numeric, p_cash_code text, p_ar_code text, p_by uuid, p_date date
) returns uuid
language plpgsql as $$
declare
  v_currency text; v_total numeric; v_settled numeric; v_customer uuid; v_number text;
  v_journal uuid; v_lines jsonb; v_new_settled numeric; v_status text;
begin
  select currency, total_amount, coalesce(amount_settled, 0), customer_id, invoice_number
    into v_currency, v_total, v_settled, v_customer, v_number
  from customer_invoices where id = p_invoice and company_id = p_company;
  if v_currency is null then raise exception 'Invoice not found'; end if;
  if p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if round(p_amount, 2) > round(v_total - v_settled, 2) then
    raise exception 'Amount exceeds outstanding %', (v_total - v_settled);
  end if;

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

-- Payment against a supplier bill: Dr Payables, Cr Cash; record the payment and
-- advance the bill's settled amount/status. Recording only, not a bank transfer.
create or replace function public.settle_supplier_bill(
  p_company uuid, p_bill uuid, p_amount numeric, p_ap_code text, p_cash_code text, p_by uuid, p_date date
) returns uuid
language plpgsql as $$
declare
  v_currency text; v_total numeric; v_settled numeric; v_supplier uuid; v_number text;
  v_journal uuid; v_lines jsonb; v_new_settled numeric; v_status text;
begin
  select currency, total_amount, coalesce(amount_settled, 0), supplier_id, bill_number
    into v_currency, v_total, v_settled, v_supplier, v_number
  from supplier_bills where id = p_bill and company_id = p_company;
  if v_currency is null then raise exception 'Bill not found'; end if;
  if p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if round(p_amount, 2) > round(v_total - v_settled, 2) then
    raise exception 'Amount exceeds outstanding %', (v_total - v_settled);
  end if;

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

-- Reverse a posted journal: post a mirror (debit/credit swapped) and mark the
-- original reversed. Corrections never edit a posted journal (§8.1).
create or replace function public.reverse_journal(
  p_company uuid, p_journal uuid, p_by uuid, p_date date
) returns uuid
language plpgsql as $$
declare v_currency text; v_status text; v_lines jsonb; v_rev uuid;
begin
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
