-- 0041_ledger_integrity_report.sql
-- Production Security & Reliability Gate — Work Package E (observability). A read-only
-- integrity probe for the health surface: it detects ledger imbalance, header/line
-- mismatches, orphaned journal lines and postings that landed in a locked/closed period.
-- It reports — it changes nothing. Service-role only (the health endpoint runs as the
-- service role and may span companies). FORWARD-ONLY, IDEMPOTENT.

create or replace function public.ledger_integrity_report(p_company uuid default null)
returns table(
  imbalanced_journals bigint,
  header_line_mismatch bigint,
  orphaned_lines bigint,
  locked_period_postings bigint
)
language sql stable security definer set search_path = public as $$
  with line_sums as (
    select jl.journal_id, jl.company_id, sum(jl.debit) as d, sum(jl.credit) as c
    from journal_lines jl
    where p_company is null or jl.company_id = p_company
    group by jl.journal_id, jl.company_id
  )
  select
    -- lines within a journal do not balance
    (select count(*) from line_sums where round(d, 2) <> round(c, 2)),
    -- header totals disagree with the sum of the lines
    (select count(*) from journal_entries je
       join line_sums ls on ls.journal_id = je.id
       where (p_company is null or je.company_id = p_company)
         and (round(je.total_debit, 2) <> round(ls.d, 2) or round(je.total_credit, 2) <> round(ls.c, 2))),
    -- a line whose journal is missing or belongs to another company
    (select count(*) from journal_lines jl
       left join journal_entries je on je.id = jl.journal_id
       where (p_company is null or jl.company_id = p_company)
         and (je.id is null or je.company_id <> jl.company_id)),
    -- a posted journal sitting inside a closed/locked period
    (select count(*) from journal_entries je
       join accounting_periods ap
         on ap.company_id = je.company_id and je.posting_date between ap.start_date and ap.end_date
       where (p_company is null or je.company_id = p_company)
         and je.status = 'posted' and ap.status in ('closed', 'locked'));
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.ledger_integrity_report(uuid) from public;
    grant execute on function public.ledger_integrity_report(uuid) to service_role;
  end if;
end $$;
