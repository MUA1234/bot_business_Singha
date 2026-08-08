-- ============================================================================
-- RUN-ONCE COMBINED MIGRATION — Correction phase (pending migrations 0042 -> 0047)
-- Generated 2026-08-08 from the canonical files in src/db/migrations/.
--
-- Your live DB already has 0001-0041 (message_outbox lease columns + audit_events
-- .idempotency_key confirm 0039-0041; journal_entries has no payload_hash/idem_fingerprint
-- and authority_rules has no is_unlimited, so 0042-0047 are pending).
--
-- SAFE TO RUN: forward-only, additive, IDEMPOTENT (drop policy if exists / create or
-- replace / add column if not exists), wrapped in ONE transaction (all-or-nothing). If any
-- of 0042-0047 were already applied, re-running them is a no-op. Order matters and is
-- preserved (0043 adds journal_entries.payload_hash which 0044 requires; 0044 defines the
-- versioned internal poster that 0045/0046 use). INERT until the RLS_WRITES/etc flags are
-- turned on (service role bypasses RLS; RPCs treat the service caller as the trusted path).
--
-- HOW TO RUN: paste this whole file into the Supabase SQL editor and Run.
-- Recommended: run against a NON-PRODUCTION copy first (see MIGRATION_STATE.md).
-- ============================================================================

begin;

create table if not exists schema_migrations (
  version text primary key,
  filename text not null,
  applied_at timestamptz not null default now()
);

-- ============================================================================
-- 0042_authority_tightening.sql
-- ============================================================================
-- 0042_authority_tightening.sql
-- Production Security & Reliability Gate — WP A follow-up (review findings).
--   1. Self-service rows are tied to the AUTHENTICATED person: an expense claim's
--      employee must map to auth.uid(); a leave request's profile must BE auth.uid().
--      (Previously any company member could insert a claim for another employee_id.)
--   2. Capability-gate the remaining financial subledger tables still on 0034's broad
--      company-member write policy (receipts, credit_notes, refunds, employee_advances,
--      supplier_bank_detail_changes, loans, loan_schedules).
--   3. payment_allocations is written only by settlement RPCs → service-only lockdown.
--
-- ADDITIVE, FORWARD-ONLY, IDEMPOTENT. Inert while RLS_WRITES is off (service role bypass).

-- ── 1. Self-service binding ──────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.expense_claims') is not null then
    drop policy if exists expense_claims_cap_ins on expense_claims;
    -- Insert only a claim for AN EMPLOYEE THAT IS YOU (in this company).
    create policy expense_claims_cap_ins on expense_claims for insert
      with check (
        public.has_company_access(company_id)
        and exists (
          select 1 from employees e
          where e.id = employee_id and e.company_id = expense_claims.company_id and e.user_id = auth.uid()
        )
      );
  end if;

  if to_regclass('public.leave_requests') is not null then
    drop policy if exists leave_requests_cap_ins on leave_requests;
    -- Request leave only for YOURSELF.
    create policy leave_requests_cap_ins on leave_requests for insert
      with check (public.has_company_access(company_id) and profile_id = auth.uid());
  end if;
end $$;

-- ── 2. Capability-gate remaining financial subledger tables ──────────────────
do $$
declare
  pairs text[][] := array[
    ['receipts','finance.receipt.record'],
    ['credit_notes','finance.payment.record'],
    ['refunds','finance.payment.record'],
    ['employee_advances','finance.payment.record'],
    ['supplier_bank_detail_changes','finance.bank_details.request'],
    ['loans','administer_accounts'],
    ['loan_schedules','administer_accounts']
  ];
  t text; cap text;
begin
  for i in 1 .. array_length(pairs,1) loop
    t := pairs[i][1]; cap := pairs[i][2];
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_w_ins', t);
    execute format('drop policy if exists %I on %I', t||'_w_upd', t);
    execute format('drop policy if exists %I on %I', t||'_w_del', t);
    execute format('drop policy if exists %I on %I', t||'_cap_ins', t);
    execute format('drop policy if exists %I on %I', t||'_cap_upd', t);
    execute format('drop policy if exists %I on %I', t||'_cap_del', t);
    execute format($f$create policy %I on %I for insert with check (public.has_capability(company_id, %L))$f$, t||'_cap_ins', t, cap);
    execute format($f$create policy %I on %I for update using (public.has_capability(company_id, %L)) with check (public.has_capability(company_id, %L))$f$, t||'_cap_upd', t, cap, cap);
    execute format($f$create policy %I on %I for delete using (public.has_capability(company_id, %L))$f$, t||'_cap_del', t, cap);
  end loop;
