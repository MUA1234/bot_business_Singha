-- 0056_wp15_source_binding_fingerprint.sql
-- Phase 1 external-review correction B — WP15: the existing-journal path validated only company,
-- idempotency_key and lifecycle, so a caller could retry the SAME document + key with a changed
-- posting date or account codes and receive a FALSE idempotent success; and a corrupt second
-- document linked to the first document's journal passed if it reused the same custom key. A
-- matching key alone is never proof of source binding.
--
-- Fix (CREATE OR REPLACE; no data change): on the existing-journal path of post_customer_invoice /
-- post_supplier_bill, recompute the canonical fingerprint this exact posting WOULD produce
-- (operation + company + source type + source id + date + currency + memo + derived journal lines)
-- and return the linked journal ONLY when that fingerprint matches the stored journal's fingerprint
-- (version-aware: v3 / v2 / legacy-NULL) AND the linked journal id is the document's own journal.
-- The source-line invariants (>=1 line, no negative line, positive header, header = line total) are
-- validated on BOTH the fresh and existing paths, so an altered source on retry conflicts and
-- mutates nothing. Posted-journal immutability (WP13) and v2/legacy compatibility (WP14) preserved.
--
-- Forward-only.

-- Version-aware fingerprint match for an already-linked journal (mirrors _journal_post_internal's
-- reuse comparison so invoice/bill retries are bound to the exact source operation, not just a key).
create or replace function public._journal_fp_matches(
  p_journal uuid, p_operation text, p_company uuid, p_source_type text, p_source_id uuid,
  p_date date, p_currency text, p_memo text, p_lines jsonb
) returns boolean language plpgsql stable security definer set search_path = public, extensions as $$
declare v_fp text; v_old_date date; v_old_ccy text; v_old_memo text; v_old_lines jsonb;
begin
  select idem_fingerprint into v_fp from journal_entries where id = p_journal and company_id = p_company;
  if not found then return false; end if;
  if v_fp is null then
    -- Legacy NULL fingerprint: reconstruct the stored journal and compare canonically.
    select posting_date, currency, memo into v_old_date, v_old_ccy, v_old_memo from journal_entries where id = p_journal;
    select jsonb_agg(jsonb_build_object('account_code',account_code,'debit',debit,'credit',credit,'description',description) order by line_no)
      into v_old_lines from journal_lines where journal_id = p_journal;
    return public._fp_recon(v_old_date, v_old_ccy, v_old_memo, v_old_lines)
             is not distinct from public._fp_recon(p_date, p_currency, p_memo, p_lines);
  elsif left(v_fp, 3) = 'v2:' then
    return v_fp = public._fp_full(p_operation, p_company, p_source_type, p_source_id, p_date, p_currency, p_memo, p_lines);
  else
    return v_fp = public._fp_full_v3(p_operation, p_company, p_source_type, p_source_id, p_date, p_currency, p_memo, p_lines);
  end if;
end $$;

create or replace function public.post_customer_invoice(p_company uuid, p_invoice uuid, p_receivable_code text, p_income_code text, p_by uuid, p_date date, p_idempotency_key text default null)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare v_actor uuid; v_type text; v_currency text; v_total numeric; v_number text; v_journal uuid;
        v_existing uuid; v_status text; v_line_total numeric; v_line_count int; v_lines jsonb; v_key text; v_jkey text; v_memo text;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type='user' and not public.has_capability(p_company,'finance.invoice.post') then raise exception 'missing capability finance.invoice.post'; end if;
  select currency, total_amount, invoice_number, journal_id, status into v_currency, v_total, v_number, v_existing, v_status
  from customer_invoices where id=p_invoice and company_id=p_company for update;
  if v_currency is null then raise exception 'Invoice not found'; end if;
  v_key := coalesce(p_idempotency_key, 'invoice_post:'||p_invoice);
  v_memo := 'Customer invoice '||v_number;   -- journal memo (as 0052/_journal_post_internal); the
                                             -- line descriptions below keep their original text.

  -- Source invariants — validated on BOTH paths (an altered source on retry conflicts, no mutation).
  select coalesce(sum(amount),0), count(*) into v_line_total, v_line_count
  from customer_invoice_lines where invoice_id=p_invoice and company_id=p_company;
  if v_line_count = 0 then raise exception 'Invoice has no source-document lines'; end if;
  if exists (select 1 from customer_invoice_lines where invoice_id=p_invoice and company_id=p_company and amount < 0) then
    raise exception 'Invoice has a negative line amount';
  end if;
  if round(v_total,2) <= 0 then raise exception 'Invoice header total must be positive (is %)', v_total; end if;
  if round(v_line_total,2) <> round(v_total,2) then raise exception 'Invoice header total % <> line total %', v_total, v_line_total; end if;

  -- The derived journal lines this posting produces (unchanged from 0052 — used both to
  -- fingerprint-check a retry and to post). Line descriptions keep their original 'Invoice N' text.
  v_lines := jsonb_build_array(
    jsonb_build_object('account_code',p_receivable_code,'debit',v_total,'credit',0,'description','Invoice '||v_number),
    jsonb_build_object('account_code',p_income_code,'debit',0,'credit',v_total,'description','Invoice '||v_number));

  if v_existing is not null then
    -- Idempotent return ONLY when the linked journal is this invoice's journal AND its canonical
    -- fingerprint matches THIS exact operation. A matching key alone is not proof of source binding.
    select idempotency_key into v_jkey from journal_entries where id=v_existing and company_id=p_company;
    if v_jkey is null then raise exception 'Invoice journal % is missing or cross-company (mismatched link)', v_existing; end if;
    if v_jkey <> v_key then raise exception 'Invoice journal binding mismatch — refusing to return an unrelated journal'; end if;
    if v_status <> 'issued' then raise exception 'Invoice lifecycle inconsistent: journal set but status is %', v_status; end if;
    if not public._journal_fp_matches(v_existing, 'customer_invoice.post', p_company, 'customer_invoice', p_invoice, p_date, v_currency, v_memo, v_lines) then
      raise exception 'Invoice retry conflict: posting differs from the linked journal (date, accounts or lines changed)';
    end if;
    return v_existing;
  end if;

  if v_status <> 'draft' then raise exception 'Invoice cannot be posted from status % (only draft)', v_status; end if;

  v_journal := public._journal_post_internal(p_company, p_date, v_currency, v_memo, v_actor, v_type, v_lines, v_key, 'customer_invoice.post', 'customer_invoice', p_invoice);
  update customer_invoices set journal_id=v_journal, status='issued' where id=p_invoice and company_id=p_company;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, v_type, v_actor, 'customer_invoice.posted','customer_invoice',p_invoice, jsonb_build_object('journal_id',v_journal));
  return v_journal;
