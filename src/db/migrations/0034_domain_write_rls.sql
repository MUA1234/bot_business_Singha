-- 0034_domain_write_rls.sql
-- WP1 write-path RLS. Company-scoped WRITE policies on ordinary domain tables so that,
-- once the app moves writes onto the authenticated client, a user can only write rows
-- in THEIR company (cross-company writes are impossible at the DB). App-layer capability
-- checks (requireFinance, etc.) still decide WHO may act; RLS is the company-isolation
-- backstop.
--
-- EXCLUDES ledger / worker / append-only tables that must NEVER be user-writable
-- directly (posted via RPC or written only by background workers). Tables that already
-- carry write policies (identity + tasks from 0023, capability-gated) are left as-is.
--
-- ADDITIVE, FORWARD-ONLY, IDEMPOTENT (skips tables that already have a write policy).

do $$
declare
  t text;
  excluded text[] := array[
    -- append-only / audit
    'audit_events',
    -- AI / event worker tables
    'ai_runs','ai_recommendations','source_events','dead_letter_events',
    'clarification_requests','duplicate_candidates','policy_evaluations',
    'approval_requests','approval_actions','conversation_references','document_extractions',
    'financial_events','financial_event_versions','financial_event_allocations',
    'management_cases',
    -- outbound / idempotency workers
    'message_outbox','idempotency_keys',
    -- the ledger: written ONLY via post_manual_journal / settlement / reversal RPCs
    'journal_entries','journal_lines',
    -- computed snapshots
    'capacity_snapshots'
  ];
begin
  for t in
    select distinct table_name
    from information_schema.columns
    where table_schema = 'public' and column_name = 'company_id'
  loop
    if t = any(excluded) then continue; end if;
    -- Leave tables that already have any write policy (e.g. capability-gated in 0023).
    if exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and cmd in ('INSERT','UPDATE','DELETE','ALL')
    ) then continue; end if;

    execute format('create policy %I on %I for insert with check (has_company_access(company_id))', t || '_w_ins', t);
    execute format('create policy %I on %I for update using (has_company_access(company_id)) with check (has_company_access(company_id))', t || '_w_upd', t);
    execute format('create policy %I on %I for delete using (has_company_access(company_id))', t || '_w_del', t);
  end loop;
end $$;