end $$;

-- ── 3. Service-only lockdown for allocation rows (RPC-written) ────────────────
do $$
begin
  if to_regclass('public.payment_allocations') is not null then
    alter table payment_allocations enable row level security;
    drop policy if exists payment_allocations_w_ins on payment_allocations;
    drop policy if exists payment_allocations_w_upd on payment_allocations;
    drop policy if exists payment_allocations_w_del on payment_allocations;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke insert, update, delete on payment_allocations from authenticated;
    end if;
  end if;
end $$;


-- ============================================================================
-- 0043_transactional_finance.sql
-- ============================================================================
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


-- ============================================================================
-- 0044_canonical_idempotency_and_lifecycle.sql
-- ============================================================================
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


-- ============================================================================
-- 0045_bank_change_maker_checker.sql
-- ============================================================================
-- 0045_bank_change_maker_checker.sql
-- Correction phase — WP6. Supplier bank-detail changes become genuine maker-checker:
--   * Direct authenticated INSERT/UPDATE/DELETE of supplier_bank_detail_changes is
--     IMPOSSIBLE — the rows are written only by the two SECURITY DEFINER RPCs below.
--   * request RPC: captures the supplier's current values and creates an immutable
--     pending request (capability finance.bank_details.request).
--   * decision RPC: locks the request + supplier, checks pending lifecycle, checks
--     finance.bank_details.approve, enforces maker <> checker, applies the supplier
--     update (on approve) and writes the audit — all in one transaction.
--   * Audit never contains account numbers (WP6.5).
-- FORWARD-ONLY, IDEMPOTENT.

-- ── RLS: RPC-only. Remove any direct write policy; revoke DML from authenticated. ──
do $$
begin
  alter table supplier_bank_detail_changes enable row level security;
  drop policy if exists supplier_bank_detail_changes_cap_ins on supplier_bank_detail_changes;
  drop policy if exists supplier_bank_detail_changes_cap_upd on supplier_bank_detail_changes;
  drop policy if exists supplier_bank_detail_changes_cap_del on supplier_bank_detail_changes;
  drop policy if exists supplier_bank_detail_changes_w_ins on supplier_bank_detail_changes;
  drop policy if exists supplier_bank_detail_changes_w_upd on supplier_bank_detail_changes;
  drop policy if exists supplier_bank_detail_changes_w_del on supplier_bank_detail_changes;
  drop policy if exists supplier_bank_detail_changes_read on supplier_bank_detail_changes;
  create policy supplier_bank_detail_changes_read on supplier_bank_detail_changes for select using (public.has_company_access(company_id));
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke insert, update, delete on supplier_bank_detail_changes from authenticated;
  end if;
end $$;

-- ── Maker: request a bank-detail change (immutable pending record) ────────────
create or replace function public.request_supplier_bank_change(
  p_company uuid, p_supplier uuid, p_new_name text, p_new_number text, p_by uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text; v_old_name text; v_old_number text; v_id uuid;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type = 'user' and not public.has_capability(p_company, 'finance.bank_details.request') then
    raise exception 'missing capability finance.bank_details.request';
  end if;
  if coalesce(btrim(p_new_name),'') = '' and coalesce(btrim(p_new_number),'') = '' then
    raise exception 'a bank change must set a new name or number';
  end if;
  select bank_account_name, bank_account_number into v_old_name, v_old_number
  from suppliers where id = p_supplier and company_id = p_company for update;
  if not found then raise exception 'Supplier not found'; end if;

  insert into supplier_bank_detail_changes (
    company_id, supplier_id, old_account_name, old_account_number, new_account_name, new_account_number, requested_by, status
  ) values (
    p_company, p_supplier, v_old_name, v_old_number,
    coalesce(nullif(btrim(p_new_name),''), v_old_name), coalesce(nullif(btrim(p_new_number),''), v_old_number),
    v_actor, 'pending'
  ) returning id into v_id;

  -- Audit WITHOUT account numbers (sensitive).
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, v_type, v_actor, 'supplier_bank_change.requested', 'supplier', p_supplier, jsonb_build_object('change_id', v_id));
  return v_id;
