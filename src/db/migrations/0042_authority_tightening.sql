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
