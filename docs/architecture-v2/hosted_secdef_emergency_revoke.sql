-- hosted_secdef_emergency_revoke.sql
-- EMERGENCY HOTFIX — OWNER APPROVAL REQUIRED BEFORE EXECUTION.
-- (This header states a REQUIREMENT; it is NOT a record that approval has been granted.) Run ONLY:
--   * after the owner has explicitly approved running it, AND
--   * after `hosted_secdef_privilege_check.sql` shows `exposed = true` for a service-only function,
--   * on the hosted database, BEFORE migration 0062 is applied there.
-- It is the break-glass equivalent of migration 0062's lockdown, so applying 0062 afterwards is a no-op.
--
-- Catalog-driven and self-verifying. It DISCOVERS the service-only functions from the system catalog
-- (`pg_proc`, by name) and locks down every present signature of each — so it is safe on a 0041-only
-- hosted DB (only claim_outbox_batch, ledger_integrity_report and the pre-0044 7-arg _journal_post_internal
-- exist there) and on a fully-migrated DB alike, with no signature hardcoded. After the REVOKEs it
-- ASSERTS, inside the same transaction, that no `anon`/`authenticated` EXECUTE remains; if any does, it
-- RAISES and the whole transaction ABORTS — so a partial lockdown can NEVER be committed. It targets
-- ONLY internal machinery; it never touches the RLS predicate helpers or the authenticated write-path
-- RPCs (post_*/settle_*/reverse_journal/reimburse_expense_claim/*_supplier_bank_change/decide_approval),
-- which must remain callable.
--
-- This development process has NOT run this against the hosted database (owner authorisation not given).

begin;

do $$
declare
  svc_only text[] := array['_journal_post_internal', '_journal_fp_matches', 'claim_outbox_batch',
                           'complete_outbox_and_advance', 'ledger_integrity_report', 'enqueue_outbox_row',
                           'reconcile_quotation_from_outbox', 'enqueue_quotation_outbox'];
  r record;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_svc  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  residual int;
begin
  -- (1) Lock down every present signature of each service-only name.
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

  -- (2) SELF-VERIFY, in the same transaction, that nothing service-only is still reachable by a logged-in
  --     user. Any residual exposure RAISES → the transaction ABORTS → COMMIT below is a no-op. The
  --     operator therefore cannot commit a partial lockdown from a SQL-editor batch.
  select count(*) into residual
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.proname = any (svc_only)
    and (has_function_privilege('anon', p.oid, 'execute')
         or has_function_privilege('authenticated', p.oid, 'execute'));
  if residual > 0 then
    raise exception 'emergency hotfix ABORTED: % service-only signature(s) still expose EXECUTE to anon/authenticated', residual
      using hint = 'investigate before retrying; the transaction has been rolled back, nothing was committed';
  end if;
end $$;

-- Reached only when the assertion above passed (zero residual exposure).
commit;
