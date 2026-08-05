-- 0015_post_journal_rpc.sql
-- Architecture V2 change plan §8.2 — connect approval to PERSISTENT posting. This
-- function posts a manual journal ATOMICALLY (header + lines in one transaction) and
-- enforces the core invariants server-side: at least two lines, every account exists
-- & is active in the company, the period is open, no negative amounts, and
-- debit == credit (Constitution §8). Posted journals are immutable — corrections use
-- reversals. Human-initiated only (called from a permission-checked server action);
-- the language model never calls this. Forward-only, idempotent (create or replace).

create or replace function public.post_manual_journal(
  p_company uuid,
  p_date date,
  p_currency text,
  p_memo text,
  p_posted_by uuid,
  p_lines jsonb
) returns uuid
language plpgsql
as $$
declare
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_line jsonb;
  v_journal_id uuid;
  v_period_id uuid;
  v_period_status text;
  v_line_no int := 0;
  v_debit numeric;
  v_credit numeric;
  v_code text;
begin
  if p_lines is null or jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal needs at least two lines';
  end if;

  -- Period gate: a closed/locked period rejects ordinary posting.
  select id, status into v_period_id, v_period_status
  from accounting_periods
  where company_id = p_company and p_date between start_date and end_date
  order by start_date desc
  limit 1;
  if v_period_status is not null and v_period_status in ('closed', 'locked') then
    raise exception 'Accounting period is % for %', v_period_status, p_date;
  end if;

  -- Validate each line and accumulate totals.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_code := v_line->>'account_code';
    v_debit := round(coalesce((v_line->>'debit')::numeric, 0), 2);
    v_credit := round(coalesce((v_line->>'credit')::numeric, 0), 2);
    if v_debit < 0 or v_credit < 0 then
      raise exception 'Line has a negative amount';
    end if;
    if v_debit > 0 and v_credit > 0 then
      raise exception 'Line % has both a debit and a credit', v_code;
    end if;
    if not exists (
      select 1 from chart_of_accounts
      where company_id = p_company and code = v_code and is_active
    ) then
      raise exception 'Account % not found or inactive in this company', v_code;
    end if;
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
  end loop;

  if round(v_total_debit, 2) <> round(v_total_credit, 2) then
    raise exception 'Journal is unbalanced: debit % <> credit %', v_total_debit, v_total_credit;
  end if;
  if round(v_total_debit, 2) = 0 then
    raise exception 'A zero-value journal is not allowed';
  end if;

  insert into journal_entries (
    company_id, period_id, posting_date, currency, exchange_rate, memo, status,
    correlation_id, idempotency_key, total_debit, total_credit, posted_at, posted_by, created_by
  ) values (
    p_company, v_period_id, p_date, p_currency, 1, p_memo, 'posted',
    'corr_' || gen_random_uuid(), 'jm_' || gen_random_uuid(),
    round(v_total_debit, 2), round(v_total_credit, 2), now(), p_posted_by, p_posted_by
  ) returning id into v_journal_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_line_no := v_line_no + 1;
    insert into journal_lines (journal_id, company_id, account_code, debit, credit, description, line_no)
    values (
      v_journal_id, p_company, v_line->>'account_code',
      round(coalesce((v_line->>'debit')::numeric, 0), 2),
      round(coalesce((v_line->>'credit')::numeric, 0), 2),
      v_line->>'description', v_line_no
    );
  end loop;

  return v_journal_id;
end $$;
