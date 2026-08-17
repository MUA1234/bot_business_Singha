-- ============================================================================
-- SINGHA — HOSTED DATABASE MIGRATION 0042 → 0068  (single, all-or-nothing script)
-- ============================================================================
-- Generated from src/db/migrations/. Apply in the Supabase SQL editor (or psql)
-- on the LIVE project, ONCE, as the project owner.
--
-- WHY: the application code now calls database functions that do not yet exist on
-- the hosted database (which is at 0038–0041). Until this script is applied,
-- sending WhatsApp quotations, outbox delivery and AI analysis will fail.
--
-- SAFETY:
--   * Everything runs inside ONE transaction. Any failure rolls the WHOLE script
--     back — the database is never left half-migrated.
--   * PART 0 refuses to proceed unless the database really is at 0041 and has not
--     already been partly migrated.
--   * PART 0 also REVOKEs CREATE on public/extensions from the API roles. This is
--     REQUIRED: Supabase grants those roles ALL on schema public by default, and
--     migration 0067 deliberately fails closed if an API role can create objects
--     there (it would let an attacker plant a shadow table). Revoking CREATE does
--     not affect normal app behaviour — the API roles never create objects.
--   * Re-running is safe: PART 0 aborts with a clear message if already applied.
--
-- AFTER IT SUCCEEDS: run the verification block at the very bottom (PART 3).
-- ============================================================================

BEGIN;

-- ============================================================================
-- PART 0 — PRE-FLIGHT GUARDS (fail closed)
-- ============================================================================
DO $preflight$
BEGIN
  -- (a) Are we actually at 0041? ledger_integrity_report is introduced by 0041.
  IF to_regprocedure('public.ledger_integrity_report(uuid)') IS NULL THEN
    RAISE EXCEPTION
      'PRE-FLIGHT ABORT: this database does not look like it is at migration 0041 '
      '(public.ledger_integrity_report is missing). Do NOT run this script. Report '
      'the actual state before migrating.';
  END IF;

  -- (b) Has some of 0042+ already been applied? decide_approval arrives in 0046.
  IF to_regprocedure('public.decide_approval(uuid,uuid,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION
      'PRE-FLIGHT ABORT: public.decide_approval already exists, so part of 0042+ is '
      'already applied. Running this script again could conflict. Stop and report the '
      'current state.';
  END IF;

  RAISE NOTICE 'Pre-flight OK: database is at 0041 and 0042+ has not been applied.';
END
$preflight$;

-- (c) REQUIRED by migration 0067: the API roles must not be able to CREATE objects
--     in the trusted schemas. Supabase grants ALL on schema public by default.
REVOKE CREATE ON SCHEMA public FROM anon, authenticated, service_role;
DO $revoke_ext$
BEGIN
  IF to_regnamespace('extensions') IS NOT NULL THEN
    EXECUTE 'REVOKE CREATE ON SCHEMA extensions FROM anon, authenticated, service_role';
  END IF;
END
$revoke_ext$;

-- ============================================================================
-- PART 1 — MIGRATION LEDGER
-- Records what is applied so `npm run migrate` stays in sync from here on.
-- 0001–0041 are recorded as the baseline this database already carries.
-- ============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  filename   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, filename) VALUES ('0001','0001_org_and_access.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0002','0002_accounting_core.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0003','0003_subledgers.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0004','0004_intelligence_and_evidence.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0005','0005_banking_and_planning.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0006','0006_approval_policies.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0007','0007_app_profiles_and_orders.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0008','0008_phase0_rls_hardening.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0009','0009_composite_company_fks.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0010','0010_identity_foundation.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0011','0011_message_outbox.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0012','0012_work_tasks.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0013','0013_capacity_snapshots.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0014','0014_departments_expansion.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0015','0015_post_journal_rpc.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0016','0016_settlement_and_reversal.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0017','0017_hr_workforce.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0018','0018_marketing_objectives.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0019','0019_task_assignment.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0020','0020_rfq.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0021','0021_inventory.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0022','0022_notifications.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0023','0023_identity_capabilities_rls.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0024','0024_composite_company_fks.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0025','0025_task_progress_capacity.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0026','0026_idempotency_keys.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0027','0027_ai_run_trail.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0028','0028_management_cases.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0029','0029_bank_change_status.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0030','0030_fix_reversal_link_immutability.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0031','0031_outbox_next_retry.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0032','0032_outbox_template.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0033','0033_conversation_ai_analyzed.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0034','0034_domain_write_rls.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0035','0035_posting_hardening.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0036','0036_approval_write_rls.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0037','0037_settlement_row_locks.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0038','0038_capability_authority.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0039','0039_accounting_rpc_hardening.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0040','0040_durable_messaging.sql') ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations (version, filename) VALUES ('0041','0041_ledger_integrity_report.sql') ON CONFLICT (version) DO NOTHING;

-- ============================================================================
-- PART 2 — MIGRATIONS 0042 → 0068 (in order)
-- ============================================================================


-- ==========================================================================
-- MIGRATION 0042_authority_tightening.sql
-- ==========================================================================

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

INSERT INTO schema_migrations (version, filename) VALUES ('0042','0042_authority_tightening.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0043_transactional_finance.sql
-- ==========================================================================

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

INSERT INTO schema_migrations (version, filename) VALUES ('0043','0043_transactional_finance.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0044_canonical_idempotency_and_lifecycle.sql
-- ==========================================================================

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
) returns text language sql immutable set search_path = public, extensions as $$  -- 'extensions' for pgcrypto digest() on Supabase
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
) returns text language sql immutable set search_path = public, extensions as $$  -- 'extensions' for pgcrypto digest() on Supabase
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

INSERT INTO schema_migrations (version, filename) VALUES ('0044','0044_canonical_idempotency_and_lifecycle.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0045_bank_change_maker_checker.sql
-- ==========================================================================

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

INSERT INTO schema_migrations (version, filename) VALUES ('0045','0045_bank_change_maker_checker.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0046_authority_and_approvals.sql
-- ==========================================================================

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

INSERT INTO schema_migrations (version, filename) VALUES ('0046','0046_authority_and_approvals.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0047_rls_write_matrix.sql
-- ==========================================================================

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

INSERT INTO schema_migrations (version, filename) VALUES ('0047','0047_rls_write_matrix.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0048_wp10_sensitive_write_rls.sql
-- ==========================================================================

-- 0048_wp10_sensitive_write_rls.sql
-- Correction brief 0048 — WP10: remove broad company-member writes on commercially
-- sensitive tables. An ordinary company member must NEVER gain write access merely by
-- belonging to the company (system invariant #2). Sensitive tables move to
-- operation-specific capabilities; WhatsApp history and worker-generated notifications
-- become service-only (a member cannot forge or alter them).
--
-- BEHAVIOUR CHANGE: none at runtime. RLS_WRITES is OFF in every environment, so
-- application writes use the service-role client, which BYPASSES RLS. These policies take
-- effect only at the future, owner-gated RLS_WRITES cutover. This migration changes no
-- data and no application code path.
--
-- Forward-only; safe to run once. Cross-company writes remain impossible because
-- has_capability(company_id, cap) is company-scoped and requires an ACTIVE membership.

-- 1) New least-privilege domain capabilities.
insert into permissions (key, label) values
  ('sales.catalog.manage',             'Manage product catalog and prices'),
  ('sales.quotation.manage',           'Manage quotations and quotation lines'),
  ('sales.order.manage',               'Manage sales orders'),
  ('sales.pipeline.manage',            'Manage leads and opportunities'),
  ('marketing.campaign.manage',        'Manage marketing campaigns and audiences'),
  ('governance.approval_policy.manage','Manage approval policies'),
  ('documents.manage',                 'Manage documents'),
  ('admin.organisation.manage',        'Manage organisation structure (divisions, branches, departments, sites, projects, cost centres)'),
  ('operations.objective.manage',      'Manage operational objectives')
on conflict (key) do nothing;

-- 2) Role -> capability map (least privilege; documented per role).
--    * system_administrator: ALL new capabilities (brief §WP10.4).
--    * owner_management: senior business management — holds the business-management set.
--    * EVERY other role — project_manager, accountant, finance_reviewer, payment_*,
--      auditor_readonly, staff_submitter — receives NONE of these. An ordinary staff
--      member therefore cannot change a price, an issued quotation, an approval policy,
--      org structure, or WhatsApp history.
--    * project_manager is intentionally NOT granted documents.manage /
--      operations.objective.manage: those capabilities are company-wide as defined here,
--      so granting them to a project manager would misrepresent company-wide authority as
--      project-scoped. Real project-scoped authorisation does not yet exist; until it does
--      this stays deny-by-default (a later WP can add scoped capabilities + a scope-aware
--      check and grant them to project_manager then).
insert into role_permissions (role_key, permission_key) values
  ('system_administrator','sales.catalog.manage'),
  ('system_administrator','sales.quotation.manage'),
  ('system_administrator','sales.order.manage'),
  ('system_administrator','sales.pipeline.manage'),
  ('system_administrator','marketing.campaign.manage'),
  ('system_administrator','governance.approval_policy.manage'),
  ('system_administrator','documents.manage'),
  ('system_administrator','admin.organisation.manage'),
  ('system_administrator','operations.objective.manage'),
  ('owner_management','sales.catalog.manage'),
  ('owner_management','sales.quotation.manage'),
  ('owner_management','sales.order.manage'),
  ('owner_management','sales.pipeline.manage'),
  ('owner_management','marketing.campaign.manage'),
  ('owner_management','governance.approval_policy.manage'),
  ('owner_management','documents.manage'),
  ('owner_management','admin.organisation.manage'),
  ('owner_management','operations.objective.manage')
on conflict (role_key, permission_key) do nothing;

-- 3) Capability-gate the sensitive tables: drop the generic company-member write
--    policies (0034) and create operation-specific has_capability() write policies.
do $$
declare
  pairs text[][] := array[
    ['product_catalog','sales.catalog.manage'],
    ['quotations','sales.quotation.manage'],
    ['quotation_items','sales.quotation.manage'],
    ['price_confirmations','sales.quotation.manage'],
    ['orders','sales.order.manage'],
    ['leads','sales.pipeline.manage'],
    ['opportunities','sales.pipeline.manage'],
    ['campaigns','marketing.campaign.manage'],
    ['audiences','marketing.campaign.manage'],
    ['approval_policies','governance.approval_policy.manage'],
    ['documents','documents.manage'],
    ['divisions','admin.organisation.manage'],
    ['branches','admin.organisation.manage'],
    ['departments','admin.organisation.manage'],
    ['sites','admin.organisation.manage'],
    ['projects','admin.organisation.manage'],
    ['cost_centres','admin.organisation.manage'],
    ['objectives','operations.objective.manage']
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

-- 4) WhatsApp history and worker-generated notifications become SERVICE-ONLY: no
--    authenticated write path at all (the webhook/AI workers write them via the
--    service-role client). Drop member write policies and REVOKE the DML grants from
--    authenticated; the read policy and SELECT grant are left untouched.
do $$
declare
  svc text[] := array['wa_conversations','wa_messages','notifications'];
  t text;
begin
  foreach t in array svc loop
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_w_ins', t);
    execute format('drop policy if exists %I on %I', t||'_w_upd', t);
    execute format('drop policy if exists %I on %I', t||'_w_del', t);
    execute format('revoke insert, update, delete on %I from authenticated', t);
  end loop;
end $$;

INSERT INTO schema_migrations (version, filename) VALUES ('0048','0048_wp10_sensitive_write_rls.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0049_wp17_system_actor.sql
-- ==========================================================================

-- 0049_wp17_system_actor.sql
-- Correction brief 0048 — WP17: make the system-actor path explicit and trust-bounded.
--
-- Problem: `_resolve_actor(p_by)` (migration 0044) recorded a caller-supplied `p_by` as the
-- actor whenever `auth.uid()` was null, treating ANY "no JWT" caller as a trusted worker.
-- That is a weak trust boundary: missing/malformed claims, or an unknown role, silently
-- obtained the system path, and a worker could stamp an arbitrary human identity into the
-- ledger (`posted_by`) and audit trail (`actor_id`) while tagging it `actor_type='system'`.
--
-- Fix: the system path is available ONLY to an explicit `service_role` JWT. Everything else
-- is rejected (fail-closed):
--   * role = 'service_role'  → actor_type='system', actor_id=NULL, caller-supplied p_by ignored;
--   * role = 'authenticated' → must carry a subject (sub); actor = sub; a mismatched p_by is
--                              rejected (no spoofing);
--   * missing claims, malformed claims, anon, or any unknown/absent role → rejected.
-- EXECUTE is revoked from PUBLIC (only the SECURITY DEFINER posting RPCs, owned by the
-- definer, call it internally).
--
-- Forward-only; CREATE OR REPLACE of one function + a REVOKE. No data change. The
-- authenticated-user posting path is unchanged. Every posting RPC (post_manual_journal,
-- post_customer_invoice, post_supplier_bill, settle_*, reimburse_*) derives its actor from
-- this function, so the boundary applies uniformly.

create or replace function public._resolve_actor(p_by uuid, out v_actor uuid, out v_type text)
language plpgsql stable set search_path = public as $$
declare
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_json   json;
  v_role   text;
  v_sub    text;
begin
  -- Fail-closed: a call with no JWT claims at all is never trusted.
  if v_claims is null then
    raise exception 'access denied: missing JWT claims';
  end if;
  -- Malformed claims are rejected with a clean error, not a raw cast failure.
  begin
    v_json := v_claims::json;
  exception when others then
    raise exception 'access denied: malformed JWT claims';
  end;
  v_role := v_json ->> 'role';
  v_sub  := nullif(v_json ->> 'sub', '');

  if v_role = 'service_role' then
    -- Trusted system/worker path — ONLY an explicit service_role. Ignore any caller-supplied
    -- p_by; record no human actor. Traceability comes from the audit idempotency/correlation.
    v_actor := null;
    v_type  := 'system';
  elsif v_role = 'authenticated' then
    -- Authenticated user MUST carry a subject; the actor is derived from it (no spoofing).
    if v_sub is null then
      raise exception 'access denied: authenticated caller without a subject';
    end if;
    if p_by is not null and p_by <> v_sub::uuid then
      raise exception 'actor mismatch: p_by does not match the authenticated user';
    end if;
    v_actor := v_sub::uuid;
    v_type  := 'user';
  else
    -- anon, unknown role, or absent role → rejected.
    raise exception 'access denied: caller role % is not permitted', coalesce(v_role, '(none)');
  end if;
end $$;

-- The resolver is an internal primitive: only the SECURITY DEFINER posting RPCs (running as
-- their definer/owner) may call it. Keep it unavailable to anon/authenticated callers.
revoke execute on function public._resolve_actor(uuid) from public;

INSERT INTO schema_migrations (version, filename) VALUES ('0049','0049_wp17_system_actor.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0050_wp13_posted_journal_immutability.sql
-- ==========================================================================

-- 0050_wp13_posted_journal_immutability.sql
-- Correction brief 0048 — WP13: harden posted-journal immutability with an allowlist-based
-- WHOLE-ROW comparison, and make posted journal LINES immutable against INSERT as well as
-- UPDATE/DELETE.
--
-- Problem 1 (header): `block_posted_mutation()` (0044) compared only a SUBSET of columns for
-- its allowed transitions, so a privileged/definer path could change unrelated posted fields
-- (period_id, exchange_rate, source_event_id, approval_request_id, correlation_id,
-- idempotency_key, posted_at, created_by, …) while satisfying the subset check.
--
-- Problem 2 (lines): the posted-lines guard only fired on UPDATE/DELETE, so a service-role
-- caller could INSERT an extra line into an already-posted journal (unbalancing it).
--
-- Fix 1: each allowed header transition names EXACTLY the column(s) it may change; every other
-- column must be identical (whole-row JSONB comparison with only the approved keys removed).
-- Fix 2: the line guard now also fires on INSERT and rejects any line write whose parent
-- journal is posted. Because the poster previously inserted the journal already 'posted' and
-- then added its lines, `_journal_post_internal` is restructured to insert the journal as
-- 'draft', insert its lines (parent not yet posted → allowed), then flip it to 'posted' (a
-- normal draft→posted update). Net posting behaviour is unchanged except a posted journal's
-- `version` is 2 (the draft→posted bump); no code or test depends on that value.
--
-- Forward-only; CREATE OR REPLACE of three functions + one trigger re-bind. No data change.

-- ── Fix 1: allowlist whole-row header immutability ───────────────────────────────────────
create or replace function public.block_posted_mutation()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'DELETE') then
    if old.status = 'posted' then
      raise exception 'Posted journal % is immutable and cannot be deleted', old.id;
    end if;
    return old;
  end if;

  if old.status is distinct from 'posted' then
    new.updated_at := now();
    new.version := old.version + 1;
    return new;
  end if;

  -- A) Reverse the original: status posted -> reversed; every other column identical.
  if new.status = 'reversed'
     and (to_jsonb(new) - '{status}'::text[]) = (to_jsonb(old) - '{status}'::text[]) then
    return new;
  end if;

  -- B) Link a reversing entry: reversal_of_journal_id NULL -> non-NULL (once); else identical.
  if old.reversal_of_journal_id is null and new.reversal_of_journal_id is not null
     and (to_jsonb(new) - '{reversal_of_journal_id}'::text[]) = (to_jsonb(old) - '{reversal_of_journal_id}'::text[]) then
    return new;
  end if;

  -- C) One-time legacy idempotency-fingerprint upgrade: idem_fingerprint NULL -> non-NULL;
  --    else identical. A fingerprint already set can never be replaced.
  if old.idem_fingerprint is null and new.idem_fingerprint is not null
     and (to_jsonb(new) - '{idem_fingerprint}'::text[]) = (to_jsonb(old) - '{idem_fingerprint}'::text[]) then
    return new;
  end if;

  raise exception 'Posted journal % is immutable (attempted mutation)', old.id;
end;
$$;

-- ── Fix 2a: line guard now also blocks INSERT into a posted journal ──────────────────────
create or replace function public.block_posted_line_mutation()
returns trigger language plpgsql as $$
declare parent_status text;
begin
  select status into parent_status from journal_entries
    where id = coalesce(new.journal_id, old.journal_id);
  if parent_status = 'posted' then
    raise exception 'Lines of a posted journal are immutable';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_block_posted_line_mutation on journal_lines;
