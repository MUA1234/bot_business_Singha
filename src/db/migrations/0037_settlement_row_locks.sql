-- 0037_settlement_row_locks.sql
-- WP2 (§2 "lock the source record"; required tests "concurrent settlement / reversal").
-- The settlement and reversal RPCs read the source document then update it. Without a
-- row lock, two concurrent settlements could BOTH read amount_settled=0, both pass the
-- outstanding check, and over-settle. This adds `FOR UPDATE` on the source select so
-- concurrent callers serialise: the second waits for the first, then sees the updated
-- amount and is correctly rejected. Preserves the 0035 (SECURITY DEFINER + guard)
-- behaviour otherwise. FORWARD-ONLY, IDEMPOTENT.

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
  from customer_invoices where id = p_invoice and company_id = p_company
  for update;                                            -- lock the source row
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
  from supplier_bills where id = p_bill and company_id = p_company
  for update;
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
  select currency, status into v_currency, v_status from journal_entries where id = p_journal and company_id = p_company
  for update;                                            -- lock so a double-reverse serialises
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