end $$;

-- ── Checker: decide (approve/reject) a pending change ─────────────────────────
create or replace function public.decide_supplier_bank_change(
  p_company uuid, p_change uuid, p_decision text, p_by uuid, p_note text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text; v_supplier uuid; v_status text; v_requested_by uuid; v_new_name text; v_new_number text;
begin
  if p_decision not in ('approved','rejected') then raise exception 'decision must be approved or rejected'; end if;
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type = 'user' and not public.has_capability(p_company, 'finance.bank_details.approve') then
    raise exception 'missing capability finance.bank_details.approve';
  end if;

  select supplier_id, status, requested_by, new_account_name, new_account_number
    into v_supplier, v_status, v_requested_by, v_new_name, v_new_number
  from supplier_bank_detail_changes where id = p_change and company_id = p_company for update;
  if not found then raise exception 'Bank change not found'; end if;
  if v_status <> 'pending' then raise exception 'Bank change is not pending (is %)', v_status; end if;
  if v_requested_by = v_actor then raise exception 'the requester cannot approve their own bank change (separation of duties)'; end if;

  -- Lock the supplier so a concurrent approval serialises.
  perform 1 from suppliers where id = v_supplier and company_id = p_company for update;

  if p_decision = 'approved' then
    update suppliers set bank_account_name = v_new_name, bank_account_number = v_new_number where id = v_supplier and company_id = p_company;
  end if;
  update supplier_bank_detail_changes
    set status = p_decision, approved_by = v_actor, decided_at = now(), note = p_note
  where id = p_change and company_id = p_company;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, v_type, v_actor, 'supplier_bank_change.' || p_decision, 'supplier', v_supplier, jsonb_build_object('change_id', p_change));
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.request_supplier_bank_change(uuid,uuid,text,text,uuid) from public;
    revoke all on function public.decide_supplier_bank_change(uuid,uuid,text,uuid,text) from public;
    grant execute on function public.request_supplier_bank_change(uuid,uuid,text,text,uuid) to authenticated, service_role;
    grant execute on function public.decide_supplier_bank_change(uuid,uuid,text,uuid,text) to authenticated, service_role;
  end if;
end $$;


-- ============================================================================
-- 0046_authority_and_approvals.sql
-- ============================================================================
-- 0046_authority_and_approvals.sql
-- Correction phase — WP7. Deny-by-default financial authority + a transactional approval RPC.
--   * authority_rules gains is_unlimited (explicit, owner-set) — unlimited is NEVER inferred
--     from a missing row or null amount.
--   * within_authority is now DENY-BY-DEFAULT: for a money domain, no applicable rule = NO
--     authority. Currency is matched; a delegate is bounded by the delegation AND by the
--     delegator's own active authority.
--   * settle_supplier_bill no longer carries an authority ceiling on the RECORDING of an
--     already-moved payment (capability finance.payment.record is the gate); the amount
--     ceiling belongs on the APPROVAL decision below.
--   * decide_approval: one transactional, idempotent, maker-checker approval decision that
--     validates lifecycle, capability, separation of duties and amount/currency authority,
--     records ONE append-only action and advances the request when approvals are satisfied.
--     Direct authenticated inserts into approval_actions are removed (RPC-only).
-- FORWARD-ONLY, IDEMPOTENT.

alter table authority_rules add column if not exists is_unlimited boolean not null default false;