create trigger trg_block_posted_line_mutation
  before insert or update or delete on journal_lines
  for each row execute function public.block_posted_line_mutation();

-- ── Fix 2b: poster inserts lines while 'draft', then flips to 'posted' ───────────────────
create or replace function public._journal_post_internal(p_company uuid, p_date date, p_currency text, p_memo text, p_actor uuid, p_actor_type text, p_lines jsonb, p_idempotency_key text, p_operation text, p_source_type text, p_source_id uuid)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
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
        if v_existing_fp <> v_new_fp then raise exception 'idempotency key reused with a different operation (conflict)'; end if;
        return v_existing;
      else
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

  -- Insert as DRAFT so the lines can be added (the posted-line guard blocks writes once posted).
  begin
    insert into journal_entries (
      company_id, period_id, posting_date, currency, exchange_rate, memo, status,
      correlation_id, idempotency_key, payload_hash, idem_fingerprint, total_debit, total_credit, posted_at, posted_by, created_by
    ) values (
      p_company, v_period_id, p_date, p_currency, 1, p_memo, 'draft',
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

  -- Flip to posted now that all lines are in place (normal draft->posted update).
  update journal_entries set status = 'posted' where id = v_journal_id;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, coalesce(p_actor_type,'user'), p_actor, 'journal.posted', 'journal', v_journal_id,
          jsonb_build_object('total', round(v_total_debit,2), 'memo', p_memo, 'operation', p_operation), p_idempotency_key);
  return v_journal_id;
end $function$;

INSERT INTO schema_migrations (version, filename) VALUES ('0050','0050_wp13_posted_journal_immutability.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0051_wp14_canonical_json_fingerprint.sql
-- ==========================================================================

-- 0051_wp14_canonical_json_fingerprint.sql
-- Correction brief 0048 — WP14: replace delimiter-joined fingerprints with a versioned
-- canonical JSON representation.
--
-- Problem: `_fp_lines()` (0044) concatenates account_code, debit, credit and description with
-- ',' and ';' delimiters WITHOUT escaping. A description or memo containing a delimiter can make
-- two DISTINCT payloads serialise to the SAME canonical string, so distinct journals collide to
-- one idempotency fingerprint (silent wrong-reuse).
--
-- Fix: build a versioned canonical JSONB object and hash its canonical text with SHA-256. JSON
-- string values are unambiguously quoted/escaped, so no field can bleed into another. Each line
-- is a JSON object (never delimiter-joined). Line order is documented INSIGNIFICANT: the
-- normalized line objects are sorted deterministically before aggregation. The new fingerprint
-- is prefixed `v3:`.
--
-- Compatibility (does NOT reinterpret stored fingerprints):
--   * a stored `v3:` fingerprint is compared to the new v3 canonical fingerprint;
--   * a stored `v2:` fingerprint is compared using the ORIGINAL v2 algorithm (`_fp_full`) and is
--     left in place — a set fingerprint is never replaced (WP13 immutability);
--   * a legacy NULL fingerprint is reconstructed (`_fp_recon`) and, on a match, upgraded once to
--     the new v3 fingerprint (the NULL->non-NULL transition WP13 permits).
-- `_fp_full` (v2) and `_fp_recon` are retained for the compatibility comparisons.
-- pgcrypto stays reachable via `search_path = public, extensions` (Supabase).
--
-- Forward-only; CREATE OR REPLACE of two new helpers + `_journal_post_internal`. No data change.

-- Canonical, order-independent JSONB array of normalized line objects.
create or replace function public._fp_lines_v3(p_lines jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(obj order by obj::text), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'account_code', l->>'account_code',
      'debit',  round(coalesce((l->>'debit')::numeric, 0), 2)::text,
      'credit', round(coalesce((l->>'credit')::numeric, 0), 2)::text,
      'description', coalesce(l->>'description', '')
    ) as obj
    from jsonb_array_elements(p_lines) l
  ) s;
$$;

-- Versioned canonical fingerprint over a JSONB object (collision-safe; 'v3:' prefix).
create or replace function public._fp_full_v3(
  p_operation text, p_company uuid, p_source_type text, p_source_id uuid,
  p_date date, p_currency text, p_memo text, p_lines jsonb
) returns text language sql immutable set search_path = public, extensions as $$  -- 'extensions' for pgcrypto digest() on Supabase
  select 'v3:' || encode(digest(
    jsonb_build_object(
      'v', 3,
      'operation',   coalesce(p_operation, ''),
      'company',     p_company::text,
      'source_type', coalesce(p_source_type, ''),
      'source_id',   coalesce(p_source_id::text, ''),
      'date',        p_date::text,
      'currency',    upper(coalesce(p_currency, '')),
      'memo',        coalesce(btrim(p_memo), ''),
      'lines',       public._fp_lines_v3(p_lines)
    )::text,
    'sha256'), 'hex');
$$;

-- Poster: compute the v3 fingerprint and apply version-aware reuse comparison.
create or replace function public._journal_post_internal(p_company uuid, p_date date, p_currency text, p_memo text, p_actor uuid, p_actor_type text, p_lines jsonb, p_idempotency_key text, p_operation text, p_source_type text, p_source_id uuid)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
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

  v_new_fp := public._fp_full_v3(p_operation, p_company, p_source_type, p_source_id, p_date, p_currency, p_memo, p_lines);

  if p_idempotency_key is not null then
    select id, idem_fingerprint into v_existing, v_existing_fp
    from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key for update;
    if v_existing is not null then
      if v_existing_fp is null then
        -- Legacy row: reconstruct + compare, then upgrade NULL -> v3 (allowed once).
        select posting_date, currency, memo into v_old_date, v_old_ccy, v_old_memo from journal_entries where id = v_existing;
        select jsonb_agg(jsonb_build_object('account_code',account_code,'debit',debit,'credit',credit,'description',description) order by line_no)
          into v_old_lines from journal_lines where journal_id = v_existing;
        if public._fp_recon(v_old_date, v_old_ccy, v_old_memo, v_old_lines) is distinct from public._fp_recon(p_date, p_currency, p_memo, p_lines) then
          raise exception 'idempotency key reused with a different operation (legacy conflict)';
        end if;
        update journal_entries set idem_fingerprint = v_new_fp where id = v_existing;
        return v_existing;
      elsif left(v_existing_fp, 3) = 'v2:' then
        -- Stored under the v2 algorithm: compare with v2; never reinterpret or replace it.
        if v_existing_fp <> public._fp_full(p_operation, p_company, p_source_type, p_source_id, p_date, p_currency, p_memo, p_lines) then
          raise exception 'idempotency key reused with a different operation (conflict)';
        end if;
        return v_existing;
      else
        -- v3 canonical: exact match or conflict.
        if v_existing_fp <> v_new_fp then raise exception 'idempotency key reused with a different operation (conflict)'; end if;
        return v_existing;
      end if;
    end if;
  end if;

  begin
    insert into journal_entries (
      company_id, period_id, posting_date, currency, exchange_rate, memo, status,
      correlation_id, idempotency_key, payload_hash, idem_fingerprint, total_debit, total_credit, posted_at, posted_by, created_by
    ) values (
      p_company, v_period_id, p_date, p_currency, 1, p_memo, 'draft',
      'corr_' || gen_random_uuid(), coalesce(p_idempotency_key, 'jm_' || gen_random_uuid()), md5(p_lines::text), v_new_fp,
      round(v_total_debit,2), round(v_total_credit,2), now(), p_actor, p_actor
    ) returning id into v_journal_id;
  exception when unique_violation then
    if p_idempotency_key is not null then
      select id, idem_fingerprint into v_journal_id, v_existing_fp
      from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key;
      if v_journal_id is not null then
        if v_existing_fp is not null then
          if left(v_existing_fp,3) = 'v2:' then
            if v_existing_fp <> public._fp_full(p_operation, p_company, p_source_type, p_source_id, p_date, p_currency, p_memo, p_lines) then raise exception 'idempotency key reused with a different operation (conflict)'; end if;
          elsif v_existing_fp <> v_new_fp then
            raise exception 'idempotency key reused with a different operation (conflict)';
          end if;
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
      round(coalesce((v_line->>'debit')::numeric,0),2), round(coalesce((v_line->>'credit')::numeric,0),2),
      v_line->>'description', v_line_no);
  end loop;

  update journal_entries set status = 'posted' where id = v_journal_id;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, coalesce(p_actor_type,'user'), p_actor, 'journal.posted', 'journal', v_journal_id,
          jsonb_build_object('total', round(v_total_debit,2), 'memo', p_memo, 'operation', p_operation), p_idempotency_key);
  return v_journal_id;
end $function$;

