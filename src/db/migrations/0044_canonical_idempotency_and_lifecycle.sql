-- 0044_canonical_idempotency_and_lifecycle.sql
-- Correction phase — WP3 (canonical idempotency), WP4 (document lifecycle) and the SQL
-- half of WP2 (actor from auth.uid, reject p_by mismatch, system-actor path).
--
--   * Idempotency fingerprint is now a VERSIONED, canonical SHA-256 binding the whole
--     operation: operation name, company, source entity type+id, posting date, uppercase
--     currency, normalized memo and normalized ORDERED journal lines (account/debit/
--     credit/description). Stored in journal_entries.idem_fingerprint.
--   * Legacy pre-0044 rows (idem_fingerprint NULL): an identical retry is accepted ONLY
--     after locking the journal and comparing every reconstructable field + lines, then
--     the row is upgraded to the canonical fingerprint. Never accepted on total alone.
--   * Reimbursement binds the key to the expense claim (source), so one key can never
--     attach a second claim to another claim's journal/payment.
--   * post_customer_invoice / post_supplier_bill enforce the document LIFECYCLE (only a
--     'draft' may post; cancelled/void/etc rejected) and verify header total = line total.
--   * Every user-triggered RPC derives the actor from auth.uid() and REJECTS a p_by that
--     disagrees; a no-JWT service/worker call is recorded as actor_type='system'.
--
-- All callers of the internal poster are updated in this migration; the obsolete 7-arg
-- internal is dropped. FORWARD-ONLY, IDEMPOTENT.

alter table journal_entries add column if not exists idem_fingerprint text;

-- Extend the posted-journal immutability guard to ALSO permit a one-time upgrade of
-- idempotency METADATA (idem_fingerprint / payload_hash) on a posted journal, with every
-- accounting field unchanged. This is bookkeeping metadata, never posted amounts, and is
-- required so a legacy null-fingerprint row can be safely upgraded on an identical retry.
create or replace function public.block_posted_mutation()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'DELETE') then
    if old.status = 'posted' then raise exception 'Posted journal % is immutable and cannot be deleted', old.id; end if;
    return old;
  end if;
  if old.status = 'posted' then
    -- #1: mark the original as reversed (amounts unchanged).
    if new.status = 'reversed' and new.total_debit = old.total_debit and new.total_credit = old.total_credit
       and new.currency = old.currency and new.posting_date = old.posting_date then return new; end if;
    -- #2: link a reversing entry to its original (set once).
    if new.status = old.status and old.reversal_of_journal_id is null and new.reversal_of_journal_id is not null
       and new.total_debit = old.total_debit and new.total_credit = old.total_credit
       and new.currency = old.currency and new.posting_date = old.posting_date then return new; end if;
    -- #3: upgrade idempotency metadata only — every accounting field unchanged.
    if new.status = old.status
       and new.total_debit = old.total_debit and new.total_credit = old.total_credit
       and new.currency = old.currency and new.posting_date = old.posting_date
       and new.memo is not distinct from old.memo and new.posted_by is not distinct from old.posted_by
       and new.reversal_of_journal_id is not distinct from old.reversal_of_journal_id then return new; end if;
    raise exception 'Posted journal % is immutable (attempted mutation)', old.id;
  end if;
  new.updated_at := now(); new.version := old.version + 1; return new;
end;
$$;

-- ── Canonicalization helpers (deterministic; SHA-256 hex) ────────────────────
create or replace function public._fp_lines(p_lines jsonb)
returns text language sql immutable set search_path = public as $$
  -- Stable, order-independent line canonicalization (documented rule: sort the encoded
  -- lines). Debit/credit rounded to 2dp; missing description normalized to ''.
  select coalesce(string_agg(line, ';' order by line), '') from (
    select (l->>'account_code') || ',' ||
           round(coalesce((l->>'debit')::numeric, 0), 2) || ',' ||
           round(coalesce((l->>'credit')::numeric, 0), 2) || ',' ||
           coalesce(l->>'description', '') as line
    from jsonb_array_elements(p_lines) l
  ) s;
$$;