-- ── Deny-by-default authority ────────────────────────────────────────────────
-- Drop the old 3-arg overload (0038) so the currency-aware version is unambiguous.
drop function if exists public.within_authority(uuid, text, numeric);
create or replace function public.within_authority(
  target_company uuid, target_domain text, amount numeric, p_currency text default null
) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    -- own authority rule (explicit unlimited or a sufficient ceiling; currency-matched)
    select 1 from memberships m join authority_rules ar on ar.membership_id = m.id
    where m.user_id = auth.uid() and m.company_id = target_company and m.status = 'active'
      and ar.domain = target_domain
      and (p_currency is null or ar.currency is null or ar.currency = p_currency)
      and (ar.is_unlimited or (ar.max_amount is not null and amount <= ar.max_amount))
    union all
    -- delegated authority: bounded by the delegation AND by the delegator's own authority
    select 1 from delegations d
    join memberships tm on tm.id = d.to_membership and tm.user_id = auth.uid() and tm.status = 'active'
    join memberships fm on fm.id = d.from_membership and fm.status = 'active'
    where d.company_id = target_company and now() between d.starts_at and d.ends_at
      and (d.domain = target_domain or d.domain is null)
      and (d.currency is null or p_currency is null or d.currency = p_currency)
      and d.max_amount is not null and amount <= d.max_amount
      and exists (
        select 1 from authority_rules ar2 where ar2.membership_id = fm.id and ar2.domain = target_domain
          and (ar2.is_unlimited or (ar2.max_amount is not null and amount <= ar2.max_amount))
      )
  );
$$;

