-- 0052_wp15_invoice_bill_invariants.sql
-- Correction brief 0048 — WP15: enforce invoice and bill document invariants.
--
-- Problems in post_customer_invoice / post_supplier_bill (0044):
--   1. the header-vs-line total check ran only `when v_line_total > 0`, so a positive HEADER with
--      NO detail lines (line total 0) posted a journal with no source lines;
--   2. an existing journal_id was returned before confirming it is THIS document's journal
--      (a mismatched/cross-company link was blindly returned as idempotent success).
--
-- Fix (both RPCs):
--   * idempotent return only after verifying the linked journal exists in this company AND its
--     idempotency_key equals this document's posting key AND the document lifecycle is consistent;
--   * a new post requires >= 1 source line, a positive header, header = line total (unconditional),
--     and no negative line amount; journal + document update + audit stay in one transaction;
--   * nothing is marked issued/approved if any invariant fails.
--
-- Forward-only; CREATE OR REPLACE of two RPCs. No data change.

create or replace function public.post_customer_invoice(p_company uuid, p_invoice uuid, p_receivable_code text, p_income_code text, p_by uuid, p_date date, p_idempotency_key text default null)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare v_actor uuid; v_type text; v_currency text; v_total numeric; v_number text; v_journal uuid;
        v_existing uuid; v_status text; v_line_total numeric; v_line_count int; v_lines jsonb; v_key text; v_jkey text;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type='user' and not public.has_capability(p_company,'finance.invoice.post') then raise exception 'missing capability finance.invoice.post'; end if;
  select currency, total_amount, invoice_number, journal_id, status into v_currency, v_total, v_number, v_existing, v_status
  from customer_invoices where id=p_invoice and company_id=p_company for update;
  if v_currency is null then raise exception 'Invoice not found'; end if;
  v_key := coalesce(p_idempotency_key, 'invoice_post:'||p_invoice);

  if v_existing is not null then
    -- Idempotent, but only after confirming the linked journal is THIS invoice's journal.
    select idempotency_key into v_jkey from journal_entries where id=v_existing and company_id=p_company;
    if v_jkey is null then raise exception 'Invoice journal % is missing or cross-company (mismatched link)', v_existing; end if;
    if v_jkey <> v_key then raise exception 'Invoice journal binding mismatch — refusing to return an unrelated journal'; end if;
    if v_status <> 'issued' then raise exception 'Invoice lifecycle inconsistent: journal set but status is %', v_status; end if;
    return v_existing;
  end if;

  if v_status <> 'draft' then raise exception 'Invoice cannot be posted from status % (only draft)', v_status; end if;

  select coalesce(sum(amount),0), count(*) into v_line_total, v_line_count
  from customer_invoice_lines where invoice_id=p_invoice and company_id=p_company;
  if v_line_count = 0 then raise exception 'Invoice has no source-document lines'; end if;
  if exists (select 1 from customer_invoice_lines where invoice_id=p_invoice and company_id=p_company and amount < 0) then
    raise exception 'Invoice has a negative line amount';
  end if;
  if round(v_total,2) <= 0 then raise exception 'Invoice header total must be positive (is %)', v_total; end if;
  if round(v_line_total,2) <> round(v_total,2) then raise exception 'Invoice header total % <> line total %', v_total, v_line_total; end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_code',p_receivable_code,'debit',v_total,'credit',0,'description','Invoice '||v_number),
    jsonb_build_object('account_code',p_income_code,'debit',0,'credit',v_total,'description','Invoice '||v_number));
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Customer invoice '||v_number, v_actor, v_type, v_lines, v_key, 'customer_invoice.post', 'customer_invoice', p_invoice);
  update customer_invoices set journal_id=v_journal, status='issued' where id=p_invoice and company_id=p_company;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, v_type, v_actor, 'customer_invoice.posted','customer_invoice',p_invoice, jsonb_build_object('journal_id',v_journal));
  return v_journal;
end $function$;

create or replace function public.post_supplier_bill(p_company uuid, p_bill uuid, p_expense_code text, p_payable_code text, p_by uuid, p_date date, p_idempotency_key text default null)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare v_actor uuid; v_type text; v_currency text; v_total numeric; v_number text; v_journal uuid;
        v_existing uuid; v_status text; v_line_total numeric; v_line_count int; v_lines jsonb; v_key text; v_jkey text;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type='user' and not public.has_capability(p_company,'finance.bill.post') then raise exception 'missing capability finance.bill.post'; end if;
  select currency, total_amount, bill_number, journal_id, status into v_currency, v_total, v_number, v_existing, v_status
  from supplier_bills where id=p_bill and company_id=p_company for update;
  if v_currency is null then raise exception 'Bill not found'; end if;
  v_key := coalesce(p_idempotency_key, 'bill_post:'||p_bill);

  if v_existing is not null then
    select idempotency_key into v_jkey from journal_entries where id=v_existing and company_id=p_company;
    if v_jkey is null then raise exception 'Bill journal % is missing or cross-company (mismatched link)', v_existing; end if;
    if v_jkey <> v_key then raise exception 'Bill journal binding mismatch — refusing to return an unrelated journal'; end if;
    if v_status <> 'approved' then raise exception 'Bill lifecycle inconsistent: journal set but status is %', v_status; end if;
    return v_existing;
  end if;

  if v_status <> 'draft' then raise exception 'Bill cannot be posted from status % (only draft)', v_status; end if;

  select coalesce(sum(amount),0), count(*) into v_line_total, v_line_count
  from supplier_bill_lines where bill_id=p_bill and company_id=p_company;
  if v_line_count = 0 then raise exception 'Bill has no source-document lines'; end if;
  if exists (select 1 from supplier_bill_lines where bill_id=p_bill and company_id=p_company and amount < 0) then
    raise exception 'Bill has a negative line amount';
  end if;
  if round(v_total,2) <= 0 then raise exception 'Bill header total must be positive (is %)', v_total; end if;
  if round(v_line_total,2) <> round(v_total,2) then raise exception 'Bill header total % <> line total %', v_total, v_line_total; end if;

  v_lines := jsonb_build_array(
    jsonb_build_object('account_code',p_expense_code,'debit',v_total,'credit',0,'description','Bill '||coalesce(v_number,'')),
    jsonb_build_object('account_code',p_payable_code,'debit',0,'credit',v_total,'description','Bill '||coalesce(v_number,'')));
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Supplier bill '||coalesce(v_number,''), v_actor, v_type, v_lines, v_key, 'supplier_bill.post', 'supplier_bill', p_bill);
  update supplier_bills set journal_id=v_journal, status='approved' where id=p_bill and company_id=p_company;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, v_type, v_actor, 'supplier_bill.posted','supplier_bill',p_bill, jsonb_build_object('journal_id',v_journal));
  return v_journal;
end $function$;
