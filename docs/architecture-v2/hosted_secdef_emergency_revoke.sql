-- hosted_secdef_emergency_revoke.sql
-- OWNER-APPROVED EMERGENCY HOTFIX (mutation). Run ONLY:
--   * with the owner's explicit approval, AND
--   * after `hosted_secdef_privilege_check.sql` shows `exposed = true` for a service-only function,
--   * on the hosted database, BEFORE migration 0062 is applied there.
-- It is the break-glass equivalent of migration 0062's lockdown, so applying 0062 afterwards is a no-op.
--
-- Safe by construction: idempotent; name-based (locks down every present signature); `to_regprocedure`
-- guards make it a no-op for any signature not present, so it runs cleanly on a 0038–0041-only hosted
-- DB (where only claim_outbox_batch, ledger_integrity_report and the pre-0044 7-arg _journal_post_internal
-- exist) and on a fully-migrated one alike. It targets ONLY internal machinery — it never touches the
-- RLS predicate helpers (has_*/my_*/is_admin/authority_ceiling/within_authority*) or the authenticated
-- write-path RPCs (post_*/settle_*/reverse_journal/reimburse_expense_claim/*_supplier_bank_change/
-- decide_approval), which MUST remain callable.
--
-- This development process has NOT run this against the hosted database (owner authorisation not given).

begin;

do $$
declare
  svc_only text[] := array['_journal_post_internal', '_journal_fp_matches', 'claim_outbox_batch',
                           'complete_outbox_and_advance', 'ledger_integrity_report', 'enqueue_outbox_row',
                           'reconcile_quotation_from_outbox'];
  r record;
  has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  has_auth boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  has_svc  boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
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
end $$;

-- Confirm inside the same transaction BEFORE committing: this must return zero rows.
select p.proname, pg_get_function_identity_arguments(p.oid) as signature
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
  and p.proname in ('_journal_post_internal', '_journal_fp_matches', 'claim_outbox_batch',
                    'complete_outbox_and_advance', 'ledger_integrity_report', 'enqueue_outbox_row',
                    'reconcile_quotation_from_outbox')
  and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute'));

-- If the SELECT above returned any rows, ROLLBACK and investigate. Otherwise:
commit;