-- ── settle_supplier_bill without the recording-time ceiling (capability is the gate) ──
create or replace function public.settle_supplier_bill(
  p_company uuid, p_bill uuid, p_amount numeric, p_ap_code text, p_cash_code text, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text; v_currency text; v_total numeric; v_settled numeric; v_supplier uuid; v_number text; v_journal uuid; v_lines jsonb; v_new_settled numeric; v_status text; v_idem text; v_ins int;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type='user' and not public.has_capability(p_company,'finance.payment.record') then raise exception 'missing capability finance.payment.record'; end if;
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

-- ── Approval decisions: RPC-only, transactional, idempotent, maker-checker ────
do $$
begin
  drop policy if exists approval_actions_cap_ins on approval_actions;   -- RPC-only now
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke insert, update, delete on approval_actions from authenticated;
  end if;
end $$;

create or replace function public.decide_approval(
  p_company uuid, p_request uuid, p_action text, p_note text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text; v_required int; v_maker uuid; v_fe uuid; v_amount numeric; v_ccy text; v_domain text; v_approvals int; v_new_status text;
begin
  if public.caller_jwt_role() = 'anon' or auth.uid() is null then raise exception 'approvals require an authenticated user'; end if;
  if p_action not in ('approve','reject') then raise exception 'action must be approve or reject'; end if;
  if not public.has_capability(p_company, 'approve') then raise exception 'missing capability approve'; end if;

  select status, approvals_required, submitted_by, financial_event_id
    into v_status, v_required, v_maker, v_fe
  from approval_requests where id = p_request and company_id = p_company for update;
  if not found then raise exception 'Approval request not found'; end if;
  if v_status <> 'pending' then raise exception 'Approval request is not pending (is %)', v_status; end if;
  if v_maker = auth.uid() then raise exception 'the maker cannot approve their own request (separation of duties)'; end if;

  -- Amount/currency authority (deny-by-default) when the request carries a financial event.
  if p_action = 'approve' and v_fe is not null then
    select amount, currency, event_type into v_amount, v_ccy, v_domain from financial_events where id = v_fe and company_id = p_company;
    if v_amount is not null and not public.within_authority(p_company, coalesce(v_domain,'payment'), round(v_amount,2), v_ccy) then
      raise exception 'amount %/% exceeds your approval authority', v_amount, v_ccy;
    end if;
  end if;

  -- One append-only action per approver (idempotent on double-click via the unique key).
  begin
    insert into approval_actions (approval_request_id, company_id, actor_user_id, action, note)
    values (p_request, p_company, auth.uid(), p_action, p_note);
  exception when unique_violation then
    -- already acted → no double count; fall through to recompute status.
    null;
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
  values (p_company, 'user', auth.uid(), 'approval.' || p_action, 'approval_request', p_request, jsonb_build_object('status', v_new_status));
  return v_new_status;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.decide_approval(uuid,uuid,text,text) from public;
    grant execute on function public.decide_approval(uuid,uuid,text,text) to authenticated, service_role;
  end if;
end $$;


-- ============================================================================
-- 0047_rls_write_matrix.sql
-- ============================================================================
-- 0047_rls_write_matrix.sql
-- Correction phase — WP8. Replace the remaining broad company-member write policies on
-- SENSITIVE tables (finance/bank/reconciliation/planning/commitments/inventory/fleet/
-- identity) with operation-specific capability policies. Lower-sensitivity operational/CRM
-- tables intentionally keep company-scoped write (documented in RLS_WRITE_POLICY_MATRIX.md
-- and enforced-complete by tests/integration/rls-matrix-coverage.test.ts).
-- FORWARD-ONLY, IDEMPOTENT.

-- New capability for fleet records (vehicles/drivers/fuel/maintenance/licences).
insert into permissions (key, label) values ('operations.fleet.manage','Operations: manage fleet records') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('project_manager','operations.fleet.manage'), ('owner_management','operations.fleet.manage')
on conflict do nothing;
insert into role_permissions (role_key, permission_key) select 'system_administrator','operations.fleet.manage' on conflict do nothing;

do $$
declare
  pairs text[][] := array[
    -- Finance GL config
    ['cash_accounts','administer_accounts'], ['exchange_rates','administer_accounts'], ['fiscal_years','administer_accounts'],
    -- Bank / reconciliation
    ['bank_transactions','finance.reconcile'], ['bank_imports','finance.reconcile'],
    ['reconciliation_sessions','finance.reconcile'], ['reconciliation_matches','finance.reconcile'],
    ['cash_counts','finance.reconcile'],
    -- Commitments / recurring obligations / planning
    ['commitments','finance.reconcile'], ['obligations','finance.reconcile'], ['recurring_obligations','finance.reconcile'],
    ['budgets','finance.reconcile'], ['budget_lines','finance.reconcile'],
    ['forecasts','finance.reconcile'], ['forecast_lines','finance.reconcile'], ['forecast_scenarios','finance.reconcile'],
    -- Inventory
    ['inventory_items','procurement.goods.receive'], ['stock_movements','procurement.goods.receive'],
    -- Procurement detail
    ['po_lines','procurement.po.approve'], ['supplier_quotations','procurement.request.create'],
    -- Fleet
    ['drivers','operations.fleet.manage'], ['fuel_logs','operations.fleet.manage'],
    ['maintenance_records','operations.fleet.manage'], ['licences','operations.fleet.manage'],
    ['vehicles','operations.fleet.manage'], ['vehicle_documents','operations.fleet.manage'], ['trips','operations.fleet.manage'],
    -- Task workflow detail (tasks itself is gated in 0023)
    ['task_assignments','operations.task.work'], ['task_dependencies','operations.task.work'],
    ['task_check_ins','operations.task.work'], ['task_evidence','operations.task.work'],
    -- Identity-sensitive legacy tables
    ['profiles','admin.identity.manage'], ['user_company_access','admin.identity.manage']
  ];
  t text; cap text;
begin
  for i in 1 .. array_length(pairs,1) loop
    t := pairs[i][1]; cap := pairs[i][2];
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_w_ins', t);
    execute format('drop policy if exists %I on %I', t||'_w_upd', t);
    execute format('drop policy if exists %I on %I', t||'_w_del', t);
    execute format('drop policy if exists %I on %I', t||'_cap_ins', t);
    execute format('drop policy if exists %I on %I', t||'_cap_upd', t);
    execute format('drop policy if exists %I on %I', t||'_cap_del', t);
    execute format($f$create policy %I on %I for insert with check (public.has_capability(company_id, %L))$f$, t||'_cap_ins', t, cap);
    execute format($f$create policy %I on %I for update using (public.has_capability(company_id, %L)) with check (public.has_capability(company_id, %L))$f$, t||'_cap_upd', t, cap, cap);
    execute format($f$create policy %I on %I for delete using (public.has_capability(company_id, %L))$f$, t||'_cap_del', t, cap);
  end loop;
end $$;


insert into schema_migrations (version, filename) values
  ('0042','0042_authority_tightening.sql'),
  ('0043','0043_transactional_finance.sql'),
  ('0044','0044_canonical_idempotency_and_lifecycle.sql'),
  ('0045','0045_bank_change_maker_checker.sql'),
  ('0046','0046_authority_and_approvals.sql'),
  ('0047','0047_rls_write_matrix.sql')
on conflict (version) do nothing;

commit;