end $function$;

create or replace function public.post_supplier_bill(p_company uuid, p_bill uuid, p_expense_code text, p_payable_code text, p_by uuid, p_date date, p_idempotency_key text default null)
returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare v_actor uuid; v_type text; v_currency text; v_total numeric; v_number text; v_journal uuid;
        v_existing uuid; v_status text; v_line_total numeric; v_line_count int; v_lines jsonb; v_key text; v_jkey text; v_memo text;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type='user' and not public.has_capability(p_company,'finance.bill.post') then raise exception 'missing capability finance.bill.post'; end if;
  select currency, total_amount, bill_number, journal_id, status into v_currency, v_total, v_number, v_existing, v_status
  from supplier_bills where id=p_bill and company_id=p_company for update;
  if v_currency is null then raise exception 'Bill not found'; end if;
  v_key := coalesce(p_idempotency_key, 'bill_post:'||p_bill);
  v_memo := 'Supplier bill '||coalesce(v_number,'');   -- journal memo (as 0052/_journal_post_internal).

  select coalesce(sum(amount),0), count(*) into v_line_total, v_line_count
  from supplier_bill_lines where bill_id=p_bill and company_id=p_company;
  if v_line_count = 0 then raise exception 'Bill has no source-document lines'; end if;
  if exists (select 1 from supplier_bill_lines where bill_id=p_bill and company_id=p_company and amount < 0) then
    raise exception 'Bill has a negative line amount';
  end if;
  if round(v_total,2) <= 0 then raise exception 'Bill header total must be positive (is %)', v_total; end if;
  if round(v_line_total,2) <> round(v_total,2) then raise exception 'Bill header total % <> line total %', v_total, v_line_total; end if;

  -- Line descriptions keep their original 'Bill N' text (unchanged from 0052).
  v_lines := jsonb_build_array(
    jsonb_build_object('account_code',p_expense_code,'debit',v_total,'credit',0,'description','Bill '||coalesce(v_number,'')),
    jsonb_build_object('account_code',p_payable_code,'debit',0,'credit',v_total,'description','Bill '||coalesce(v_number,'')));

  if v_existing is not null then
    select idempotency_key into v_jkey from journal_entries where id=v_existing and company_id=p_company;
    if v_jkey is null then raise exception 'Bill journal % is missing or cross-company (mismatched link)', v_existing; end if;
    if v_jkey <> v_key then raise exception 'Bill journal binding mismatch — refusing to return an unrelated journal'; end if;
    if v_status <> 'approved' then raise exception 'Bill lifecycle inconsistent: journal set but status is %', v_status; end if;
    if not public._journal_fp_matches(v_existing, 'supplier_bill.post', p_company, 'supplier_bill', p_bill, p_date, v_currency, v_memo, v_lines) then
      raise exception 'Bill retry conflict: posting differs from the linked journal (date, accounts or lines changed)';
    end if;
    return v_existing;
  end if;

  if v_status <> 'draft' then raise exception 'Bill cannot be posted from status % (only draft)', v_status; end if;

  v_journal := public._journal_post_internal(p_company, p_date, v_currency, v_memo, v_actor, v_type, v_lines, v_key, 'supplier_bill.post', 'supplier_bill', p_bill);
  update supplier_bills set journal_id=v_journal, status='approved' where id=p_bill and company_id=p_company;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, v_type, v_actor, 'supplier_bill.posted','supplier_bill',p_bill, jsonb_build_object('journal_id',v_journal));
  return v_journal;
end $function$;