create or replace function public._fp_full(
  p_operation text, p_company uuid, p_source_type text, p_source_id uuid,
  p_date date, p_currency text, p_memo text, p_lines jsonb
) returns text language sql immutable set search_path = public as $$
  select 'v2:' || encode(digest(
    coalesce(p_operation,'') || '|' || p_company::text || '|' ||
    coalesce(p_source_type,'') || '|' || coalesce(p_source_id::text,'') || '|' ||
    p_date::text || '|' || upper(coalesce(p_currency,'')) || '|' ||
    coalesce(btrim(p_memo),'') || '|' || public._fp_lines(p_lines),
    'sha256'), 'hex');
$$;

-- Reconstructable subset (no operation/source) — used to compare a LEGACY journal.
create or replace function public._fp_recon(
  p_date date, p_currency text, p_memo text, p_lines jsonb
) returns text language sql immutable set search_path = public as $$
  select encode(digest(
    p_date::text || '|' || upper(coalesce(p_currency,'')) || '|' ||
    coalesce(btrim(p_memo),'') || '|' || public._fp_lines(p_lines),
    'sha256'), 'hex');
$$;

-- ── Internal poster (versioned signature: actor_type + operation + source) ────
drop function if exists public._journal_post_internal(uuid,date,text,text,uuid,jsonb,text);
create or replace function public._journal_post_internal(
  p_company uuid, p_date date, p_currency text, p_memo text, p_actor uuid, p_actor_type text,
  p_lines jsonb, p_idempotency_key text, p_operation text, p_source_type text, p_source_id uuid
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_total_debit numeric := 0; v_total_credit numeric := 0; v_line jsonb; v_journal_id uuid;
  v_existing uuid; v_existing_fp text; v_new_fp text; v_period_id uuid; v_period_status text;
  v_line_no int := 0; v_debit numeric; v_credit numeric; v_code text;
  v_old_date date; v_old_ccy text; v_old_memo text; v_old_lines jsonb;
begin
  if p_lines is null or jsonb_array_length(p_lines) < 2 then raise exception 'A journal needs at least two lines'; end if;

  select id, status into v_period_id, v_period_status
  from accounting_periods where company_id = p_company and p_date between start_date and end_date
  order by start_date desc limit 1;
  if v_period_status is not null and v_period_status in ('closed','locked') then
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
  if round(v_total_debit,2) <> round(v_total_credit,2) then raise exception 'Journal is unbalanced: debit % <> credit %', v_total_debit, v_total_credit; end if;
  if round(v_total_debit,2) = 0 then raise exception 'A zero-value journal is not allowed'; end if;

  v_new_fp := public._fp_full(p_operation, p_company, p_source_type, p_source_id, p_date, p_currency, p_memo, p_lines);

  if p_idempotency_key is not null then
    select id, idem_fingerprint into v_existing, v_existing_fp
    from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key for update;
    if v_existing is not null then
      if v_existing_fp is not null then
        -- Modern row: exact canonical fingerprint match or conflict.
        if v_existing_fp <> v_new_fp then raise exception 'idempotency key reused with a different operation (conflict)'; end if;
        return v_existing;
      else
        -- Legacy row: compare every RECONSTRUCTABLE field + lines, then upgrade.
        select posting_date, currency, memo into v_old_date, v_old_ccy, v_old_memo from journal_entries where id = v_existing;
        select jsonb_agg(jsonb_build_object('account_code',account_code,'debit',debit,'credit',credit,'description',description) order by line_no)
          into v_old_lines from journal_lines where journal_id = v_existing;
        if public._fp_recon(v_old_date, v_old_ccy, v_old_memo, v_old_lines) is distinct from public._fp_recon(p_date, p_currency, p_memo, p_lines) then
          raise exception 'idempotency key reused with a different operation (legacy conflict)';
        end if;
        update journal_entries set idem_fingerprint = v_new_fp where id = v_existing;
        return v_existing;
      end if;
    end if;
  end if;

  begin
    insert into journal_entries (
      company_id, period_id, posting_date, currency, exchange_rate, memo, status,
      correlation_id, idempotency_key, payload_hash, idem_fingerprint, total_debit, total_credit, posted_at, posted_by, created_by
    ) values (
      p_company, v_period_id, p_date, p_currency, 1, p_memo, 'posted',
      'corr_' || gen_random_uuid(), coalesce(p_idempotency_key, 'jm_' || gen_random_uuid()), md5(p_lines::text), v_new_fp,
      round(v_total_debit,2), round(v_total_credit,2), now(), p_actor, p_actor
    ) returning id into v_journal_id;
  exception when unique_violation then
    if p_idempotency_key is not null then
      select id, idem_fingerprint into v_journal_id, v_existing_fp
      from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key;
      if v_journal_id is not null then
        if v_existing_fp is not null and v_existing_fp <> v_new_fp then raise exception 'idempotency key reused with a different operation (conflict)'; end if;
        return v_journal_id;
      end if;
    end if;
    raise;
  end;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_line_no := v_line_no + 1;
    insert into journal_lines (journal_id, company_id, account_code, debit, credit, description, line_no)
    values (v_journal_id, p_company, v_line->>'account_code',
      round(coalesce((v_line->>'debit')::numeric,0),2), round(coalesce((v_line->>'credit')::numeric,0),2),
      v_line->>'description', v_line_no);
  end loop;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, coalesce(p_actor_type,'user'), p_actor, 'journal.posted', 'journal', v_journal_id,
          jsonb_build_object('total', round(v_total_debit,2), 'memo', p_memo, 'operation', p_operation), p_idempotency_key);
  return v_journal_id;