INSERT INTO schema_migrations (version, filename) VALUES ('0051','0051_wp14_canonical_json_fingerprint.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0052_wp15_invoice_bill_invariants.sql
-- ==========================================================================

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

INSERT INTO schema_migrations (version, filename) VALUES ('0052','0052_wp15_invoice_bill_invariants.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0053_wp16_reimbursement_reuse_validation.sql
-- ==========================================================================

-- 0053_wp16_reimbursement_reuse_validation.sql
-- Correction brief 0048 — WP16: complete reimbursement/payment reuse validation.
--
-- Problems in reimburse_expense_claim (0044):
--   1. the already-reimbursed branch returned the prior journal from an arbitrary
--      reimbursement→payment join WITHOUT confirming the reimbursement, payment, claim and
--      journal form one consistent, source-bound chain — a corrupt/partial chain (or a claim
--      marked reimbursed with no payment at all) was returned as success, and the supplied
--      date/key/accounts were ignored;
--   2. the payment-reuse check validated only party_id, amount, currency and direction — not
--      party_type, payment date, status, method or the journal binding — so a key reused with a
--      different payment date/method/status/journal slipped through as "the same payment".
--
-- Fix (CREATE OR REPLACE; no data change, same signature so existing grants hold): on ANY reuse
-- validate the full material payload — company (scope), source claim, party_type = 'employee',
-- party id, amount, currency, direction, payment date, journal id, status, method, and the
-- effective idempotency key — and re-derive the source-bound journal through
-- _journal_post_internal, which binds company, source claim, date, currency and lines under this
-- key (WP14) and so supplies the canonical source fingerprint. The prior result is returned only
-- when the whole chain is consistent; otherwise a conflict is raised. The capability gate,
-- approved-only lifecycle, and separation-of-duties (human maker ≠ claimant) are unchanged.
--
-- Forward-only.

create or replace function public.reimburse_expense_claim(
  p_company uuid, p_claim uuid, p_expense_code text, p_cash_code text, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text; v_currency text; v_amount numeric; v_status text; v_employee uuid; v_claimant uuid;
        v_journal uuid; v_lines jsonb; v_idem text;
        v_pay_id uuid; v_pay_journal uuid; v_pay_ptype text; v_pay_party uuid; v_pay_amt numeric; v_pay_ccy text;
        v_pay_dir text; v_pay_status text; v_pay_method text; v_pay_pdate date; v_pay_key text;
        v_r_emp uuid; v_r_amt numeric; v_r_ccy text; v_r_status text;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type='user' and not public.has_capability(p_company,'finance.payment.record') then raise exception 'missing capability finance.payment.record'; end if;
  select currency, amount, status, employee_id into v_currency, v_amount, v_status, v_employee
  from expense_claims where id=p_claim and company_id=p_company for update;
  if v_currency is null then raise exception 'Claim not found'; end if;

  v_idem := coalesce(p_idempotency_key, 'reimburse:'||p_claim);
  v_lines := jsonb_build_array(
    jsonb_build_object('account_code',p_expense_code,'debit',v_amount,'credit',0,'description','Expense reimbursement'),
    jsonb_build_object('account_code',p_cash_code,'debit',0,'credit',v_amount,'description','Expense reimbursement'));

  if v_status = 'reimbursed' then
    -- Idempotent return ONLY after proving reimbursement→payment→journal is one consistent,
    -- source-bound chain for THIS claim (WP16). Load the single paid reimbursement + its payment.
    select r.employee_id, r.amount, r.currency, r.status,
           p.id, p.journal_id, p.party_type, p.party_id, p.amount, p.currency, p.direction, p.status, p.method, p.payment_date, p.idempotency_key
      into v_r_emp, v_r_amt, v_r_ccy, v_r_status,
           v_pay_id, v_pay_journal, v_pay_ptype, v_pay_party, v_pay_amt, v_pay_ccy, v_pay_dir, v_pay_status, v_pay_method, v_pay_pdate, v_pay_key
    from reimbursements r join payments p on p.id = r.payment_id and p.company_id = r.company_id
    where r.company_id = p_company and r.expense_claim_id = p_claim and r.status = 'paid'
    limit 1;
    if v_pay_id is null or v_pay_journal is null then
      raise exception 'Reimbursed claim % has no consistent payment/journal chain (corrupt state)', p_claim;
    end if;
    if v_pay_key is distinct from v_idem
       or v_r_emp is distinct from v_employee or round(v_r_amt,2) <> round(v_amount,2) or v_r_ccy <> v_currency or v_r_status <> 'paid'
       or v_pay_ptype is distinct from 'employee' or v_pay_party is distinct from v_employee
       or round(v_pay_amt,2) <> round(v_amount,2) or v_pay_ccy <> v_currency or v_pay_dir <> 'out'
       or v_pay_status <> 'recorded' or v_pay_method <> 'record' or v_pay_pdate <> p_date then
      raise exception 'reimbursement reuse does not match the recorded source-bound chain (conflict)';
    end if;
    -- Re-derive the source-bound journal under this key: binds company/source-claim/date/currency/
    -- lines (WP14) and returns the existing journal, or conflicts on a changed operation.
    v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Expense reimbursement', v_actor, v_type, v_lines, v_idem, 'expense_claim.reimburse', 'expense_claim', p_claim);
    if v_pay_journal is distinct from v_journal then raise exception 'reimbursed claim journal binding mismatch (conflict)'; end if;
    return v_journal;
  end if;

  if v_status <> 'approved' then raise exception 'Only an approved claim can be reimbursed (is %)', v_status; end if;
  select user_id into v_claimant from employees where id=v_employee and company_id=p_company;
  if v_claimant is not null and v_claimant = v_actor then raise exception 'cannot reimburse your own expense claim'; end if;

  -- Journal fingerprint binds source='expense_claim'/p_claim → the key can't post another claim.
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Expense reimbursement', v_actor, v_type, v_lines, v_idem, 'expense_claim.reimburse', 'expense_claim', p_claim);

  -- Payment: bind + validate ALL material fields on reuse (WP16) — no blind attach.
  select id, journal_id, party_type, party_id, amount, currency, direction, status, method, payment_date
    into v_pay_id, v_pay_journal, v_pay_ptype, v_pay_party, v_pay_amt, v_pay_ccy, v_pay_dir, v_pay_status, v_pay_method, v_pay_pdate
  from payments where company_id=p_company and idempotency_key=v_idem;
  if v_pay_id is not null then
    if v_pay_journal is distinct from v_journal or v_pay_ptype is distinct from 'employee' or v_pay_party is distinct from v_employee
       or round(v_pay_amt,2) <> round(v_amount,2) or v_pay_ccy <> v_currency or v_pay_dir <> 'out'
       or v_pay_status <> 'recorded' or v_pay_method <> 'record' or v_pay_pdate <> p_date then
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

INSERT INTO schema_migrations (version, filename) VALUES ('0053','0053_wp16_reimbursement_reuse_validation.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0054_wp11_approval_scope_currency_delegation.sql
-- ==========================================================================

-- 0054_wp11_approval_scope_currency_delegation.sql
-- Correction brief 0048 — WP11: complete approval authority (organisational scope, currency,
-- and delegation bounds).
--
-- Problems in decide_approval / within_authority (0046):
--   1. authority was checked for capability, maker-checker, lifecycle, amount, currency and domain,
--      but NOT for organisational scope — a division/project/site/cost-centre-restricted approver
--      could approve a financial event allocated to a scope they do not control, and an event could
--      be split across allocations to dodge scope; the amount ceiling was also not clearly compared
--      to the WHOLE event.
--   2. the delegated-authority branch checked the delegation's currency but NOT the delegator's own
--      `authority_rules.currency` against the event — a currency-restricted delegator could confer
--      effective authority in another currency.
--
-- Fix (additive schema + a new event-aware authority function; no data reinterpretation):
--   * authority_rules and delegations gain an explicit `is_company_wide` flag and
--     division/project/site/cost-centre scope columns. Existing rows default to
--     is_company_wide = FALSE with NULL scope — i.e. they authorise NOTHING until an owner
--     explicitly scopes them (requirement #3: no silent widening to company-wide).
--   * `within_authority_for_event(company, financial_event_id)` evaluates, for auth.uid():
--       active membership; domain; event currency (strict — a NULL rule/delegation currency does
--       NOT mean "all currencies", requirement #7); the WHOLE event amount vs the ceiling
--       (splitting across allocations cannot bypass it, requirement #5); every allocation within an
--       authorised scope (requirement #6); explicit company-wide authority when the event has no
--       allocations; delegation validity window, amount and currency; and the delegation scope being
--       a SUBSET of the delegator's own active, currency-matched, sufficient authority.
--   * decide_approval now authorises a financial event through this function.
--
-- NOT changed here (deliberate): requirement #8 (replacing the generic `approve` capability with a
-- domain-specific approval capability) is an owner-gated change to the permission catalogue and role
-- map; CLAUDE.md forbids autonomously changing permissions/approvals. The generic `approve`
-- capability remains the gate; the substantive amount/currency/scope/delegation authority is now
-- enforced by within_authority_for_event. The domain-capability split is a documented follow-up.
--
-- Forward-only, idempotent. `within_authority` (0046) is left intact for non-event callers.

-- ── Schema: explicit company-wide flag + organisational scope ─────────────────
alter table authority_rules add column if not exists is_company_wide boolean not null default false;
alter table authority_rules add column if not exists division_id    uuid references divisions(id);
alter table authority_rules add column if not exists project_id     uuid references projects(id);
alter table authority_rules add column if not exists site_id        uuid references sites(id);
alter table authority_rules add column if not exists cost_centre_id uuid references cost_centres(id);

alter table delegations add column if not exists is_company_wide boolean not null default false;
alter table delegations add column if not exists division_id    uuid references divisions(id);
alter table delegations add column if not exists project_id     uuid references projects(id);
alter table delegations add column if not exists site_id        uuid references sites(id);
alter table delegations add column if not exists cost_centre_id uuid references cost_centres(id);

-- ── Scope-cover predicate ─────────────────────────────────────────────────────
-- Does a COVERER scope (c_*) cover a TARGET scope (t_*)?  A company-wide coverer covers anything;
-- a company-wide target needs a company-wide coverer; an empty (all-null, non-company-wide) coverer
-- covers nothing (no silent widening); otherwise every dimension the coverer constrains must equal
-- the target's. Used both for allocation coverage (target = an allocation, t_cw = false) and for the
-- delegation-⊆-delegator subset check (target = the delegation's scope).
create or replace function public._scope_covers(
  c_cw boolean, c_div uuid, c_proj uuid, c_site uuid, c_cc uuid,
  t_cw boolean, t_div uuid, t_proj uuid, t_site uuid, t_cc uuid
) returns boolean language sql immutable set search_path = public as $$
  select case
    when coalesce(c_cw, false) then true
    when coalesce(t_cw, false) then false
    when c_div is null and c_proj is null and c_site is null and c_cc is null then false
    else (c_div  is null or c_div  = t_div)
     and (c_proj is null or c_proj = t_proj)
     and (c_site is null or c_site = t_site)
     and (c_cc   is null or c_cc   = t_cc)
  end;
$$;

-- ── Event-aware authority (deny-by-default) ───────────────────────────────────
create or replace function public.within_authority_for_event(p_company uuid, p_event uuid)
returns boolean language sql stable security definer set search_path = public as $$
  with ev as (
    select amount, currency, coalesce(event_type, 'payment') as domain
    from financial_events where id = p_event and company_id = p_company
  ),
  alloc as (
    select division_id, project_id, site_id, cost_centre_id
    from financial_event_allocations where financial_event_id = p_event and company_id = p_company
  ),
  -- Qualifying bases for auth.uid(): domain + strict currency + WHOLE-event amount ceiling.
  -- Each row is a scope the approver may act within.
  own_basis as (
    select ar.is_company_wide as cw, ar.division_id, ar.project_id, ar.site_id, ar.cost_centre_id
    from ev
    join memberships m on m.user_id = auth.uid() and m.company_id = p_company and m.status = 'active'
    join authority_rules ar on ar.membership_id = m.id and ar.company_id = p_company
    where ar.domain = ev.domain
      and ar.currency is not null and ar.currency = ev.currency
      and (ar.is_unlimited or (ar.max_amount is not null and ev.amount <= ar.max_amount))
  ),
  del_basis as (
    -- Delegated authority: the delegation defines the scope the delegate may act within, and it must
    -- be a SUBSET of the delegator's own currency-matched, sufficient, active authority.
    select d.is_company_wide as cw, d.division_id, d.project_id, d.site_id, d.cost_centre_id
    from ev
    join delegations d on d.company_id = p_company and now() between d.starts_at and d.ends_at
    join memberships tm on tm.id = d.to_membership and tm.user_id = auth.uid() and tm.status = 'active'
    join memberships fm on fm.id = d.from_membership and fm.status = 'active'
    where (d.domain = ev.domain or d.domain is null)
      and d.currency is not null and d.currency = ev.currency
      and d.max_amount is not null and ev.amount <= d.max_amount
      and exists (
        select 1 from authority_rules ar2
        where ar2.membership_id = fm.id and ar2.company_id = p_company and ar2.domain = ev.domain
          and ar2.currency is not null and ar2.currency = ev.currency
          and (ar2.is_unlimited or (ar2.max_amount is not null and ev.amount <= ar2.max_amount))
          and public._scope_covers(ar2.is_company_wide, ar2.division_id, ar2.project_id, ar2.site_id, ar2.cost_centre_id,
                                   d.is_company_wide, d.division_id, d.project_id, d.site_id, d.cost_centre_id)
      )
  ),
  basis as (select * from own_basis union all select * from del_basis)
  select case
    when not exists (select 1 from ev) then false
    when not exists (select 1 from alloc) then
      exists (select 1 from basis where cw)                              -- no allocations → company-wide only
    else
      exists (select 1 from basis)                                       -- at least one qualifying basis, and…
      and not exists (                                                   -- …no allocation left uncovered
        select 1 from alloc a
        where not exists (
          select 1 from basis b
          where public._scope_covers(b.cw, b.division_id, b.project_id, b.site_id, b.cost_centre_id,
                                     false, a.division_id, a.project_id, a.site_id, a.cost_centre_id)
        )
      )
  end;
$$;

-- ── decide_approval: authorise a financial event through the event-aware function ──
create or replace function public.decide_approval(
  p_company uuid, p_request uuid, p_action text, p_note text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text; v_required int; v_maker uuid; v_fe uuid; v_amount numeric; v_ccy text; v_approvals int; v_new_status text;
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

  -- Deny-by-default amount/currency/scope authority when the request carries a financial event.
  if p_action = 'approve' and v_fe is not null then
    select amount, currency into v_amount, v_ccy from financial_events where id = v_fe and company_id = p_company;
    if v_amount is not null and not public.within_authority_for_event(p_company, v_fe) then
      raise exception 'event %/% is outside your approval authority (amount, currency or organisational scope)', v_amount, v_ccy;
    end if;
  end if;

  begin
    insert into approval_actions (approval_request_id, company_id, actor_user_id, action, note)
    values (p_request, p_company, auth.uid(), p_action, p_note);
  exception when unique_violation then
    null;   -- already acted → no double count; fall through to recompute status.
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

-- ── Grants ────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.within_authority_for_event(uuid, uuid) from public;
    grant execute on function public.within_authority_for_event(uuid, uuid) to authenticated, service_role;
    revoke all on function public.decide_approval(uuid,uuid,text,text) from public;
    grant execute on function public.decide_approval(uuid,uuid,text,text) to authenticated, service_role;
  end if;
end $$;

INSERT INTO schema_migrations (version, filename) VALUES ('0054','0054_wp11_approval_scope_currency_delegation.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0055_wp12_truthful_delivery_state.sql
-- ==========================================================================

-- 0055_wp12_truthful_delivery_state.sql
-- Correction brief 0048 — WP12: make quotation/order delivery state truthful.
--
-- Problem. `tryFinalizeAndSend()` enqueued a WhatsApp message, ran a best-effort inline outbox
-- drain, and then IMMEDIATELY marked the quotation `sent`, the order `quoted` and the conversation
-- `quoted`, returning `{ sent: true }` even when the provider send or the durable completion had
-- failed. The commercial document lied about delivery.
--
-- Fix (this migration provides the DB half):
--   * `message_outbox` gains `source_type`, `source_id`, `message_purpose` so a completed send can
--     advance the exact linked document (no secrets stored).
--   * `quotations.status` gains an explicit **`queued`** state (draft → awaiting_price → ready →
--     queued → sent). The app marks the quotation `queued` on enqueue, NOT `sent`.
--   * `complete_outbox_and_advance(outbox_id, lease_owner, provider_message_id)` — a fenced,
--     service-only RPC that ATOMICALLY: verifies the outbox id + lease owner (only a 'processing'
--     row owned by this worker), records the provider message id, flips the outbox row to `sent`,
--     advances the linked quotation → `sent` / order → `quoted` / conversation → `quoted`
--     (company-scoped, so a cross-company source id can never be linked or advanced; terminal
--     order/conversation states are never regressed), and writes a non-sensitive audit event.
--     Returns TRUE only when exactly one owned row was completed; a zero-row/wrong-lease/duplicate
--     call returns FALSE and advances nothing.
--
-- Delivery is AT-LEAST-ONCE: a provider-success / DB-failure window can still cause a retry, so the
-- lease does NOT make duplicate external delivery impossible. `delivered` (a later state) may only
-- be set from a verified provider callback — not modelled here.
--
-- Forward-only, idempotent. Grants are service-role only.

-- ── 1. Outbox source metadata (no secrets) ───────────────────────────────────
alter table message_outbox add column if not exists source_type    text;
alter table message_outbox add column if not exists source_id      uuid;
alter table message_outbox add column if not exists message_purpose text;

-- ── 2. Truthful quotation lifecycle: add the explicit `queued` state ──────────
alter table quotations drop constraint if exists quotations_status_check;
alter table quotations add constraint quotations_status_check
  check (status in ('draft','awaiting_price','ready','queued','sent','accepted','rejected'));

-- ── 3. Fenced, service-only completion that advances the linked document ──────
create or replace function public.complete_outbox_and_advance(
  p_outbox_id uuid, p_lease_owner text, p_provider_message_id text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_src_type text; v_src_id uuid; v_order uuid; v_conv uuid;
begin
  -- Fence: only the current lease owner may complete a still-'processing' row. This flips the
  -- outbox row to `sent` and returns its identity in one atomic step.
  update message_outbox
     set status = 'sent', sent_at = now(), provider_message_id = p_provider_message_id,
         locked_at = null, lock_owner = null, lease_expires_at = null
   where id = p_outbox_id and lock_owner = p_lease_owner and status = 'processing'
   returning company_id, source_type, source_id into v_company, v_src_type, v_src_id;
  if not found then
    return false;  -- zero-row / wrong-lease / already-completed → nothing advanced
  end if;

  -- Advance the linked commercial document TRUTHFULLY, company-scoped (a cross-company source id
  -- matches no row here, so it can never be linked or advanced). Only on a real state change.
  if v_src_type = 'quotation' and v_src_id is not null then
    update quotations set status = 'sent', sent_at = now()
      where id = v_src_id and company_id = v_company and status in ('queued','ready')
      returning order_id into v_order;
    if found then
      if v_order is not null then
        -- new → quoted; keep quoted; never regress a confirmed/cancelled order.
        update orders set status = 'quoted', updated_at = now()
          where id = v_order and company_id = v_company and status not in ('confirmed','cancelled');
        select conversation_id into v_conv from orders where id = v_order and company_id = v_company;
        if v_conv is not null then
          update wa_conversations set status = 'quoted', updated_at = now()
            where id = v_conv and company_id = v_company and status <> 'closed';
        end if;
      end if;
      insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
      values (v_company, 'system', null, 'quotation.sent', 'quotation', v_src_id,
              jsonb_build_object('outbox_id', p_outbox_id, 'provider_message_id', p_provider_message_id));
    end if;
  end if;
  return true;
end $$;

-- ── 4. Grants: service-only (the drain worker runs as service_role) ───────────
do $$
begin
  revoke all on function public.complete_outbox_and_advance(uuid, text, text) from public;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.complete_outbox_and_advance(uuid, text, text) to service_role;
  end if;
end $$;

INSERT INTO schema_migrations (version, filename) VALUES ('0055','0055_wp12_truthful_delivery_state.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0056_wp15_source_binding_fingerprint.sql
-- ==========================================================================

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

INSERT INTO schema_migrations (version, filename) VALUES ('0056','0056_wp15_source_binding_fingerprint.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0057_wp11_approval_failclose_domain_caps.sql
-- ==========================================================================

-- 0057_wp11_approval_failclose_domain_caps.sql
-- Phase 1 external-review correction C — WP11 approval authority still had fail-open and audit
-- defects, and the generic `approve` capability was broader than the domain-specific model.
--
-- Confirmed defects (migration 0054 / 0046):
--   1. decide_approval enforced event authority only for `approve` — an out-of-scope holder of the
--      generic capability could `reject` another scope's request.
--   2. A missing/cross-company financial event, or a NULL event amount/currency, SKIPPED authority
--      enforcement and proceeded (fail-open).
--   3. A user who already approved a multi-approval request could call `reject`: the duplicate
--      action insert was swallowed, yet the request still transitioned to `rejected` with no
--      matching approval_actions row.
--   4. within_authority_for_event's delegation joins did not require the from/to memberships to
--      belong to p_company (a cross-company membership path under corrupt/adversarial data).
--   5. The generic `approve` capability was never replaced by domain-specific approval authority.
--
-- Fix (this migration): a deterministic, fail-closed domain->capability whitelist; authority
-- (capability + amount/currency/scope) enforced for BOTH approve and reject on a financial event;
-- fail-closed on missing/cross-company event and NULL amount/currency/unknown domain; duplicate
-- actor action is a conflict on a DIFFERENT action (no state/audit change) and idempotent on the
-- same; audit is written only for a persisted new action; delegation requires from/to memberships
-- active in p_company.
--
-- Legacy-data preflight (owner should run before enabling, remediate any rows):
--   -- approval requests whose financial event is in another company (should be 0):
--   --   select ar.id from approval_requests ar join financial_events fe on fe.id=ar.financial_event_id
--   --     where fe.company_id <> ar.company_id;
--   -- delegations whose memberships are in another company (should be 0):
--   --   select d.id from delegations d
--   --     join memberships fm on fm.id=d.from_membership join memberships tm on tm.id=d.to_membership
--   --     where fm.company_id <> d.company_id or tm.company_id <> d.company_id;
-- The RPC below fails closed on these regardless, so they cannot be exploited; hard composite FKs
-- are deferred to a preflight-gated follow-up to avoid failing a migration on legacy rows.
--
-- Forward-only. Permission-catalogue change authorised by the owner for this correction increment
-- (code only; not enabled in any hosted environment).

-- ── 1. Domain-specific approval capabilities (catalogue + role map) ───────────
insert into permissions(key, label) values
  ('finance.approve.payment','Approve payments'),
  ('finance.approve.expense','Approve expenses/claims'),
  ('finance.approve.sales','Approve sales documents'),
  ('finance.approve.purchase','Approve purchase documents')
on conflict do nothing;

insert into role_permissions (role_key, permission_key) values
  -- Broad financial approvers get every domain.
  ('owner_management','finance.approve.payment'), ('owner_management','finance.approve.expense'),
  ('owner_management','finance.approve.sales'),   ('owner_management','finance.approve.purchase'),
  ('finance_reviewer','finance.approve.payment'), ('finance_reviewer','finance.approve.expense'),
  ('finance_reviewer','finance.approve.sales'),   ('finance_reviewer','finance.approve.purchase'),
  ('system_administrator','finance.approve.payment'), ('system_administrator','finance.approve.expense'),
  ('system_administrator','finance.approve.sales'),   ('system_administrator','finance.approve.purchase'),
  -- Narrow approvers: project/division managers approve expenses/claims within scope; the payment
  -- approver approves payments only. Neither can approve unrelated domains (fail-closed matrix).
  ('project_manager','finance.approve.expense'),
  ('payment_approver','finance.approve.payment')
on conflict do nothing;

-- ── 2. Deterministic domain -> capability whitelist (fail-closed) ─────────────
-- Maps a financial event's domain (event_type / authority domain) to the single approval capability
-- required. Unknown/unmapped domains return NULL, which the RPC treats as DENY. No AI/free-text path
-- chooses the capability.
create or replace function public._approval_capability(p_domain text)
returns text language sql immutable set search_path = public as $$
  select case lower(coalesce(p_domain,''))
    when 'payment' then 'finance.approve.payment'
    when 'expense_payment' then 'finance.approve.payment'
    when 'supplier_payment' then 'finance.approve.payment'
    when 'refund' then 'finance.approve.payment'
    when 'bank_transfer' then 'finance.approve.payment'
    when 'expense' then 'finance.approve.expense'
    when 'expense_claim' then 'finance.approve.expense'
    when 'reimbursement' then 'finance.approve.expense'
    when 'employee_advance' then 'finance.approve.expense'
    when 'advance_settlement' then 'finance.approve.expense'
    when 'customer_invoice' then 'finance.approve.sales'
    when 'customer_receipt' then 'finance.approve.sales'
    when 'credit_note' then 'finance.approve.sales'
    when 'supplier_bill' then 'finance.approve.purchase'
    when 'supplier_credit' then 'finance.approve.purchase'
    else null   -- unknown / 'unknown' / NULL → no capability → deny
  end;
$$;

-- ── 3. within_authority_for_event: delegation memberships must be in p_company ─
create or replace function public.within_authority_for_event(p_company uuid, p_event uuid)
returns boolean language sql stable security definer set search_path = public as $$
  with ev as (
    select amount, currency, coalesce(event_type, 'payment') as domain
    from financial_events where id = p_event and company_id = p_company
  ),
  alloc as (
    select division_id, project_id, site_id, cost_centre_id
    from financial_event_allocations where financial_event_id = p_event and company_id = p_company
  ),
  own_basis as (
    select ar.is_company_wide as cw, ar.division_id, ar.project_id, ar.site_id, ar.cost_centre_id
    from ev
    join memberships m on m.user_id = auth.uid() and m.company_id = p_company and m.status = 'active'
    join authority_rules ar on ar.membership_id = m.id and ar.company_id = p_company
    where ar.domain = ev.domain
      and ar.currency is not null and ar.currency = ev.currency
      and (ar.is_unlimited or (ar.max_amount is not null and ev.amount <= ar.max_amount))
  ),
  del_basis as (
    select d.is_company_wide as cw, d.division_id, d.project_id, d.site_id, d.cost_centre_id
    from ev
    join delegations d on d.company_id = p_company and now() between d.starts_at and d.ends_at
    join memberships tm on tm.id = d.to_membership and tm.user_id = auth.uid() and tm.status = 'active' and tm.company_id = p_company
    join memberships fm on fm.id = d.from_membership and fm.status = 'active' and fm.company_id = p_company
    where (d.domain = ev.domain or d.domain is null)
      and d.currency is not null and d.currency = ev.currency
      and d.max_amount is not null and ev.amount <= d.max_amount
      and exists (
        select 1 from authority_rules ar2
        where ar2.membership_id = fm.id and ar2.company_id = p_company and ar2.domain = ev.domain
          and ar2.currency is not null and ar2.currency = ev.currency
          and (ar2.is_unlimited or (ar2.max_amount is not null and ev.amount <= ar2.max_amount))
          and public._scope_covers(ar2.is_company_wide, ar2.division_id, ar2.project_id, ar2.site_id, ar2.cost_centre_id,
                                   d.is_company_wide, d.division_id, d.project_id, d.site_id, d.cost_centre_id)
      )
  ),
  basis as (select * from own_basis union all select * from del_basis)
  select case
    when not exists (select 1 from ev) then false
    when not exists (select 1 from alloc) then exists (select 1 from basis where cw)
    else
      exists (select 1 from basis)
      and not exists (
        select 1 from alloc a
        where not exists (
          select 1 from basis b
          where public._scope_covers(b.cw, b.division_id, b.project_id, b.site_id, b.cost_centre_id,
                                     false, a.division_id, a.project_id, a.site_id, a.cost_centre_id)
        )
      )
  end;
$$;

-- ── 4. decide_approval: fail-closed, domain-capability, reject-authority, audit-only-persisted ──
create or replace function public.decide_approval(
  p_company uuid, p_request uuid, p_action text, p_note text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text; v_required int; v_maker uuid; v_fe uuid;
        v_amount numeric; v_ccy text; v_domain text; v_cap text; v_prev text;
        v_found boolean; v_approvals int; v_new_status text;
begin
  if public.caller_jwt_role() = 'anon' or auth.uid() is null then raise exception 'approvals require an authenticated user'; end if;
  if p_action not in ('approve','reject') then raise exception 'action must be approve or reject'; end if;

  select status, approvals_required, submitted_by, financial_event_id
    into v_status, v_required, v_maker, v_fe
  from approval_requests where id = p_request and company_id = p_company for update;
  if not found then raise exception 'Approval request not found'; end if;
  if v_status <> 'pending' then raise exception 'Approval request is not pending (is %)', v_status; end if;
  if v_maker = auth.uid() then raise exception 'the maker cannot approve their own request (separation of duties)'; end if;

  if v_fe is not null then
    -- A financial-event decision (approve OR reject) is deny-by-default: the event must exist in
    -- THIS company with valid money fields and a known domain; the caller must hold the
    -- domain-specific approval capability AND be within amount/currency/organisational scope.
    select amount, currency, coalesce(event_type,'payment') into v_amount, v_ccy, v_domain
    from financial_events where id = v_fe and company_id = p_company;
    if not found then raise exception 'financial event not found in this company (fail-closed)'; end if;
    if v_amount is null or v_ccy is null then raise exception 'financial event is missing amount/currency (fail-closed)'; end if;
    v_cap := public._approval_capability(v_domain);
    if v_cap is null then raise exception 'no approval capability defined for domain % (fail-closed)', v_domain; end if;
    if not public.has_capability(p_company, v_cap) then raise exception 'missing approval capability %', v_cap; end if;
    if not public.within_authority_for_event(p_company, v_fe) then
      raise exception 'event %/% is outside your approval authority (amount, currency or organisational scope)', v_amount, v_ccy;
    end if;
  else
    -- Non-financial request: the baseline approve/reject capability gates the matching action.
    if not public.has_capability(p_company, p_action) then raise exception 'missing capability %', p_action; end if;
  end if;

  -- Duplicate actor action: conflict on a DIFFERENT action (no state/audit change); idempotent on
  -- the same action (no re-transition, no new audit).
  select action into v_prev from approval_actions where approval_request_id = p_request and actor_user_id = auth.uid() limit 1;
  if v_prev is not null then
    if v_prev <> p_action then raise exception 'conflicting decision: this actor already recorded a %; refusing %', v_prev, p_action; end if;
    return v_status;  -- same action again → idempotent
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

  -- Audit only the action that actually persisted (linked to this actor's decision).
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, 'user', auth.uid(), 'approval.' || p_action, 'approval_request', p_request,
          jsonb_build_object('status', v_new_status, 'actor_action', p_action));
  return v_new_status;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.decide_approval(uuid,uuid,text,text) from public;
    grant execute on function public.decide_approval(uuid,uuid,text,text) to authenticated, service_role;
  end if;
end $$;

INSERT INTO schema_migrations (version, filename) VALUES ('0057','0057_wp11_approval_failclose_domain_caps.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0058_wp12_message_history_on_completion.sql
-- ==========================================================================

-- 0058_wp12_message_history_on_completion.sql
-- Phase 1 external-review correction A — WP12: message history must not look "sent" while a
-- quotation is only queued/failed. Previously tryFinalizeAndSend() inserted an outbound wa_messages
-- row at enqueue time (before provider success) and could duplicate it on retries.
--
-- Fix: create the outbound message-history row ATOMICALLY inside the fenced completion RPC — only
-- when the provider send is durably recorded — carrying the provider message id. The RPC completes
-- an outbox row exactly once (processing → sent under the lease fence), so the history row is
-- created exactly once; a retried/duplicate completion returns false and inserts nothing. Queued /
-- failed / dead states remain visible on message_outbox; wa_messages holds only real (sent) records.
--
-- Forward-only; CREATE OR REPLACE of complete_outbox_and_advance. No data change. Service-only grant
-- unchanged (from 0055).

create or replace function public.complete_outbox_and_advance(
  p_outbox_id uuid, p_lease_owner text, p_provider_message_id text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_src_type text; v_src_id uuid; v_order uuid; v_conv uuid; v_body text;
begin
  update message_outbox
     set status = 'sent', sent_at = now(), provider_message_id = p_provider_message_id,
         locked_at = null, lock_owner = null, lease_expires_at = null
   where id = p_outbox_id and lock_owner = p_lease_owner and status = 'processing'
   returning company_id, source_type, source_id, body into v_company, v_src_type, v_src_id, v_body;
  if not found then
    return false;  -- zero-row / wrong-lease / already-completed → nothing advanced
  end if;

  if v_src_type = 'quotation' and v_src_id is not null then
    update quotations set status = 'sent', sent_at = now()
      where id = v_src_id and company_id = v_company and status in ('queued','ready')
      returning order_id into v_order;
    if found then
      if v_order is not null then
        update orders set status = 'quoted', updated_at = now()
          where id = v_order and company_id = v_company and status not in ('confirmed','cancelled');
        select conversation_id into v_conv from orders where id = v_order and company_id = v_company;
        if v_conv is not null then
          update wa_conversations set status = 'quoted', updated_at = now()
            where id = v_conv and company_id = v_company and status <> 'closed';
          -- Outbound message HISTORY is written here — on durable provider success only — with the
          -- provider message id. This is the single writer, so it is created exactly once.
          insert into wa_messages (conversation_id, company_id, direction, body, wa_message_id)
          values (v_conv, v_company, 'outbound', v_body, p_provider_message_id);
        end if;
      end if;
      insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
      values (v_company, 'system', null, 'quotation.sent', 'quotation', v_src_id,
              jsonb_build_object('outbox_id', p_outbox_id, 'provider_message_id', p_provider_message_id));
    end if;
  end if;
  return true;
end $$;

do $$
begin
  revoke all on function public.complete_outbox_and_advance(uuid, text, text) from public;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.complete_outbox_and_advance(uuid, text, text) to service_role;
  end if;
end $$;

INSERT INTO schema_migrations (version, filename) VALUES ('0058','0058_wp12_message_history_on_completion.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0059_wp15_fp_matches_privilege.sql
-- ==========================================================================

-- 0059_wp15_fp_matches_privilege.sql
-- Phase 1 SECOND external-review correction — WP15: `_journal_fp_matches` (added 0056) is an
-- INTERNAL helper called only from the SECURITY DEFINER posting RPCs, but it was left EXECUTE-able
-- by PUBLIC (hence anon and authenticated). A SECURITY DEFINER helper reachable by untrusted roles
-- is an unnecessary attack surface (it can probe stored journal fingerprints).
--
-- Fix: REVOKE EXECUTE from PUBLIC, anon and authenticated. The definer posters
-- (post_customer_invoice / post_supplier_bill) run as their owner and call it regardless, so posting
-- is unaffected; no external/worker path calls it directly.
--
-- Forward-only, idempotent.

do $$
declare v_sig text := 'public._journal_fp_matches(uuid, text, uuid, text, uuid, date, text, text, jsonb)';
begin
  execute format('revoke all on function %s from public', v_sig);
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute format('revoke all on function %s from anon', v_sig);
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute format('revoke all on function %s from authenticated', v_sig);
  end if;
end $$;

INSERT INTO schema_migrations (version, filename) VALUES ('0059','0059_wp15_fp_matches_privilege.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0060_wp11_composite_fk_money_failclose.sql
-- ==========================================================================

-- 0060_wp11_composite_fk_money_failclose.sql
-- Phase 1 SECOND external-review correction — WP11:
--   (1) add company-consistent COMPOSITE constraints so an approval_request cannot reference a
--       financial_event in another company, and an approval_action cannot reference an
--       approval_request in another company (defence beyond the RPC's fail-closed checks);
--   (2) decide_approval also fails closed on a non-positive/non-finite amount, an invalid currency,
--       and an invalid approvals_required.
--
-- Legacy-data preflight (owner runs before VALIDATE; NOT VALID already enforces new/updated rows):
--   select ar.id from approval_requests ar join financial_events fe on fe.id = ar.financial_event_id
--     where fe.company_id is distinct from ar.company_id;                       -- must be 0
--   select aa.id from approval_actions aa join approval_requests ar on ar.id = aa.approval_request_id
--     where ar.company_id is distinct from aa.company_id;                       -- must be 0
-- When both return 0 rows the owner may VALIDATE the two NOT VALID constraints below.
--
-- Forward-only, idempotent. `id` is already unique, so the composite UNIQUE targets always hold
-- (no data-rewrite risk). The FKs are NOT VALID (enforce new rows; legacy validated post-preflight).

-- Composite UNIQUE targets (superset of the existing PK on id → always satisfied).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'financial_events_company_id_uk') then
    alter table financial_events add constraint financial_events_company_id_uk unique (company_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_requests_company_id_uk') then
    alter table approval_requests add constraint approval_requests_company_id_uk unique (company_id, id);
  end if;
end $$;

-- Company-consistent composite FKs (MATCH SIMPLE: a NULL financial_event_id skips the check, so
-- non-financial approval requests are unaffected).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'approval_requests_fe_company_fk') then
    alter table approval_requests
      add constraint approval_requests_fe_company_fk
      foreign key (company_id, financial_event_id) references financial_events (company_id, id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_actions_request_company_fk') then
    alter table approval_actions
      add constraint approval_actions_request_company_fk
      foreign key (company_id, approval_request_id) references approval_requests (company_id, id) not valid;
  end if;
end $$;

-- decide_approval: add fail-closed money + approvals_required validation (everything else unchanged from 0057).
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
    if v_ccy !~ '^[A-Za-z]{3}$' then raise exception 'financial event currency is invalid (fail-closed)'; end if;
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

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.decide_approval(uuid,uuid,text,text) from public;
    grant execute on function public.decide_approval(uuid,uuid,text,text) to authenticated, service_role;
  end if;
end $$;

INSERT INTO schema_migrations (version, filename) VALUES ('0060','0060_wp11_composite_fk_money_failclose.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0061_final_review_currency_enqueue_reconcile.sql
-- ==========================================================================

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

INSERT INTO schema_migrations (version, filename) VALUES ('0061','0061_final_review_currency_enqueue_reconcile.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0062_secure_definer_function_grants.sql
-- ==========================================================================

-- 0062_secure_definer_function_grants.sql
-- FINAL external-review SECURITY-BOUNDARY correction.
--
-- Every SECURITY DEFINER function that is service-only / internal must be callable ONLY by the
-- documented `service_role`. Revoke EXECUTE from PUBLIC, anon and authenticated; grant service_role.
-- Supabase (and the test shim, via ALTER DEFAULT PRIVILEGES) grant EXECUTE on public functions to
-- authenticated by default, so a function created without an explicit revoke is reachable by any
-- logged-in user — that is the boundary this migration closes for the internal machinery.
--
-- Forward-only, IDEMPOTENT and UPGRADE-SAFE. The lockdown is **name-based**: it iterates the
-- SECURITY DEFINER functions that actually exist and locks down every signature of each internal
-- name — so a legacy signature that may linger on an upgraded database (e.g. the old 7-arg
-- `_journal_post_internal` from migration 0039, dropped by 0044 on a normal upgrade) is still caught.
-- `to_regprocedure()` guards make the explicit belt-and-suspenders revoke a no-op when the signature
-- is absent (fresh DBs), so the migration is safe on both fresh and upgrade paths.
--
-- NOT service-only (deliberately left executable — see tests/integration/secure-definer-grants.test.ts,
-- which asserts this classification for EVERY SECURITY DEFINER function so none is missed):
--   * RLS predicate helpers (has_capability, has_company_access, has_membership, has_permission,
--     is_admin, my_company, my_department, authority_ceiling, within_authority,
--     within_authority_for_event) — RLS policies evaluate these in the CALLER's role, so revoking
--     EXECUTE would break row-level security itself;
--   * the authenticated write-path RPCs (post_manual_journal, post_customer_invoice,
--     post_supplier_bill, settle_customer_invoice, settle_supplier_bill, reverse_journal,
--     reimburse_expense_claim, request_supplier_bank_change, decide_supplier_bank_change,
--     decide_approval) — invoked with the user's JWT via `supabaseServer()` and fail-closed
--     internally (reject anon; actor derived from `auth.uid()`, never a caller-supplied id; per-op
--     capability + authority + separation-of-duties enforced before any state changes).

do $$
declare
  svc_only text[] := array[
    '_journal_post_internal', '_journal_fp_matches', 'claim_outbox_batch',
    'complete_outbox_and_advance', 'ledger_integrity_report', 'enqueue_outbox_row',
    'reconcile_quotation_from_outbox'
  ];
  r record;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_svc  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  -- Lock down every present signature of each internal name (upgrade-safe: whatever exists is fixed).
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.proname = any (svc_only)
  loop
    execute format('revoke all on function %s from public', r.sig);
    if has_anon then execute format('revoke all on function %s from anon', r.sig); end if;
    if has_auth then execute format('revoke all on function %s from authenticated', r.sig); end if;
    if has_svc  then execute format('grant execute on function %s to service_role', r.sig); end if;
  end loop;

  -- Belt-and-suspenders for the explicit legacy signature the review named: the pre-0044 7-arg
  -- `_journal_post_internal`. `to_regprocedure` returns NULL when the signature is absent (fresh DBs,
  -- and upgrades already past 0044) → the block is skipped, so this is safe everywhere.
  if to_regprocedure('public._journal_post_internal(uuid,date,text,text,uuid,jsonb,text)') is not null then
    revoke all on function public._journal_post_internal(uuid,date,text,text,uuid,jsonb,text) from public;
    if has_anon then revoke all on function public._journal_post_internal(uuid,date,text,text,uuid,jsonb,text) from anon; end if;
    if has_auth then revoke all on function public._journal_post_internal(uuid,date,text,text,uuid,jsonb,text) from authenticated; end if;
    if has_svc  then grant execute on function public._journal_post_internal(uuid,date,text,text,uuid,jsonb,text) to service_role; end if;
  end if;
end $$;

INSERT INTO schema_migrations (version, filename) VALUES ('0062','0062_secure_definer_function_grants.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0063_wp12_atomic_quotation_enqueue.sql
-- ==========================================================================

-- 0063_wp12_atomic_quotation_enqueue.sql
-- FINAL external-review correction 1: close the quotation enqueue time-of-check/time-of-use race
-- ATOMICALLY at the database boundary, and enforce the legal quotation lifecycle in the database.
--
-- The prior application flow could: re-read the quotation as `ready`; a concurrent transaction moves it
-- to `sent`/`accepted`/`rejected`; `enqueueOutbox()` inserts a pending row; the guarded `ready→queued`
-- update then matches zero rows — leaving a live pending row for a terminal quotation. This migration
-- removes that window: a single SECURITY DEFINER RPC locks the quotation row, inspects the authoritative
-- status under that lock, and (only if still legally sendable as `ready`) inserts the outbox row AND
-- advances `ready→queued` in the SAME transaction. Any failure rolls back both. A BEFORE UPDATE trigger
-- makes the illegal transitions (e.g. `queued → accepted/rejected`) impossible even outside the RPC.
--
-- Forward-only, idempotent. Service-role-only. No feature flag involved (active whenever the code path
-- runs; the containment for unreviewed work is the un-migrated hosted DB, not a flag).

-- ── Legal quotation lifecycle, enforced at the DB boundary ────────────────────
-- draft/awaiting_price/ready → queued → sent → accepted/rejected, plus pre-queue re-pricing shuffles
-- and the documented `ready→sent` recovery that complete_outbox_and_advance / reconcile_quotation_from_outbox
-- perform (their WHERE allows `status in ('queued','ready')`). Every X→X (no-op / column-only update) is
-- allowed. A `queued` quotation can NEVER jump to a terminal state while its outbox message is live —
-- that is the specific safety the review requires.
create or replace function public.quotations_enforce_status_transition()
returns trigger language plpgsql as $$
declare legal boolean;
begin
  if new.status is not distinct from old.status then
    return new;  -- no status change (column-only update) — always allowed
  end if;
  legal := case old.status
    when 'draft'          then new.status in ('awaiting_price','ready')
    when 'awaiting_price' then new.status in ('draft','ready')
    when 'ready'          then new.status in ('draft','awaiting_price','queued','sent')
    when 'queued'         then new.status in ('sent')
    when 'sent'           then new.status in ('accepted','rejected')
    when 'accepted'       then false
    when 'rejected'       then false
    else false
  end;
  if not legal then
    raise exception 'illegal quotation status transition % -> % (quotation %) (WP12 lifecycle)',
      old.status, new.status, new.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists quotations_status_transition_guard on quotations;
create trigger quotations_status_transition_guard
  before update of status on quotations
  for each row execute function public.quotations_enforce_status_transition();

-- ── Atomic, service-only quotation enqueue ────────────────────────────────────
-- Linearization point: the `SELECT … FOR UPDATE` on the company-scoped quotation row. All ordering
-- decisions (terminal wins / enqueue wins / duplicate) are made under that single row lock, so two
-- concurrent finalisers and a concurrent terminal transition are fully serialized on it.
--
-- Result contract:
--   'enqueued'     — a NEW pending outbox row was created AND the quotation advanced ready→queued (atomic)
--   'duplicate'    — an outbox row for THIS (company, quotation, key) already exists; quotation is queued;
--                    the caller reconciles/drains that exact row (no new row, no second send)
--   'terminal'     — the quotation is already sent/accepted/rejected; nothing created, nothing to drain
--   'not_ready'    — the quotation is draft/awaiting_price; not sendable now
--   'stale'        — the caller's message total/currency no longer matches the locked row; do NOT queue
--   'inconsistent' — missing/cross-company quotation, a queued quotation with no row, or an idempotency
--                    key owned by a different company/source → FAIL CLOSED (nothing created/drained)
create or replace function public.enqueue_quotation_outbox(
  p_company uuid, p_quotation uuid, p_recipient text, p_body text, p_idempotency_key text,
  p_expected_total numeric, p_expected_currency text,
  p_channel text default 'whatsapp', p_message_purpose text default 'quotation'
) returns text language plpgsql security definer set search_path = public as $$
declare
  v_status text; v_total numeric; v_currency text;
  v_company uuid; v_src_type text; v_src_id uuid; v_n int;
begin
  -- LOCK the quotation row (linearization point). Cross-company / missing → fail closed.
  select status, total, currency into v_status, v_total, v_currency
    from quotations where id = p_quotation and company_id = p_company for update;
  if not found then return 'inconsistent'; end if;

  -- Terminal wins the race → never create or drain a row.
  if v_status in ('sent','accepted','rejected') then return 'terminal'; end if;

  -- Already queued → the row must already exist and be OURS; caller reconciles that exact row.
  if v_status = 'queued' then
    select company_id, source_type, source_id into v_company, v_src_type, v_src_id
      from message_outbox where idempotency_key = p_idempotency_key;
    if not found then return 'inconsistent'; end if;                 -- queued with no row → fail closed
    if v_company is distinct from p_company
       or v_src_type is distinct from 'quotation'
       or v_src_id  is distinct from p_quotation then
      return 'inconsistent';                                          -- key owned elsewhere → fail closed
    end if;
    return 'duplicate';
  end if;

  -- Only `ready` may create a NEW row.
  if v_status <> 'ready' then return 'not_ready'; end if;

  -- The caller's message must match the authoritative total/currency UNDER THE LOCK, else it is stale.
  if p_expected_total is distinct from v_total
     or upper(btrim(coalesce(p_expected_currency,''))) is distinct from upper(btrim(coalesce(v_currency,''))) then
    return 'stale';
  end if;

  -- Idempotency-key collision under the lock: if a row exists it must be ours, else fail closed.
  select company_id, source_type, source_id into v_company, v_src_type, v_src_id
    from message_outbox where idempotency_key = p_idempotency_key;
  if found then
    if v_company is distinct from p_company
       or v_src_type is distinct from 'quotation'
       or v_src_id  is distinct from p_quotation then
      return 'inconsistent';
    end if;
    update quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
    return 'duplicate';                                              -- our row already exists → duplicate
  end if;

  -- ATOMIC: insert the outbox row AND advance ready→queued in ONE transaction. If either fails, both
  -- roll back (they are a single statement / function invocation), so there is never a queued quotation
  -- without its row nor a row without the queued quotation.
  insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, attempts,
                              source_type, source_id, message_purpose)
  values (p_company, p_channel, p_recipient, p_body, p_idempotency_key, 'pending', 0,
          'quotation', p_quotation, p_message_purpose)
  on conflict (idempotency_key) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    -- Lost an insert race on the key (astronomically unlikely under the lock, since the key is unique to
    -- this quotation). Re-verify ownership; ours → duplicate, else fail closed.
    select company_id, source_type, source_id into v_company, v_src_type, v_src_id
      from message_outbox where idempotency_key = p_idempotency_key;
    if v_company is distinct from p_company or v_src_type is distinct from 'quotation' or v_src_id is distinct from p_quotation then
      return 'inconsistent';
    end if;
    update quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
    return 'duplicate';
  end if;

  update quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
  if not found then
    -- Impossible while we hold the lock and the status was `ready`; fail closed (rolls back the insert).
    raise exception 'atomic quotation enqueue: % not ready at queue time', p_quotation;
  end if;
  return 'enqueued';
end $$;

-- ── Grants: service-only for the new RPC (revoke PUBLIC/anon/authenticated; grant service_role) ──
do $$
begin
  revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) to service_role;
  end if;
end $$;

INSERT INTO schema_migrations (version, filename) VALUES ('0063','0063_wp12_atomic_quotation_enqueue.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0064_wp12_delivery_transition_boundary.sql
-- ==========================================================================

-- 0064_wp12_delivery_transition_boundary.sql
-- FINAL external-review WP12 database-integrity corrections:
--   (1) The privileged DELIVERY transitions must be RPC-ONLY — a direct table UPDATE (even by an
--       authenticated user with `sales.quotation.manage`, or by `service_role`) must NOT bypass the
--       atomic delivery machinery. Otherwise a direct `ready→queued` creates a queued quotation with no
--       outbox row, and a direct `ready→sent` marks a quotation sent without provider completion.
--   (2) The `ready` + existing-outbox-row recovery inside `enqueue_quotation_outbox` must compare the
--       EXACT delivery identity + payload before recovering, or it can queue/drain a STALE row (e.g. an
--       old total 100 after the quotation was repriced to 120).
--
-- Forward-only, idempotent. Service-role-only for the RPC. No feature flag involved.
--
-- MECHANISM (non-spoofable, DB-boundary). The lifecycle trigger is SECURITY INVOKER, so it observes the
-- REAL `current_user`. Inside a SECURITY DEFINER delivery RPC (owned by `postgres`), `current_user` is
-- the function owner; a direct table write by an API role has `current_user` = that API role
-- (`anon`/`authenticated`/`service_role`). The API roles cannot `SET ROLE` to the owner (no membership),
-- and the trigger is NOT SECURITY DEFINER (which would make every caller look like the owner), so the
-- distinction cannot be forged with a JWT field, header, application boolean or GUC. The DB
-- owner/migration admin (`current_user = postgres`) stays trusted.

-- ── (1) Lifecycle trigger: legal transitions + RPC-only delivery transitions ──
create or replace function public.quotations_enforce_status_transition()
returns trigger language plpgsql as $$   -- SECURITY INVOKER (default) — MUST read the real current_user
declare legal boolean; privileged boolean;
begin
  if new.status is not distinct from old.status then
    return new;  -- no status change (column-only update) — always allowed
  end if;

  -- Legality of the transition (independent of who is calling).
  legal := case old.status
    when 'draft'          then new.status in ('awaiting_price','ready')
    when 'awaiting_price' then new.status in ('draft','ready')
    when 'ready'          then new.status in ('draft','awaiting_price','queued','sent')
    when 'queued'         then new.status in ('sent')
    when 'sent'           then new.status in ('accepted','rejected')
    when 'accepted'       then false   -- absorbing
    when 'rejected'       then false   -- absorbing
    else false
  end;
  if not legal then
    raise exception 'illegal quotation status transition % -> % (quotation %) (WP12 lifecycle)',
      old.status, new.status, new.id using errcode = 'check_violation';
  end if;

  -- The DELIVERY transitions are RPC-ONLY. `ready→queued` may occur only inside
  -- `enqueue_quotation_outbox`; `queued→sent` and the documented `ready→sent` recovery only inside
  -- `complete_outbox_and_advance` / `reconcile_quotation_from_outbox` — all SECURITY DEFINER, so their
  -- internal UPDATE runs with `current_user` = the owner, never an API role. A direct table write by an
  -- API role is refused here (before any row changes), so it cannot bypass the atomic/fenced machinery.
  privileged := (old.status = 'ready' and new.status in ('queued','sent'))
             or (old.status = 'queued' and new.status = 'sent');
  if privileged and current_user in ('anon','authenticated','service_role') then
    raise exception 'quotation delivery transition % -> % is RPC-only; use the service-only delivery RPCs — a direct table UPDATE is refused (WP12)',
      old.status, new.status using errcode = 'insufficient_privilege';
  end if;

  return new;
end $$;

-- The trigger definition from 0063 continues to reference this function; re-assert it for clarity.
drop trigger if exists quotations_status_transition_guard on quotations;
create trigger quotations_status_transition_guard
  before update of status on quotations
  for each row execute function public.quotations_enforce_status_transition();

-- ── (2) enqueue_quotation_outbox: EXACT-payload recovery on the ready + existing-row path ──
-- Replaces the 0063 body. The only behavioural change is that the `ready` + existing-row recovery now
-- requires the existing row's FULL delivery identity + payload (company, source type, source id,
-- idempotency key, channel, recipient, body, message purpose) to match this request before it recovers
-- `ready→queued`; any mismatch returns `inconsistent` and leaves the quotation `ready` (no create/
-- modify/queue/drain — the caller emits the operator-visible inconsistency log and never drains). For an
-- already-`queued` quotation the ORIGINAL queued snapshot remains authoritative (no payload rebuild).
create or replace function public.enqueue_quotation_outbox(
  p_company uuid, p_quotation uuid, p_recipient text, p_body text, p_idempotency_key text,
  p_expected_total numeric, p_expected_currency text,
  p_channel text default 'whatsapp', p_message_purpose text default 'quotation'
) returns text language plpgsql security definer set search_path = public as $$
declare
  v_status text; v_total numeric; v_currency text;
  v_company uuid; v_src_type text; v_src_id uuid; v_n int;
  v_channel text; v_recipient text; v_body text; v_purpose text; v_found boolean;
begin
  select status, total, currency into v_status, v_total, v_currency
    from quotations where id = p_quotation and company_id = p_company for update;
  if not found then return 'inconsistent'; end if;

  if v_status in ('sent','accepted','rejected') then return 'terminal'; end if;

  -- Already queued → reconcile the EXACT existing row; its original snapshot is authoritative (no rebuild).
  if v_status = 'queued' then
    select company_id, source_type, source_id into v_company, v_src_type, v_src_id
      from message_outbox where idempotency_key = p_idempotency_key;
    if not found then return 'inconsistent'; end if;
    if v_company is distinct from p_company
       or v_src_type is distinct from 'quotation'
       or v_src_id  is distinct from p_quotation then
      return 'inconsistent';
    end if;
    return 'duplicate';
  end if;

  if v_status <> 'ready' then return 'not_ready'; end if;

  if p_expected_total is distinct from v_total
     or upper(btrim(coalesce(p_expected_currency,''))) is distinct from upper(btrim(coalesce(v_currency,''))) then
    return 'stale';
  end if;

  -- ready + existing row → require an EXACT delivery-identity + payload match before recovering, else
  -- fail closed (a stale/legacy row must never be queued or drained).
  select company_id, source_type, source_id, channel, recipient, body, message_purpose
    into v_company, v_src_type, v_src_id, v_channel, v_recipient, v_body, v_purpose
    from message_outbox where idempotency_key = p_idempotency_key;
  v_found := found;
  if v_found then
    if v_company    is distinct from p_company
       or v_src_type  is distinct from 'quotation'
       or v_src_id    is distinct from p_quotation
       or v_channel   is distinct from p_channel
       or v_recipient is distinct from p_recipient
       or v_body      is distinct from p_body
       or v_purpose   is distinct from p_message_purpose then
      return 'inconsistent';   -- stale / cross-identity row → never queue or drain it
    end if;
    update quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
    return 'duplicate';        -- exact match → documented legacy recovery
  end if;

  -- No existing row → insert + advance ready→queued atomically.
  insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, attempts,
                              source_type, source_id, message_purpose)
  values (p_company, p_channel, p_recipient, p_body, p_idempotency_key, 'pending', 0,
          'quotation', p_quotation, p_message_purpose)
  on conflict (idempotency_key) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    -- Lost an insert race on the key (defensive; unreachable under the row lock for this quotation's key).
    -- Re-verify the EXACT payload before recovering; else fail closed.
    select company_id, source_type, source_id, channel, recipient, body, message_purpose
      into v_company, v_src_type, v_src_id, v_channel, v_recipient, v_body, v_purpose
      from message_outbox where idempotency_key = p_idempotency_key;
    if v_company is distinct from p_company or v_src_type is distinct from 'quotation' or v_src_id is distinct from p_quotation
       or v_channel is distinct from p_channel or v_recipient is distinct from p_recipient
       or v_body is distinct from p_body or v_purpose is distinct from p_message_purpose then
      return 'inconsistent';
    end if;
    update quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
    return 'duplicate';
  end if;

  update quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
  if not found then
    raise exception 'atomic quotation enqueue: % not ready at queue time', p_quotation;
  end if;
  return 'enqueued';
end $$;

-- Re-assert service-only grants for the replaced RPC (CREATE OR REPLACE preserves ACLs, but be explicit).
do $$
begin
  revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) to service_role;
  end if;
end $$;

-- NOTE on complete_outbox_and_advance / reconcile_quotation_from_outbox: both are SECURITY DEFINER owned
-- by the migration role, so their internal `queued→sent` / `ready→sent` UPDATEs run with current_user =
-- owner and are therefore PERMITTED by the strengthened trigger, while remaining service-role-only
-- (0062). No replacement is required; the integration tests exercise both under the new trigger.

INSERT INTO schema_migrations (version, filename) VALUES ('0064','0064_wp12_delivery_transition_boundary.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0065_wp12_claim_and_insert_boundary.sql
-- ==========================================================================

-- 0065_wp12_claim_and_insert_boundary.sql
-- FINAL external-review WP12 boundary corrections (three findings):
--   (1) The scheduled drain (`claim_outbox_batch`) claimed ANY due outbox row without checking the
--       linked quotation, so a STALE `ready` quotation's outbox row (left `pending` after 0064 returned
--       `inconsistent`) could still be claimed + sent, and `complete_outbox_and_advance` could then do
--       `ready→sent` — bypassing the exact-payload guard. Now a quotation-delivery row is claimable ONLY
--       when its linked quotation is committed `queued`. `queued` becomes the proof that the atomic
--       enqueue / exact recovery succeeded; a `ready` (stale) row is unclaimable by inline AND scheduled drains.
--   (2) The 0064 lifecycle trigger was BEFORE UPDATE only, so a permitted direct INSERT (authenticated
--       with `sales.quotation.manage`, or `service_role`) could fabricate a `queued`/`sent`/`accepted`/
--       `rejected` quotation. A non-trusted direct writer may now create a quotation ONLY in the valid
--       initial state (`draft`, `sent_at` null). The trusted-writer check is a POSITIVE allowlist derived
--       from the delivery functions' OWNER (not a role-name denylist), so a future custom role cannot
--       bypass it. `sent_at` may be changed only in the trusted (owner) delivery-RPC context.
--   (3) Bounded DML audit: message_outbox is already service-only for writes (0048), so the queued
--       snapshot cannot be altered by authenticated users; a DELETE that orphans a row leaves it
--       unclaimable by (1) (no `queued` quotation → fail closed). See the note at the end.
--
-- Forward-only, idempotent. Service-role-only for the RPC. No feature flag involved.

-- ── Positive trusted-owner signal (SECURITY INVOKER — MUST read the real current_user) ──
-- Returns true iff the CURRENT execution role is the owner of the delivery functions. Inside a
-- SECURITY DEFINER delivery RPC, current_user = the function owner → true; a direct table write by
-- anon/authenticated/service_role/any custom role has current_user = that role → false; the DB
-- owner/migration admin (which owns the functions) → true. Derived from the function identity, so it is
-- NOT a role-name denylist and cannot be forged with a JWT field, header, application boolean or GUC.
create or replace function public._is_quotation_delivery_owner() returns boolean
language sql stable as $$
  select current_user::regrole::oid = (
    select p.proowner
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'enqueue_quotation_outbox'
    limit 1
  );
$$;
grant execute on function public._is_quotation_delivery_owner() to public;

-- ── (1) Quotation-aware claim: only a `queued` quotation's row is claimable ──
create or replace function public.claim_outbox_batch(p_limit integer, p_owner text, p_lease_seconds integer default 120)
returns setof message_outbox language plpgsql security definer set search_path = public as $$
begin
  return query
  update message_outbox m
     set status = 'processing',
         locked_at = now(),
         lock_owner = p_owner,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where m.id in (
     select c.id from message_outbox c
      where (
        -- unchanged retry/lease eligibility
        c.status = 'pending'
        or (c.status = 'failed' and (c.next_retry_at is null or c.next_retry_at <= now()))
        or (c.status = 'processing' and c.lease_expires_at is not null and c.lease_expires_at <= now())
      )
      and (
        -- Generic (non-quotation) rows: neither the source type nor the purpose is a quotation.
        (coalesce(c.source_type, '') <> 'quotation' and coalesce(c.message_purpose, '') <> 'quotation')
        or
        -- Quotation-delivery rows: claimable ONLY when fully consistent AND the linked quotation is
        -- committed `queued` in the SAME company. A row that looks like a quotation on EITHER field but
        -- has mismatched/missing quotation metadata falls through both branches → fail-closed unclaimable.
        (
          c.source_type = 'quotation' and c.message_purpose = 'quotation' and c.source_id is not null
          and exists (
            select 1 from quotations q
            where q.id = c.source_id and q.company_id = c.company_id and q.status = 'queued'
          )
        )
      )
      order by c.created_at
      for update skip locked
      limit p_limit
   )
   returning m.*;
end $$;

-- ── (2) INSERT lifecycle boundary: a non-trusted writer may create only the valid initial state ──
create or replace function public.quotations_enforce_insert_initial_state()
returns trigger language plpgsql as $$   -- SECURITY INVOKER (default) — MUST read the real current_user
begin
  if not public._is_quotation_delivery_owner()
     and (new.status is distinct from 'draft' or new.sent_at is not null) then
    raise exception 'quotation may only be created in the initial state (status=draft, sent_at null) — delivery states are set only by the service-only delivery RPCs (WP12)'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists quotations_insert_initial_state_guard on quotations;
create trigger quotations_insert_initial_state_guard
  before insert on quotations
  for each row execute function public.quotations_enforce_insert_initial_state();

-- ── (2) UPDATE lifecycle boundary: positive owner check for privileged transitions + sent_at guard ──
-- Replaces the 0064 trigger function. The privileged delivery transitions and any `sent_at` change are
-- allowed ONLY in the trusted delivery-owner context (i.e. inside the SECURITY DEFINER delivery RPCs, or
-- by the DB owner). This is a POSITIVE allowlist — a direct write by authenticated/service_role/ANY
-- custom role is refused. Non-privileged transitions (pre-queue re-pricing, sent→accepted/rejected)
-- remain functional for any legal writer.
create or replace function public.quotations_enforce_status_transition()
returns trigger language plpgsql as $$   -- SECURITY INVOKER (default)
declare legal boolean; privileged boolean; trusted boolean;
begin
  trusted := public._is_quotation_delivery_owner();

  -- `sent_at` is delivery-completion metadata: only the trusted (owner) RPC context may set/change it.
  if new.sent_at is distinct from old.sent_at and not trusted then
    raise exception 'quotation.sent_at may be changed only by the service-only delivery-completion RPCs (WP12)'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status is not distinct from old.status then
    return new;  -- no status change (column-only update, e.g. totals) — allowed
  end if;

  legal := case old.status
    when 'draft'          then new.status in ('awaiting_price','ready')
    when 'awaiting_price' then new.status in ('draft','ready')
    when 'ready'          then new.status in ('draft','awaiting_price','queued','sent')
    when 'queued'         then new.status in ('sent')
    when 'sent'           then new.status in ('accepted','rejected')
    when 'accepted'       then false
    when 'rejected'       then false
    else false
  end;
  if not legal then
    raise exception 'illegal quotation status transition % -> % (quotation %) (WP12 lifecycle)',
      old.status, new.status, new.id using errcode = 'check_violation';
  end if;

  -- The delivery transitions are RPC-ONLY (positive owner allowlist, not a role-name denylist).
  privileged := (old.status = 'ready' and new.status in ('queued','sent'))
             or (old.status = 'queued' and new.status = 'sent');
  if privileged and not trusted then
    raise exception 'quotation delivery transition % -> % is RPC-only; use the service-only delivery RPCs — a direct table UPDATE is refused (WP12)',
      old.status, new.status using errcode = 'insufficient_privilege';
  end if;

  return new;
end $$;

-- Recreate the UPDATE trigger to also fire on `sent_at` (so a status-less sent_at change is guarded).
drop trigger if exists quotations_status_transition_guard on quotations;
create trigger quotations_status_transition_guard
  before update of status, sent_at on quotations
  for each row execute function public.quotations_enforce_status_transition();

-- ── Grants: claim_outbox_batch stays service-only ──
do $$
begin
  revoke all on function public.claim_outbox_batch(integer,text,integer) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.claim_outbox_batch(integer,text,integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.claim_outbox_batch(integer,text,integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_outbox_batch(integer,text,integer) to service_role;
  end if;
end $$;

-- AUDIT NOTE (finding 3): message_outbox is service-only for writes (0048: authenticated/anon have no
-- INSERT/UPDATE/DELETE), so the authoritative queued snapshot cannot be altered by an authenticated user.
-- A DELETE of a quotation orphans its outbox row, but (1) makes that row unclaimable (no committed
-- `queued` quotation → fail closed), so it can never be sent. `sent_at` fabrication is blocked above.

INSERT INTO schema_migrations (version, filename) VALUES ('0065','0065_wp12_claim_and_insert_boundary.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0066_wp12_snapshot_and_delete_boundary.sql
-- ==========================================================================

-- 0066_wp12_snapshot_and_delete_boundary.sql
-- EIGHTH (final) external-review WP12 boundary corrections, plus the security-review hardening the eighth
-- review's own adversarial pass surfaced. Database-boundary hardenings:
--
--   (1) SIGNATURE-EXACT trusted-owner check. Migration 0065's `_is_quotation_delivery_owner()` resolved
--       the delivery-function owner by `proname` + `LIMIT 1`, which is not signature-exact and could bind
--       to a future overload with a different owner. It now resolves the owner from the EXACT regprocedure
--       identity of `enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text)`, and the
--       migration fails closed unless the three exact delivery functions
--       (enqueue_quotation_outbox / complete_outbox_and_advance / reconcile_quotation_from_outbox) all
--       exist, are all SECURITY DEFINER, share ONE trusted owner, and that owner is not — and cannot be
--       assumed (SET ROLE) by — anon/authenticated/service_role.
--
--   (2) CLAIM-then-DELETE race. A BEFORE DELETE trigger refuses a non-trusted DELETE of a quotation when
--       its status is queued/terminal OR any quotation-linked outbox row exists (pending/processing/
--       failed/sent/dead). A draft/awaiting_price quotation with no outbox history stays deletable. TRUNCATE
--       (which bypasses row triggers and which `service_role` holds) is refused by a statement-level guard.
--
--   (3) FROZEN queued snapshot. Once queued, a non-trusted writer may change nothing on the quotation but a
--       pure `sent→accepted`/`sent→rejected` decision; its `quotation_items` are immutable; AND the actual
--       delivery row `message_outbox` has its CONTENT (recipient/body/template/source/key) frozen while its
--       delivery-state stays worker-mutable — so the delivered message and the public /q/<token> page can
--       only reflect the authoritative queued snapshot. Pre-queue editing/repricing stays functional.
--
--   (4) SEARCH_PATH / pg_temp HARDENING (from the eighth review's adversarial security pass). Postgres
--       searches the session temp schema (`pg_temp`) for RELATION names BEFORE `pg_catalog` and `public`
--       unless `pg_temp` is explicitly listed later in `search_path`. A caller with the (default, PUBLIC)
--       TEMP privilege could therefore `CREATE TEMP TABLE pg_proc`/`quotations`/`message_outbox` to shadow
--       the real tables inside a SECURITY INVOKER trigger or a `SET search_path = public` SECURITY DEFINER
--       function, forging the owner check or hiding real rows. Every function here schema-qualifies EVERY
--       relation reference (`pg_catalog.*`, `public.*`) AND pins `search_path = pg_catalog, public, pg_temp`
--       (pg_temp LAST). The WP12 delivery RPCs are re-pinned the same way via ALTER FUNCTION.
--
--   (5) Doc correction: the `message_outbox` service-only DML boundary originated in migration **0038**
--       (0038_capability_authority.sql §6), NOT 0048. 0065's AUDIT NOTE said "0048"; 0065 is not rewritten.
--
-- Forward-only, idempotent. No feature flag involved. The DB owner / migration admin remains trusted.
-- NOTE (residual, documented): the same `set search_path = public` / unqualified-relation pattern exists in
-- OTHER-domain SECURITY DEFINER functions (accounting/approval RPCs, e.g. `decide_approval`, `_journal_*`).
-- A full-codebase search_path audit is a recommended systemic follow-up; it is OUT of this WP12 review's
-- bounded scope and is not silently applied here.

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) Migration-time fail-closed assertion of the trusted-owner model (exact signatures).
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  enq regprocedure := to_regprocedure('public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text)');
  cmp regprocedure := to_regprocedure('public.complete_outbox_and_advance(uuid,text,text)');
  rec regprocedure := to_regprocedure('public.reconcile_quotation_from_outbox(uuid)');
  o_enq oid; o_cmp oid; o_rec oid; sd_enq boolean; sd_cmp boolean; sd_rec boolean;
  owner_name text; r text;
begin
  if enq is null or cmp is null or rec is null then
    raise exception '0066 fail-closed: an exact delivery function is missing (enqueue=%, complete=%, reconcile=%)', enq, cmp, rec;
  end if;
  select proowner, prosecdef into o_enq, sd_enq from pg_catalog.pg_proc where oid = enq;
  select proowner, prosecdef into o_cmp, sd_cmp from pg_catalog.pg_proc where oid = cmp;
  select proowner, prosecdef into o_rec, sd_rec from pg_catalog.pg_proc where oid = rec;
  if not (sd_enq and sd_cmp and sd_rec) then
    raise exception '0066 fail-closed: all three delivery functions must be SECURITY DEFINER (enqueue=%, complete=%, reconcile=%)', sd_enq, sd_cmp, sd_rec;
  end if;
  if not (o_enq = o_cmp and o_cmp = o_rec) then
    raise exception '0066 fail-closed: the three delivery functions must share ONE trusted owner (got %, %, %)',
      o_enq::regrole, o_cmp::regrole, o_rec::regrole;
  end if;
  owner_name := o_enq::regrole::text;
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      if r = owner_name then
        raise exception '0066 fail-closed: the delivery-function owner must not be the API role %', r;
      end if;
      if pg_catalog.pg_has_role(r, o_enq, 'MEMBER') then
        raise exception '0066 fail-closed: API role % can assume the delivery-function owner % (SET ROLE reachable)', r, owner_name;
      end if;
    end if;
  end loop;
  raise notice '0066 trusted-owner model OK: owner=% (enqueue/complete/reconcile all SECURITY DEFINER; unreachable by anon/authenticated/service_role)', owner_name;
end $$;

-- ── (1)+(4) Signature-exact, owner-based trusted signal ──
-- SECURITY INVOKER (reads the real current_user). Resolves the trusted owner from the EXACT 9-arg identity
-- via `pg_catalog.pg_proc` (schema-qualified) with `search_path` pinning `pg_temp` LAST, so a temp table
-- named `pg_proc` cannot shadow the catalog and forge the decision. A future overload with a different
-- signature/owner has a different oid and cannot affect this exact lookup. Absent function → false (fail closed).
create or replace function public._is_quotation_delivery_owner() returns boolean
language plpgsql stable set search_path = pg_catalog, public, pg_temp as $$
declare v_owner oid;
begin
  select p.proowner into v_owner
    from pg_catalog.pg_proc p
   where p.oid = to_regprocedure('public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text)');
  if v_owner is null then
    return false;
  end if;
  return current_user::regrole::oid = v_owner;
end $$;
grant execute on function public._is_quotation_delivery_owner() to public;

-- ─────────────────────────────────────────────────────────────────────────────
-- (3) FROZEN snapshot + lifecycle: consolidated BEFORE UPDATE trigger on the WHOLE quotations row.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.quotations_enforce_status_transition()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$   -- SECURITY INVOKER
declare legal boolean; privileged boolean; trusted boolean;
begin
  trusted := public._is_quotation_delivery_owner();

  if new.sent_at is distinct from old.sent_at and not trusted then
    raise exception 'quotation.sent_at may be changed only by the service-only delivery-completion RPCs (WP12)'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status is distinct from old.status then
    legal := case old.status
      when 'draft'          then new.status in ('awaiting_price','ready')
      when 'awaiting_price' then new.status in ('draft','ready')
      when 'ready'          then new.status in ('draft','awaiting_price','queued','sent')
      when 'queued'         then new.status in ('sent')
      when 'sent'           then new.status in ('accepted','rejected')
      when 'accepted'       then false
      when 'rejected'       then false
      else false
    end;
    if not legal then
      raise exception 'illegal quotation status transition % -> % (quotation %) (WP12 lifecycle)',
        old.status, new.status, new.id using errcode = 'check_violation';
    end if;
    privileged := (old.status = 'ready' and new.status in ('queued','sent'))
               or (old.status = 'queued' and new.status = 'sent');
    if privileged and not trusted then
      raise exception 'quotation delivery transition % -> % is RPC-only; use the service-only delivery RPCs — a direct table UPDATE is refused (WP12)',
        old.status, new.status using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- FROZEN snapshot: once queued/terminal a NON-TRUSTED writer may not change any customer-facing field;
  -- the only permitted mutation is the pure status decision (constrained legal above). Trusted exempt.
  if not trusted and old.status in ('queued','sent','accepted','rejected') then
    if new.id           is distinct from old.id
       or new.company_id   is distinct from old.company_id
       or new.order_id     is distinct from old.order_id
       or new.quote_number is distinct from old.quote_number
       or new.currency     is distinct from old.currency
       or new.subtotal     is distinct from old.subtotal
       or new.tax_amount   is distinct from old.tax_amount
       or new.total        is distinct from old.total
       or new.notes        is distinct from old.notes
       or new.public_token is distinct from old.public_token
       or new.created_at   is distinct from old.created_at
       or new.sent_at      is distinct from old.sent_at then
      raise exception 'quotation % is frozen after queueing; its content is immutable to non-owners — only a sent->accepted/rejected decision is permitted (WP12 snapshot immutability)',
        old.id using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists quotations_status_transition_guard on quotations;
create trigger quotations_status_transition_guard
  before update on quotations
  for each row execute function public.quotations_enforce_status_transition();

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) DELETE boundary + (4) TRUNCATE guard on quotations.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.quotations_enforce_delete_boundary()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$   -- SECURITY INVOKER
begin
  if public._is_quotation_delivery_owner() then
    return old;  -- trusted maintenance override
  end if;
  if old.status in ('queued','sent','accepted','rejected') then
    raise exception 'quotation % cannot be deleted in status % (queued/terminal quotations are immutable to non-owners) (WP12)',
      old.id, old.status using errcode = 'insufficient_privilege';
  end if;
  if exists (
    select 1 from public.message_outbox m
     where m.company_id = old.company_id and m.source_type = 'quotation' and m.source_id = old.id
  ) then
    raise exception 'quotation % has outbox delivery history and cannot be deleted by a non-owner (WP12 claim-then-delete boundary)',
      old.id using errcode = 'insufficient_privilege';
  end if;
  return old;  -- draft/awaiting_price with no outbox history → deletable (existing product contract)
end $$;

drop trigger if exists quotations_delete_boundary_guard on quotations;
create trigger quotations_delete_boundary_guard
  before delete on quotations
  for each row execute function public.quotations_enforce_delete_boundary();

-- TRUNCATE bypasses row-level triggers, and `service_role` holds TRUNCATE on these tables (Supabase
-- `grant all ... to service_role`) even though `authenticated` does not. Statement-level BEFORE TRUNCATE
-- guards close that path for quotations, quotation_items AND message_outbox. The trusted owner may truncate.
create or replace function public.quotations_block_nontrusted_truncate()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$   -- SECURITY INVOKER
begin
  if not public._is_quotation_delivery_owner() then
    raise exception 'TRUNCATE of % is not permitted to non-owners (WP12 delete/snapshot boundary)', tg_table_name
      using errcode = 'insufficient_privilege';
  end if;
  return null;
end $$;
drop trigger if exists quotations_no_truncate_guard on quotations;
create trigger quotations_no_truncate_guard
  before truncate on quotations
  for each statement execute function public.quotations_block_nontrusted_truncate();
drop trigger if exists quotation_items_no_truncate_guard on quotation_items;
create trigger quotation_items_no_truncate_guard
  before truncate on quotation_items
  for each statement execute function public.quotations_block_nontrusted_truncate();
drop trigger if exists message_outbox_no_truncate_guard on message_outbox;
create trigger message_outbox_no_truncate_guard
  before truncate on message_outbox
  for each statement execute function public.quotations_block_nontrusted_truncate();

-- ─────────────────────────────────────────────────────────────────────────────
-- (3b) quotation_items of a queued/terminal quotation are immutable to non-trusted writers.
-- Parent status is read through a SELF-GATING SECURITY DEFINER helper (schema-qualified + pg_temp-pinned)
-- so an RLS-invisible parent (a capability holder whose department is outside the quotations READ policy)
-- cannot bypass the freeze, while the helper returns a status ONLY to a caller who already holds
-- `sales.quotation.manage` in that company (or the service worker) — never a cross-company oracle.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._quotation_status_for_guard(p_company uuid, p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select status from public.quotations
   where id = p_id and company_id = p_company
     and (public.has_capability(p_company, 'sales.quotation.manage')
          or public.caller_jwt_role() = 'service_role');
$$;
grant execute on function public._quotation_status_for_guard(uuid,uuid) to public;

create or replace function public.quotation_items_enforce_frozen()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$   -- SECURITY INVOKER
declare s_new text; s_old text;
begin
  if public._is_quotation_delivery_owner() then
    return coalesce(new, old);  -- trusted maintenance override
  end if;
  if tg_op in ('INSERT','UPDATE') then
    s_new := public._quotation_status_for_guard(new.company_id, new.quotation_id);
    if s_new in ('queued','sent','accepted','rejected') then
      raise exception 'quotation_items % refused: parent quotation % is frozen (status %) (WP12 snapshot immutability)',
        tg_op, new.quotation_id, s_new using errcode = 'insufficient_privilege';
    end if;
  end if;
  if tg_op in ('UPDATE','DELETE') then
    s_old := public._quotation_status_for_guard(old.company_id, old.quotation_id);
    if s_old in ('queued','sent','accepted','rejected') then
      raise exception 'quotation_items % refused: parent quotation % is frozen (status %) (WP12 snapshot immutability)',
        tg_op, old.quotation_id, s_old using errcode = 'insufficient_privilege';
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists quotation_items_frozen_guard on quotation_items;
create trigger quotation_items_frozen_guard
  before insert or update or delete on quotation_items
  for each row execute function public.quotation_items_enforce_frozen();

-- ─────────────────────────────────────────────────────────────────────────────
-- (3c) message_outbox content freeze: the DELIVERED message (recipient/body/template/source/key) is
-- immutable after enqueue; only delivery-state (status/attempts/lease/provider id/timestamps) stays
-- mutable — so the worker keeps working while a compromised `service_role` cannot rewrite the message body
-- or recipient of a queued/pending row, and cannot DELETE a claimed row to strand the quotation. INSERT is
-- performed by the SECURITY DEFINER enqueue RPCs (owner context = trusted), so it is unaffected.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.message_outbox_enforce_content_freeze()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$   -- SECURITY INVOKER
begin
  if public._is_quotation_delivery_owner() then
    return coalesce(new, old);  -- trusted (enqueue/complete/reconcile RPCs run as owner)
  end if;
  if tg_op = 'DELETE' then
    raise exception 'message_outbox rows may not be deleted by a non-owner (WP12: would orphan a claimed delivery)'
      using errcode = 'insufficient_privilege';
  end if;
  if new.company_id      is distinct from old.company_id
     or new.channel         is distinct from old.channel
     or new.recipient       is distinct from old.recipient
     or new.body            is distinct from old.body
     or new.idempotency_key is distinct from old.idempotency_key
     or new.correlation_id  is distinct from old.correlation_id
     or new.template_name   is distinct from old.template_name
     or new.template_params is distinct from old.template_params
     or new.template_lang   is distinct from old.template_lang
     or new.source_type     is distinct from old.source_type
     or new.source_id       is distinct from old.source_id
     or new.message_purpose is distinct from old.message_purpose then
    raise exception 'message_outbox delivery content (recipient/body/template/source/key) is immutable after enqueue; only delivery-state may change (WP12 snapshot immutability)'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists message_outbox_content_freeze_guard on message_outbox;
create trigger message_outbox_content_freeze_guard
  before update or delete on message_outbox
  for each row execute function public.message_outbox_enforce_content_freeze();

-- ─────────────────────────────────────────────────────────────────────────────
-- (4) Re-pin the WP12 delivery RPCs' search_path with pg_temp LAST (they reference public tables
-- unqualified; ALTER … SET search_path demotes pg_temp without touching their bodies). None use pgcrypto,
-- so `pg_catalog, public, pg_temp` is complete. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────
alter function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) set search_path = pg_catalog, public, pg_temp;
alter function public.complete_outbox_and_advance(uuid,text,text) set search_path = pg_catalog, public, pg_temp;
alter function public.reconcile_quotation_from_outbox(uuid) set search_path = pg_catalog, public, pg_temp;
alter function public.claim_outbox_batch(integer,text,integer) set search_path = pg_catalog, public, pg_temp;
alter function public.enqueue_outbox_row(uuid,text,text,text,text,text,text,jsonb,text,uuid,text) set search_path = pg_catalog, public, pg_temp;

-- AUDIT NOTE (correcting 0065): message_outbox is service-only for writes since migration **0038**
-- (0038_capability_authority.sql §6 — RLS + no write policy + REVOKE INSERT/UPDATE/DELETE from
-- authenticated), not 0048. Beyond that, this migration additionally freezes the message CONTENT against
-- `service_role` (3c) and blocks a non-trusted DELETE/TRUNCATE of the delivery row, so the queued snapshot
-- — the quotation body, its quotation_items, and the actual outbound message — is immutable to every
-- non-owner writer. Together with 0063–0065 the delivered message and the public /q/<token> page can only
-- ever reflect the authoritative queued snapshot.

INSERT INTO schema_migrations (version, filename) VALUES ('0066','0066_wp12_snapshot_and_delete_boundary.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0067_systemic_search_path_and_enqueue_item_boundary.sql
-- ==========================================================================

-- 0067_systemic_search_path_and_enqueue_item_boundary.sql
-- NINTH external-review bounded corrections:
--
--   CORRECTION 1 — systemic search_path audit. Migration 0066 proved that `SET search_path = public` (or
--   no search_path) plus unqualified relation references permits `pg_temp` relation shadowing, and that it
--   is NOT restricted to WP12: the accounting, approval, identity/RLS, bank-change, journal, settlement,
--   reimbursement, fingerprint and integrity functions still carry unsafe/incomplete paths. This migration
--   performs a CATALOG-DRIVEN hardening (not a text search) of the FINAL active functions after 0066: every
--   application-owned SECURITY DEFINER function and every trigger function in `public` (excluding
--   extension-owned) is re-pinned to `search_path = pg_catalog, extensions, public, pg_temp`
--   (pg_catalog first; trusted `extensions` available for digest/pgcrypto; `public` for app relations;
--   `pg_temp` explicitly LAST; no `$user`; no implicit temp-schema precedence). Only `search_path` changes —
--   never the body, owner, arguments, return type, SECURITY DEFINER/INVOKER classification or ACL. The
--   migration FAILS CLOSED if anon/authenticated/service_role has CREATE on the trusted `public`/`extensions`
--   schemas (a shadowing object could be planted there) — it does NOT alter hosted privileges; it reports.
--   A permanent integration gate (tests/integration/search-path-safety.test.ts) fails if any future
--   application SECURITY DEFINER / trigger function has an unsafe path.
--
--   CORRECTION 2 — quotation-item vs atomic-enqueue race. 0066 freezes `quotation_items` after the parent
--   is visibly queued, but `_quotation_status_for_guard()` performed an UNLOCKED parent-status read, so a
--   concurrent item mutation could still see the pre-commit `ready` status while `enqueue_quotation_outbox`
--   was queuing the previously-built message — leaving a queued outbox body/total that disagrees with the
--   committed items. Closed at the DB linearization boundary with a SINGLE lock — the parent quotation row:
--     (a) the item-freeze guard helper reads the parent FOR UPDATE, so every non-trusted item mutation
--         (INSERT/UPDATE/DELETE) must acquire the SAME quotation-row lock that `enqueue_quotation_outbox`
--         holds. enqueue takes NO item-row locks (deliberately: the target item row is locked by Postgres
--         BEFORE its row trigger fires, so an enqueue that then locked item rows would create a genuine
--         parent→child vs child→parent AB-BA deadlock — found by the pre-submission adversarial pass and
--         reproduced on a live PostgreSQL 16; a single lock object cannot form a cycle). Under the parent
--         lock, enqueue's per-statement MVCC snapshot reads only COMMITTED item state: any mutation that
--         committed first is visible; any uncommitted mutation is waiting on the parent lock and — once
--         enqueue commits `queued` — is refused 42501 by the freeze guard (READ COMMITTED re-evaluation).
--     (b) `enqueue_quotation_outbox`, under that parent lock, requires — UNCONDITIONALLY, on the `ready`
--         path — the caller's expected total to equal the authoritative live SUM(line_total) of the
--         quotation's items, and refuses (also `stale`) if ANY item is an incomplete snapshot line:
--         `status <> 'priced'`, NULL `unit_price`, NULL `line_total` (SUM silently skips NULL — a priced
--         item with a NULL line_total would ride an under-counted total), or a currency different from
--         the LOCKED quotation currency (the public quotation renders every line in the quotation
--         currency; a numeric match in the wrong currency must never send) — exactly the completeness
--         predicate `refreshQuotationStatus` uses to keep a quotation out of `ready`. There is NO
--         item-count exemption: deleting ALL items of a `ready` quotation makes the live sum 0, which no
--         longer matches a non-zero expected total → `stale` (the pre-submission adversarial pass showed
--         the earlier `v_item_count > 0` guard let a delete-to-zero race ship a customer-facing total
--         backed by zero items). A quotation that never had items enqueues only with an expected total
--         of 0 — the degenerate seed case, impossible for a real priced quotation.
--     Numeric/Decimal correctness is preserved (all DB numeric; no float). enqueue keeps its exact
--     signature, SECURITY DEFINER owner, hardened search_path, service-role-only EXECUTE, and every existing
--     result/exact-payload-recovery semantic.
--
--   Also from the same adversarial pass: `quotation_items_enforce_frozen` now FAILS CLOSED when the
--   status guard returns NULL (an unclassifiable caller — e.g. a raw `service_role` session with no
--   PostgREST JWT claims, which `caller_jwt_role()` cannot vouch for and RLS does not backstop because
--   `service_role` has BYPASSRLS). Previously a NULL guard result skipped the freeze silently.
--
-- Forward-only, idempotent. No feature flag. The DB owner / migration admin remains trusted.

-- ─────────────────────────────────────────────────────────────────────────────
-- (1a) FAIL CLOSED if an API role can CREATE in a trusted schema (would allow a persistent shadow object).
-- This migration does NOT revoke hosted privileges — it reports an incompatible condition to the operator.
-- Coupling note (reviewed): this precondition deliberately shares the migration (and its transaction) with
-- Corrections 1b/2 — the systemic hardening must not be recorded as applied into a schema where an API
-- role can plant persistent shadow objects. If it trips, the whole of 0067 rolls back and the runner
-- stops; the operator remediates the privilege (owner-approved) and re-runs — nothing is half-applied.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare r text; s text; g record;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      foreach s in array (case when pg_catalog.to_regnamespace('extensions') is not null
                               then array['public','extensions'] else array['public'] end) loop
        -- Direct or inherited CREATE (has_schema_privilege reflects PUBLIC grants and INHERIT membership).
        if pg_catalog.has_schema_privilege(r, s, 'CREATE') then
          raise exception '0067 fail-closed: role % has CREATE on schema % — a persistent shadow object could be planted there. REVOKE CREATE (owner-approved) before applying; this migration does not alter hosted privileges.', r, s;
        end if;
        -- SET-ROLE-reachable CREATE: has_schema_privilege does NOT count privilege a NOINHERIT role can
        -- reach by explicitly SET ROLE-ing to a role it is a member of (verified empirically). PostgREST
        -- never issues SET ROLE, but a raw-SQL session as the API role could — treat it as the same hole.
        for g in
          select gr.rolname
            from pg_catalog.pg_roles gr
           where gr.rolname <> r
             and pg_catalog.pg_has_role(r, gr.oid, 'MEMBER')          -- r may SET ROLE gr (direct/transitive)
             and pg_catalog.has_schema_privilege(gr.oid, s, 'CREATE') -- incl. a superuser target: worst case
        loop
          raise exception '0067 fail-closed: role % can reach CREATE on schema % via SET ROLE % — revoke that membership or its CREATE (owner-approved) before applying.', r, s, g.rolname;
        end loop;
      end loop;
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2a) Item-freeze guard helper now LOCKS the parent quotation (FOR UPDATE) — the SINGLE linearization
-- lock it shares with enqueue_quotation_outbox (which takes no item-row locks; see Correction 2 header).
-- Still SECURITY DEFINER + self-gating (returns a status only to a caller holding
-- sales.quotation.manage in that company, or the service worker) — never a cross-company oracle. A NULL
-- return means THE CALLER COULD NOT BE CLASSIFIED (no capability, no service JWT) — the freeze trigger
-- below treats that as a refusal, never as "not frozen". Schema-qualified + pg_temp-pinned. VOLATILE
-- (it takes a row lock).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._quotation_status_for_guard(p_company uuid, p_id uuid) returns text
language plpgsql volatile security definer set search_path = pg_catalog, extensions, public, pg_temp as $$
declare v_status text;
begin
  select status into v_status
    from public.quotations
   where id = p_id and company_id = p_company
     and (public.has_capability(p_company, 'sales.quotation.manage')
          or public.caller_jwt_role() = 'service_role')
   for update;
  return v_status;
end $$;
grant execute on function public._quotation_status_for_guard(uuid,uuid) to public;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2a′) The freeze trigger FAILS CLOSED on an unclassifiable caller. 0066's version treated a NULL guard
-- result as "not frozen", which silently waived the freeze for exactly the caller RLS cannot backstop:
-- a raw `service_role` session with no PostgREST JWT claims (`caller_jwt_role()` NULL, BYPASSRLS on).
-- Now: the trusted owner is exempt as before; a caller the guard cannot vouch for is refused ANY
-- quotation_items write regardless of parent status (PostgREST paths always carry claims; owner
-- maintenance is exempt; nothing legitimate is lost). Same body otherwise; schema-qualified;
-- pg_temp-pinned to the canonical path.
--
-- CASCADE-DELETE COMPATIBILITY (verified on live PostgreSQL 16): deleting a quotation (an authorised
-- pre-queue delete that already passed `quotations_enforce_delete_boundary`) cascades to its items via
-- the `quotation_items.quotation_id … ON DELETE CASCADE` FK. PostgreSQL executes referential-action
-- queries in the security context of the REFERENCING TABLE'S OWNER (`current_user` becomes the
-- `quotation_items` owner inside this trigger; observed empirically: current_user=owner,
-- pg_trigger_depth()=2, guard=NULL), so the cascade takes the trusted-owner branch below and the
-- fail-closed NULL branch is never reached for it — parent AND items delete cleanly. This trust is
-- NON-SPOOFABLE: client-initiated DML (including a trigger an attacker attaches to their own temp
-- table) always runs with the attacker's `current_user`, never the table owner's. The invariant the
-- trust rests on — quotations/quotation_items owner == the delivery-function owner — is ASSERTED
-- fail-closed in (2a″) below.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.quotation_items_enforce_frozen()
returns trigger language plpgsql set search_path = pg_catalog, extensions, public, pg_temp as $$   -- SECURITY INVOKER
declare s_new text; s_old text;
begin
  if public._is_quotation_delivery_owner() then
    return coalesce(new, old);  -- trusted maintenance override
  end if;
  if tg_op in ('INSERT','UPDATE') then
    s_new := public._quotation_status_for_guard(new.company_id, new.quotation_id);
    if s_new is null then
      raise exception 'quotation_items % refused: caller cannot be classified for quotation % (no capability / no service JWT) — fail closed (WP12 snapshot immutability)',
        tg_op, new.quotation_id using errcode = 'insufficient_privilege';
    end if;
    if s_new in ('queued','sent','accepted','rejected') then
      raise exception 'quotation_items % refused: parent quotation % is frozen (status %) (WP12 snapshot immutability)',
        tg_op, new.quotation_id, s_new using errcode = 'insufficient_privilege';
    end if;
  end if;
  if tg_op in ('UPDATE','DELETE') then
    s_old := public._quotation_status_for_guard(old.company_id, old.quotation_id);
    if s_old is null then
      raise exception 'quotation_items % refused: caller cannot be classified for quotation % (no capability / no service JWT) — fail closed (WP12 snapshot immutability)',
        tg_op, old.quotation_id using errcode = 'insufficient_privilege';
    end if;
    if s_old in ('queued','sent','accepted','rejected') then
      raise exception 'quotation_items % refused: parent quotation % is frozen (status %) (WP12 snapshot immutability)',
        tg_op, old.quotation_id, s_old using errcode = 'insufficient_privilege';
    end if;
  end if;
  return coalesce(new, old);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2a″) FAIL CLOSED: pin the ownership invariant the cascade trust (2a′) rests on. The authorised
-- quotations→quotation_items ON DELETE CASCADE is exempt from the fail-closed freeze ONLY because the RI
-- action runs as the `quotation_items` table owner and that owner IS the trusted delivery owner
-- (`_is_quotation_delivery_owner()` resolves the owner of the exact 9-arg `enqueue_quotation_outbox`).
-- If either table were ever re-owned away from the delivery-function owner, the cascade would stop being
-- trusted and every legitimate draft/awaiting_price delete of an itemised quotation would fail 42501.
-- Refuse to record this migration as applied in that state.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare fn_owner oid; t regclass; t_owner oid;
begin
  select p.proowner into fn_owner
    from pg_catalog.pg_proc p
   where p.oid = pg_catalog.to_regprocedure(
     'public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text)');
  if fn_owner is null then
    raise exception '0067 fail-closed: the exact 9-arg public.enqueue_quotation_outbox is missing — WP12 delivery state is inconsistent';
  end if;
  foreach t in array array['public.quotations'::regclass, 'public.quotation_items'::regclass] loop
    select c.relowner into t_owner from pg_catalog.pg_class c where c.oid = t;
    if t_owner is distinct from fn_owner then
      raise exception '0067 fail-closed: % is owned by % but the delivery functions are owned by % — the authorised ON DELETE CASCADE would no longer run as the trusted owner (the fail-closed freeze would refuse legitimate pre-queue deletes). Align ownership before applying.',
        t, t_owner::regrole, fn_owner::regrole;
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2b) enqueue_quotation_outbox: add the authoritative item-state guard. Replaces the 0064 body; the ONLY
-- behavioural addition is the item-snapshot validation on the `ready` path (no item-row locks — see the
-- Correction 2 header for why locking child rows here would deadlock). Every other
-- result and the EXACT-payload recovery are preserved verbatim. Schema-qualified + pg_temp-pinned.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.enqueue_quotation_outbox(
  p_company uuid, p_quotation uuid, p_recipient text, p_body text, p_idempotency_key text,
  p_expected_total numeric, p_expected_currency text,
  p_channel text default 'whatsapp', p_message_purpose text default 'quotation'
) returns text language plpgsql security definer set search_path = pg_catalog, extensions, public, pg_temp as $$
declare
  v_status text; v_total numeric; v_currency text;
  v_company uuid; v_src_type text; v_src_id uuid; v_n int;
  v_channel text; v_recipient text; v_body text; v_purpose text; v_found boolean;
  v_item_bad int; v_item_total numeric;
begin
  -- Linearization point: lock the company-scoped quotation row (parent BEFORE child items).
  select status, total, currency into v_status, v_total, v_currency
    from public.quotations where id = p_quotation and company_id = p_company for update;
  if not found then return 'inconsistent'; end if;

  if v_status in ('sent','accepted','rejected') then return 'terminal'; end if;

  -- Already queued → reconcile the EXACT existing row; its original snapshot is authoritative (no rebuild).
  if v_status = 'queued' then
    select company_id, source_type, source_id into v_company, v_src_type, v_src_id
      from public.message_outbox where idempotency_key = p_idempotency_key;
    if not found then return 'inconsistent'; end if;
    if v_company is distinct from p_company
       or v_src_type is distinct from 'quotation'
       or v_src_id  is distinct from p_quotation then
      return 'inconsistent';
    end if;
    return 'duplicate';
  end if;

  if v_status <> 'ready' then return 'not_ready'; end if;

  -- The caller's message must still match the authoritative total/currency UNDER THE LOCK.
  if p_expected_total is distinct from v_total
     or upper(btrim(coalesce(p_expected_currency,''))) is distinct from upper(btrim(coalesce(v_currency,''))) then
    return 'stale';
  end if;

  -- AUTHORITATIVE ITEM-STATE GUARD (closes the item-mutation vs enqueue race). The parent row lock taken
  -- above is the SINGLE linearization lock: every non-trusted item INSERT/UPDATE/DELETE must acquire it in
  -- its BEFORE trigger (freeze guard FOR UPDATE), so this per-statement MVCC read sees exactly the
  -- COMMITTED item state — a mutation that committed first is visible here (→ `stale` if it diverged); an
  -- uncommitted one is waiting on the parent lock and is refused 42501 after this txn commits `queued`.
  -- DELIBERATELY NO item-row locks: the target item row is locked by Postgres BEFORE its row trigger runs,
  -- so locking child rows here would create a parent→child vs child→parent AB-BA deadlock (reproduced on
  -- live PostgreSQL 16 by the pre-submission adversarial pass). One lock object → no cycle is possible.
  --
  -- UNCONDITIONAL: the expected total must equal the live SUM(line_total) — there is NO item-count
  -- exemption (deleting ALL items leaves sum 0, which cannot match a non-zero total → `stale`; a
  -- never-itemised quotation enqueues only at total 0, the degenerate case). And EVERY item must be a
  -- COMPLETE snapshot line (the same completeness predicate `refreshQuotationStatus` uses to hold a
  -- quotation out of `ready`): `status = 'priced'`, non-null `unit_price`, non-null `line_total`
  -- (SUM silently ignores NULL — a priced-with-NULL-line_total item would otherwise ride an
  -- under-counted total), and a currency equal to the LOCKED quotation currency (the public quotation
  -- renders every line in the quotation currency; the catalogue-pricing path historically could copy a
  -- catalogue currency onto an item — a numeric match in the wrong currency must never send). Anything
  -- incomplete must re-enter the pricing flow, not ride an old body. No float; no conversion.
  -- NOTE (forward-risk): `quotations.tax_amount` is currently a dormant column (never set non-zero); if
  -- tax is ever wired so `total = subtotal + tax`, this check must compare `p_expected_total` against
  -- `subtotal` (or `SUM(line_total) + tax`), not the bare item sum.
  select count(*) filter (where status is distinct from 'priced'
                             or unit_price is null
                             or line_total is null
                             or upper(btrim(currency)) is distinct from upper(btrim(v_currency))),
         coalesce(sum(line_total), 0)
    into v_item_bad, v_item_total
    from public.quotation_items where quotation_id = p_quotation and company_id = p_company;
  if v_item_bad > 0 or p_expected_total is distinct from v_item_total then
    return 'stale';
  end if;

  -- ready + existing row → require an EXACT delivery-identity + payload match before recovering, else
  -- fail closed (a stale/legacy row must never be queued or drained).
  select company_id, source_type, source_id, channel, recipient, body, message_purpose
    into v_company, v_src_type, v_src_id, v_channel, v_recipient, v_body, v_purpose
    from public.message_outbox where idempotency_key = p_idempotency_key;
  v_found := found;
  if v_found then
    if v_company    is distinct from p_company
       or v_src_type  is distinct from 'quotation'
       or v_src_id    is distinct from p_quotation
       or v_channel   is distinct from p_channel
       or v_recipient is distinct from p_recipient
       or v_body      is distinct from p_body
       or v_purpose   is distinct from p_message_purpose then
      return 'inconsistent';   -- stale / cross-identity row → never queue or drain it
    end if;
    update public.quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
    return 'duplicate';        -- exact match → documented legacy recovery
  end if;

  -- No existing row → insert + advance ready→queued atomically.
  insert into public.message_outbox (company_id, channel, recipient, body, idempotency_key, status, attempts,
                                     source_type, source_id, message_purpose)
  values (p_company, p_channel, p_recipient, p_body, p_idempotency_key, 'pending', 0,
          'quotation', p_quotation, p_message_purpose)
  on conflict (idempotency_key) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    select company_id, source_type, source_id, channel, recipient, body, message_purpose
      into v_company, v_src_type, v_src_id, v_channel, v_recipient, v_body, v_purpose
      from public.message_outbox where idempotency_key = p_idempotency_key;
    if v_company is distinct from p_company or v_src_type is distinct from 'quotation' or v_src_id is distinct from p_quotation
       or v_channel is distinct from p_channel or v_recipient is distinct from p_recipient
       or v_body is distinct from p_body or v_purpose is distinct from p_message_purpose then
      return 'inconsistent';
    end if;
    update public.quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
    return 'duplicate';
  end if;

  update public.quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
  if not found then
    raise exception 'atomic quotation enqueue: % not ready at queue time', p_quotation;
  end if;
  return 'enqueued';
end $$;

-- Re-assert service-only grants for the replaced RPC (CREATE OR REPLACE preserves ACLs; be explicit).
do $$
begin
  revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from public;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from authenticated;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant execute on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) to service_role;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (1b) SYSTEMIC HARDENING — re-pin search_path on every non-extension SECURITY DEFINER function and every
-- trigger function in `public`. Catalog-driven (operates on the final active functions after 0066, not on
-- historical text). Only search_path changes. Idempotent.
--
-- Ownership: the ALTER loop selects every function the migration session CAN alter — owned by
-- `current_user` OR by any role it holds (pg_has_role … 'USAGE'; a superuser holds them all) — NOT a
-- strict `proowner = current_user` match, which would SILENTLY skip functions applied out-of-band under a
-- different owner (e.g. the hosted 0038–0041 functions applied via the SQL editor) while the disposable
-- CI database, where one session owns everything, still reported success.
--
-- SELF-VERIFY (owner-agnostic, fail-closed): after the loop, EVERY non-extension SECURITY DEFINER /
-- trigger function in `public` — REGARDLESS of owner — must carry EXACTLY the canonical parsed path
-- `pg_catalog, extensions, public, pg_temp` (elements compared after trimming whitespace and identifier
-- quotes). Anything else aborts the migration naming the function(s). This is deliberately STRICTER than
-- "pg_temp last": a pg_temp-last path can still lead with an attacker-writable schema
-- (`attacker_schema, pg_catalog, public, pg_temp`) that wins relation resolution — the fail-closed CREATE
-- check in (1a) guards only the canonical trusted schemas, so ONLY the canonical path is acceptable. It
-- also subsumes the `$user` and duplicated-pg_temp cases (neither can equal the canonical array). The
-- owner then applies docs/architecture-v2/hosted_secdef_searchpath_hardening.sql as the true owner for
-- anything this session could not alter. A silent partial hardening is thereby impossible.
--
-- Path-order note (reviewed): `extensions` precedes `public` so pgcrypto et al. resolve for finance
-- fingerprints; an extension object can therefore shadow a like-named `public` relation inside hardened
-- functions. Accepted deliberately: API roles cannot CREATE in either schema (block 1a fails closed on
-- that), extension installation is owner-gated DDL, and no collision exists today; this matches the
-- hosted companion scripts and Supabase's recommended pattern.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare r record; n int := 0; bad text;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace nsp on nsp.oid = p.pronamespace
    where nsp.nspname = 'public'
      and (p.prosecdef or p.prorettype = 'pg_catalog.trigger'::regtype)  -- SECURITY DEFINER or trigger fn
      and pg_catalog.pg_has_role(current_user, p.proowner, 'USAGE')      -- alterable by this session
      and not exists (select 1 from pg_catalog.pg_depend d                -- exclude extension-owned
                       where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set search_path = pg_catalog, extensions, public, pg_temp', r.sig);
    n := n + 1;
  end loop;
  raise notice '0067: hardened search_path (pg_catalog, extensions, public, pg_temp) on % application SECURITY DEFINER / trigger function(s)', n;

  -- Owner-agnostic residual check: fail closed unless EVERY in-scope function carries EXACTLY the
  -- canonical parsed path (trim whitespace + strip enclosing identifier quotes per element).
  select string_agg(sig, ', ' order by sig) into bad
  from (
    select p.oid::regprocedure::text as sig,
           (select c from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%') as sp
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace nsp on nsp.oid = p.pronamespace
    where nsp.nspname = 'public'
      and (p.prosecdef or p.prorettype = 'pg_catalog.trigger'::regtype)
      and not exists (select 1 from pg_catalog.pg_depend d
                       where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  ) f
  cross join lateral (
    select case when f.sp is null then null
                else (select array_agg(regexp_replace(btrim(x), '^"([^"]*)"$', '\1'))
                        from unnest(string_to_array(substr(f.sp, 13), ',')) x) end as elems
  ) e
  where e.elems is null
     or e.elems is distinct from array['pg_catalog','extensions','public','pg_temp'];
  if bad is not null then
    raise exception '0067 fail-closed: search_path hardening left function(s) without the exact canonical path (pg_catalog, extensions, public, pg_temp): %. Apply docs/architecture-v2/hosted_secdef_searchpath_hardening.sql as their owner, then re-run migrations.', bad;
  end if;
end $$;

INSERT INTO schema_migrations (version, filename) VALUES ('0067','0067_systemic_search_path_and_enqueue_item_boundary.sql') ON CONFLICT (version) DO NOTHING;


-- ==========================================================================
-- MIGRATION 0068_ai_atomic_case_persistence.sql
-- ==========================================================================

-- 0068_ai_atomic_case_persistence.sql
-- Completion-program Phase 1B (owner mandate): the AI-manager analysis paths (manual command-centre
-- + WhatsApp thread analysis) previously created tasks ONE AT A TIME with swallowed per-insert
-- errors, used the constant source identity "manual" (no dedupe), and LOG-AND-CONTINUED when the
-- management-case insert failed — so a retry could duplicate tasks and a "successful" analysis could
-- silently have no durable case.
--
-- This migration moves that persistence to ONE atomic, idempotent, service-only DB boundary:
--   * management_cases gains a caller-supplied idempotency key, UNIQUE per company;
--   * tasks gain a management_case_id linkage (the case's evidence/correlation record ties the
--     created tasks to the observation that proposed them);
--   * create_management_case_atomic(...) inserts the case + ALL its captured tasks + the audit
--     event in one transaction — any failure rolls back everything; replaying the same
--     (company, idempotency_key) returns the ORIGINAL result and creates nothing.
--
-- Invariants enforced AT THIS BOUNDARY (not just in app code):
--   * the AI can only create low-risk `captured` tasks here — the requested status is ignored;
--   * at most 20 tasks per case (the app-side cap, now fail-closed at the DB);
--   * the caller must be the trusted service context (PostgREST service_role JWT) — an
--     unclassifiable or API-role caller is refused 42501 (fail closed);
--   * company scope is a trusted PARAMETER — never read from model-influenced JSON.
--
-- Forward-only, idempotent DDL. No feature flag (this is a correctness boundary, not a capability).

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) Schema: idempotency identity + task linkage.
-- ─────────────────────────────────────────────────────────────────────────────
alter table management_cases add column if not exists idempotency_key text;
create unique index if not exists management_cases_company_idem_uq
  on management_cases (company_id, idempotency_key)
  where idempotency_key is not null;

alter table tasks add column if not exists management_case_id uuid references management_cases(id) on delete set null;
create index if not exists tasks_management_case_idx on tasks (management_case_id) where management_case_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) The atomic RPC. SECURITY DEFINER; canonical search_path (the permanent
-- search-path gate enforces exact `pg_catalog, extensions, public, pg_temp`).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.create_management_case_atomic(
  p_company uuid,
  p_idempotency_key text,
  p_case jsonb,
  p_tasks jsonb,
  p_actor uuid,
  p_audit_action text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, extensions, public, pg_temp as $$
declare
  v_case_id uuid;
  v_created int := 0;
  v_requires_human boolean;
  v_task jsonb;
  v_title text;
  v_existing record;
begin
  -- Trusted service boundary only. caller_jwt_role() is NULL for an unclassifiable caller → refuse.
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'create_management_case_atomic is a service-only boundary (caller is not the service context)'
      using errcode = 'insufficient_privilege';
  end if;

  if p_company is null then raise exception 'p_company is required'; end if;
  if coalesce(btrim(p_idempotency_key), '') = '' then
    raise exception 'p_idempotency_key is required — a constant/absent identity would defeat dedupe';
  end if;
  if p_case is null or jsonb_typeof(p_case) is distinct from 'object' then
    raise exception 'p_case must be a JSON object';
  end if;
  if p_tasks is null or jsonb_typeof(p_tasks) is distinct from 'array' then
    raise exception 'p_tasks must be a JSON array';
  end if;
  if jsonb_array_length(p_tasks) > 20 then
    raise exception 'at most 20 tasks per management case (got %)', jsonb_array_length(p_tasks);
  end if;
  if p_audit_action not in ('manager.analyzed', 'manager.thread_analyzed') then
    raise exception 'unsupported audit action %', p_audit_action;
  end if;

  v_requires_human := coalesce((p_case->>'requires_human')::boolean, false);

  -- Idempotent case insert. A concurrent duplicate blocks on the unique index until the first
  -- transaction commits, then takes the conflict path — so two identical submissions can never
  -- both create a case/task set.
  insert into public.management_cases (
    company_id, idempotency_key, correlation_id, source_event_id, ai_run_id,
    confirmed_facts, inferred_facts, evidence_refs, uncertainty, missing_info,
    confidence, required_authority, decisions, requires_human, created_tasks, created_by
  ) values (
    p_company, btrim(p_idempotency_key),
    p_case->>'correlation_id', p_case->>'source_event_id', p_case->>'ai_run_id',
    coalesce(p_case->'confirmed_facts', '[]'::jsonb),
    coalesce(p_case->'inferred_facts', '[]'::jsonb),
    coalesce(p_case->'evidence_refs', '[]'::jsonb),
    p_case->>'uncertainty',
    coalesce(p_case->'missing_info', '[]'::jsonb),
    nullif(p_case->>'confidence', '')::numeric,
    p_case->>'required_authority',
    coalesce(p_case->'decisions', '[]'::jsonb),
    v_requires_human, 0, p_actor
  )
  on conflict (company_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_case_id;

  if v_case_id is null then
    -- Replay: return the ORIGINAL result; create nothing.
    select id, created_tasks, requires_human into v_existing
      from public.management_cases
     where company_id = p_company and idempotency_key = btrim(p_idempotency_key);
    if v_existing.id is null then
      raise exception 'management case conflict without a visible original (unexpected)';
    end if;
    return jsonb_build_object(
      'duplicate', true,
      'case_id', v_existing.id,
      'created_tasks', v_existing.created_tasks,
      'requires_human', v_existing.requires_human
    );
  end if;

  -- All tasks or none: any invalid element raises and rolls the ENTIRE case back.
  for v_task in select value from jsonb_array_elements(p_tasks) loop
    v_title := btrim(coalesce(v_task->>'title', ''));
    if v_title = '' then
      raise exception 'task % has an empty title — the whole case is rolled back', v_created + 1;
    end if;
    insert into public.tasks (
      company_id, management_case_id, title, description,
      status, requires_evidence, created_by
    ) values (
      p_company, v_case_id, left(v_title, 300), nullif(v_task->>'note', ''),
      'captured',                                      -- forced: the AI proposes; only low-risk capture
      coalesce((v_task->>'requires_evidence')::boolean, false),
      p_actor
    );
    v_created := v_created + 1;
  end loop;

  update public.management_cases set created_tasks = v_created where id = v_case_id;

  -- The required audit event, inside the same transaction.
  insert into public.audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (
    p_company, 'ai', p_actor, p_audit_action, 'management_case', v_case_id::text,
    jsonb_build_object(
      'created_tasks', v_created,
      'correlation_id', p_case->>'correlation_id',
      'source_event_id', p_case->>'source_event_id',
      'requires_human', v_requires_human,
      'idempotency_key', btrim(p_idempotency_key)
    )
  );

  return jsonb_build_object(
    'duplicate', false,
    'case_id', v_case_id,
    'created_tasks', v_created,
    'requires_human', v_requires_human
  );
end $$;

-- Service-only EXECUTE, signature-exact.
do $$
begin
  revoke all on function public.create_management_case_atomic(uuid,text,jsonb,jsonb,uuid,text) from public;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function public.create_management_case_atomic(uuid,text,jsonb,jsonb,uuid,text) from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    revoke all on function public.create_management_case_atomic(uuid,text,jsonb,jsonb,uuid,text) from authenticated;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant execute on function public.create_management_case_atomic(uuid,text,jsonb,jsonb,uuid,text) to service_role;
  end if;
end $$;

INSERT INTO schema_migrations (version, filename) VALUES ('0068','0068_ai_atomic_case_persistence.sql') ON CONFLICT (version) DO NOTHING;


COMMIT;

-- ============================================================================
-- PART 3 — VERIFICATION (run this AFTER the COMMIT above succeeds)
-- Every row must report 'OK'.
-- ============================================================================
-- SELECT 'migrations recorded' AS check,
--        CASE WHEN count(*) = 68 THEN 'OK' ELSE 'FAIL: ' || count(*) || '/68' END AS result
--   FROM schema_migrations
-- UNION ALL
-- SELECT 'quotation delivery RPC',
--        CASE WHEN to_regprocedure('public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text)') IS NOT NULL
--             THEN 'OK' ELSE 'FAIL: missing' END
-- UNION ALL
-- SELECT 'outbox completion RPC',
--        CASE WHEN to_regprocedure('public.complete_outbox_and_advance(uuid,text,text)') IS NOT NULL
--             THEN 'OK' ELSE 'FAIL: missing' END
-- UNION ALL
-- SELECT 'AI atomic case RPC',
--        CASE WHEN to_regprocedure('public.create_management_case_atomic(uuid,text,jsonb,jsonb,uuid,text)') IS NOT NULL
--             THEN 'OK' ELSE 'FAIL: missing' END
-- UNION ALL
-- SELECT 'approval decision RPC',
--        CASE WHEN to_regprocedure('public.decide_approval(uuid,uuid,text,text)') IS NOT NULL
--             THEN 'OK' ELSE 'FAIL: missing' END
-- UNION ALL
-- SELECT 'API roles cannot CREATE in public',
--        CASE WHEN NOT (has_schema_privilege('anon','public','CREATE')
--                    OR has_schema_privilege('authenticated','public','CREATE')
--                    OR has_schema_privilege('service_role','public','CREATE'))
--             THEN 'OK' ELSE 'FAIL: revoke CREATE' END
-- UNION ALL
-- SELECT 'no unsafe SECURITY DEFINER search_path',
--        CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FAIL: ' || count(*) || ' function(s)' END
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND (p.prosecdef OR p.prorettype = 'pg_catalog.trigger'::regtype)
--    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
--    AND COALESCE((SELECT c FROM unnest(COALESCE(p.proconfig,'{}'::text[])) c WHERE c LIKE 'search_path=%'),'')
--        <> 'search_path=pg_catalog, extensions, public, pg_temp';
