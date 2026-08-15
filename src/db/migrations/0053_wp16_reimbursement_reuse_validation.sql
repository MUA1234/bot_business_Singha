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