end $$;

-- ── Shared actor derivation: returns (actor, actor_type); rejects anon + p_by mismatch ──
create or replace function public._resolve_actor(p_by uuid, out v_actor uuid, out v_type text)
language plpgsql stable set search_path = public as $$
begin
  if public.caller_jwt_role() = 'anon' then raise exception 'anonymous callers are not allowed'; end if;
  if auth.uid() is not null then
    if p_by is not null and p_by <> auth.uid() then raise exception 'actor mismatch: p_by does not match the authenticated user'; end if;
    v_actor := auth.uid(); v_type := 'user';
  else
    v_actor := p_by; v_type := 'system';   -- no JWT → trusted service/worker path
  end if;
end $$;

-- ── post_manual_journal ──
create or replace function public.post_manual_journal(
  p_company uuid, p_date date, p_currency text, p_memo text, p_posted_by uuid, p_lines jsonb, p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_posted_by) a;
  if v_type = 'user' and not public.has_capability(p_company, 'finance.journal.post') then raise exception 'missing capability finance.journal.post'; end if;
  return public._journal_post_internal(p_company, p_date, p_currency, p_memo, v_actor, v_type, p_lines, p_idempotency_key, 'journal.manual_post', null, null);
end $$;

-- ── settle_customer_invoice ──
create or replace function public.settle_customer_invoice(
  p_company uuid, p_invoice uuid, p_amount numeric, p_cash_code text, p_ar_code text, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text; v_currency text; v_total numeric; v_settled numeric; v_customer uuid; v_number text; v_journal uuid; v_lines jsonb; v_new_settled numeric; v_status text; v_idem text; v_ins int;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type='user' and not public.has_capability(p_company,'finance.receipt.record') then raise exception 'missing capability finance.receipt.record'; end if;
  select currency, total_amount, coalesce(amount_settled,0), customer_id, invoice_number into v_currency, v_total, v_settled, v_customer, v_number
  from customer_invoices where id=p_invoice and company_id=p_company for update;
  if v_currency is null then raise exception 'Invoice not found'; end if;
  if p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if round(p_amount,2) > round(v_total - v_settled,2) then raise exception 'Amount exceeds outstanding %', (v_total - v_settled); end if;
  v_idem := coalesce(p_idempotency_key, 'settle_ci:'||p_invoice||':'||round(p_amount,2)||':'||p_date);
  v_lines := jsonb_build_array(
    jsonb_build_object('account_code',p_cash_code,'debit',p_amount,'credit',0,'description','Receipt '||v_number),
    jsonb_build_object('account_code',p_ar_code,'debit',0,'credit',p_amount,'description','Receipt '||v_number));
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Receipt for '||v_number, v_actor, v_type, v_lines, v_idem, 'customer_invoice.settle', 'customer_invoice', p_invoice);
  insert into payments (company_id, direction, party_type, party_id, currency, amount, method, payment_date, journal_id, status, idempotency_key)
  values (p_company,'in','customer',v_customer,v_currency,round(p_amount,2),'record',p_date,v_journal,'recorded',v_idem)
  on conflict (company_id, idempotency_key) do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then return v_journal; end if;
  v_new_settled := v_settled + round(p_amount,2);
  v_status := case when round(v_new_settled,2) >= round(v_total,2) then 'paid' else 'part_paid' end;
  update customer_invoices set amount_settled=v_new_settled, status=v_status where id=p_invoice and company_id=p_company;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, v_type, v_actor, 'customer_invoice.receipt_recorded','customer_invoice',p_invoice, jsonb_build_object('amount',round(p_amount,2),'journal_id',v_journal), v_idem);
  return v_journal;
end $$;

-- ── settle_supplier_bill ──
create or replace function public.settle_supplier_bill(
  p_company uuid, p_bill uuid, p_amount numeric, p_ap_code text, p_cash_code text, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text; v_currency text; v_total numeric; v_settled numeric; v_supplier uuid; v_number text; v_journal uuid; v_lines jsonb; v_new_settled numeric; v_status text; v_idem text; v_ins int;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type='user' and not public.has_capability(p_company,'finance.payment.record') then raise exception 'missing capability finance.payment.record'; end if;
  if v_type='user' and not public.within_authority(p_company,'payment',round(p_amount,2)) then raise exception 'amount exceeds your payment authority ceiling'; end if;
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

-- ── reverse_journal ──
create or replace function public.reverse_journal(
  p_company uuid, p_journal uuid, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text; v_currency text; v_status text; v_lines jsonb; v_rev uuid; v_idem text;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type='user' and not public.has_capability(p_company,'finance.journal.reverse') then raise exception 'missing capability finance.journal.reverse'; end if;
  select currency, status into v_currency, v_status from journal_entries where id=p_journal and company_id=p_company for update;
  if v_currency is null then raise exception 'Journal not found'; end if;
  v_idem := coalesce(p_idempotency_key, 'reverse:'||p_journal);
  if v_status = 'reversed' then
    select id into v_rev from journal_entries where company_id=p_company and idempotency_key=v_idem;
    if v_rev is not null then return v_rev; end if;
    raise exception 'Journal already reversed';
  elsif v_status <> 'posted' then raise exception 'Only a posted journal can be reversed (is %)', v_status; end if;
  select jsonb_agg(jsonb_build_object('account_code',account_code,'debit',credit,'credit',debit,'description','Reversal'))
    into v_lines from journal_lines where journal_id=p_journal and company_id=p_company;
  if v_lines is null then raise exception 'Journal has no lines'; end if;
  v_rev := public._journal_post_internal(p_company, p_date, v_currency, 'Reversal of journal '||p_journal, v_actor, v_type, v_lines, v_idem, 'journal.reverse', 'journal', p_journal);
  update journal_entries set status='reversed' where id=p_journal and company_id=p_company;
  update journal_entries set reversal_of_journal_id=p_journal where id=v_rev and company_id=p_company;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, v_type, v_actor, 'journal.reversed','journal',p_journal, jsonb_build_object('reversal_journal_id',v_rev), v_idem);
  return v_rev;
end $$;

-- ── post_customer_invoice (WP4 lifecycle: only 'draft' posts; header = line total) ──
create or replace function public.post_customer_invoice(
  p_company uuid, p_invoice uuid, p_receivable_code text, p_income_code text, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text; v_currency text; v_total numeric; v_number text; v_journal uuid; v_existing uuid; v_status text; v_line_total numeric; v_lines jsonb;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type='user' and not public.has_capability(p_company,'finance.invoice.post') then raise exception 'missing capability finance.invoice.post'; end if;
  select currency, total_amount, invoice_number, journal_id, status into v_currency, v_total, v_number, v_existing, v_status
  from customer_invoices where id=p_invoice and company_id=p_company for update;
  if v_currency is null then raise exception 'Invoice not found'; end if;
  if v_existing is not null then return v_existing; end if;             -- already posted → idempotent
  if v_status <> 'draft' then raise exception 'Invoice cannot be posted from status % (only draft)', v_status; end if;
  select coalesce(sum(amount),0) into v_line_total from customer_invoice_lines where invoice_id=p_invoice and company_id=p_company;
  if v_line_total > 0 and round(v_line_total,2) <> round(v_total,2) then raise exception 'Invoice header total % <> line total %', v_total, v_line_total; end if;
  v_lines := jsonb_build_array(
    jsonb_build_object('account_code',p_receivable_code,'debit',v_total,'credit',0,'description','Invoice '||v_number),
    jsonb_build_object('account_code',p_income_code,'debit',0,'credit',v_total,'description','Invoice '||v_number));
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Customer invoice '||v_number, v_actor, v_type, v_lines, coalesce(p_idempotency_key,'invoice_post:'||p_invoice), 'customer_invoice.post', 'customer_invoice', p_invoice);
  update customer_invoices set journal_id=v_journal, status='issued' where id=p_invoice and company_id=p_company;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, v_type, v_actor, 'customer_invoice.posted','customer_invoice',p_invoice, jsonb_build_object('journal_id',v_journal));
  return v_journal;
end $$;

-- ── post_supplier_bill (WP4 lifecycle: only 'draft' posts; header = line total) ──
create or replace function public.post_supplier_bill(
  p_company uuid, p_bill uuid, p_expense_code text, p_payable_code text, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text; v_currency text; v_total numeric; v_number text; v_journal uuid; v_existing uuid; v_status text; v_line_total numeric; v_lines jsonb;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type='user' and not public.has_capability(p_company,'finance.bill.post') then raise exception 'missing capability finance.bill.post'; end if;
  select currency, total_amount, bill_number, journal_id, status into v_currency, v_total, v_number, v_existing, v_status
  from supplier_bills where id=p_bill and company_id=p_company for update;
  if v_currency is null then raise exception 'Bill not found'; end if;
  if v_existing is not null then return v_existing; end if;
  if v_status <> 'draft' then raise exception 'Bill cannot be posted from status % (only draft)', v_status; end if;
  select coalesce(sum(amount),0) into v_line_total from supplier_bill_lines where bill_id=p_bill and company_id=p_company;
  if v_line_total > 0 and round(v_line_total,2) <> round(v_total,2) then raise exception 'Bill header total % <> line total %', v_total, v_line_total; end if;
  v_lines := jsonb_build_array(
    jsonb_build_object('account_code',p_expense_code,'debit',v_total,'credit',0,'description','Bill '||coalesce(v_number,'')),
    jsonb_build_object('account_code',p_payable_code,'debit',0,'credit',v_total,'description','Bill '||coalesce(v_number,'')));
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Supplier bill '||coalesce(v_number,''), v_actor, v_type, v_lines, coalesce(p_idempotency_key,'bill_post:'||p_bill), 'supplier_bill.post', 'supplier_bill', p_bill);
  update supplier_bills set journal_id=v_journal, status='approved' where id=p_bill and company_id=p_company;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, v_type, v_actor, 'supplier_bill.posted','supplier_bill',p_bill, jsonb_build_object('journal_id',v_journal));
  return v_journal;
end $$;

-- ── reimburse_expense_claim (WP3 source binding: no ON CONFLICT; validate payment reuse) ──
create or replace function public.reimburse_expense_claim(
  p_company uuid, p_claim uuid, p_expense_code text, p_cash_code text, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text; v_currency text; v_amount numeric; v_status text; v_employee uuid; v_claimant uuid; v_journal uuid; v_lines jsonb; v_idem text;
        v_pay_id uuid; v_pay_party uuid; v_pay_amt numeric; v_pay_ccy text; v_pay_dir text;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type='user' and not public.has_capability(p_company,'finance.payment.record') then raise exception 'missing capability finance.payment.record'; end if;
  select currency, amount, status, employee_id into v_currency, v_amount, v_status, v_employee
  from expense_claims where id=p_claim and company_id=p_company for update;
  if v_currency is null then raise exception 'Claim not found'; end if;
  if v_status = 'reimbursed' then
    select p.journal_id into v_journal from reimbursements r join payments p on p.id=r.payment_id where r.company_id=p_company and r.expense_claim_id=p_claim limit 1;
    return v_journal;   -- already reimbursed → idempotent
  end if;
  if v_status <> 'approved' then raise exception 'Only an approved claim can be reimbursed (is %)', v_status; end if;
  select user_id into v_claimant from employees where id=v_employee and company_id=p_company;
  if v_claimant is not null and v_claimant = v_actor then raise exception 'cannot reimburse your own expense claim'; end if;

  v_idem := coalesce(p_idempotency_key, 'reimburse:'||p_claim);
  v_lines := jsonb_build_array(
    jsonb_build_object('account_code',p_expense_code,'debit',v_amount,'credit',0,'description','Expense reimbursement'),
    jsonb_build_object('account_code',p_cash_code,'debit',0,'credit',v_amount,'description','Expense reimbursement'));
  -- Journal fingerprint binds source='expense_claim'/p_claim → the key can't post another claim.
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Expense reimbursement', v_actor, v_type, v_lines, v_idem, 'expense_claim.reimburse', 'expense_claim', p_claim);

  -- Payment: bind + validate on reuse (no ON CONFLICT DO NOTHING attaching a wrong claim).
  select id, party_id, amount, currency, direction into v_pay_id, v_pay_party, v_pay_amt, v_pay_ccy, v_pay_dir
  from payments where company_id=p_company and idempotency_key=v_idem;
  if v_pay_id is not null then
    if v_pay_party is distinct from v_employee or round(v_pay_amt,2) <> round(v_amount,2) or v_pay_ccy <> v_currency or v_pay_dir <> 'out' then
      raise exception 'reimbursement key reused for a different payment (conflict)';
    end if;
  else
    insert into payments (company_id, direction, party_type, party_id, currency, amount, method, payment_date, journal_id, status, idempotency_key)
    values (p_company,'out','employee',v_employee,v_currency,round(v_amount,2),'record',p_date,v_journal,'recorded',v_idem)
    returning id into v_pay_id;
  end if;
  insert into reimbursements (company_id, expense_claim_id, employee_id, currency, amount, status, payment_id)
  values (p_company, p_claim, v_employee, v_currency, round(v_amount,2), 'paid', v_pay_id);
  update expense_claims set status='reimbursed' where id=p_claim and company_id=p_company;
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, v_type, v_actor, 'expense_claim.reimbursed','expense_claim',p_claim, jsonb_build_object('journal_id',v_journal));
  return v_journal;
end $$;

-- ── Grants (internal not for authenticated) ──
do $$
begin
  if exists (select 1 from pg_roles where rolname='authenticated') then
    revoke all on function public._journal_post_internal(uuid,date,text,text,uuid,text,jsonb,text,text,text,uuid) from public;
    grant execute on function public._journal_post_internal(uuid,date,text,text,uuid,text,jsonb,text,text,text,uuid) to service_role;
    grant execute on function public.post_manual_journal(uuid,date,text,text,uuid,jsonb,text) to authenticated, service_role;
    grant execute on function public.settle_customer_invoice(uuid,uuid,numeric,text,text,uuid,date,text) to authenticated, service_role;
    grant execute on function public.settle_supplier_bill(uuid,uuid,numeric,text,text,uuid,date,text) to authenticated, service_role;
    grant execute on function public.reverse_journal(uuid,uuid,uuid,date,text) to authenticated, service_role;
    grant execute on function public.post_customer_invoice(uuid,uuid,text,text,uuid,date,text) to authenticated, service_role;
    grant execute on function public.post_supplier_bill(uuid,uuid,text,text,uuid,date,text) to authenticated, service_role;
    grant execute on function public.reimburse_expense_claim(uuid,uuid,text,text,uuid,date,text) to authenticated, service_role;
  end if;
end $$;
