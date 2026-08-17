-- hosted_secdef_privilege_check.sql
-- READ-ONLY. Safe to run against the hosted database (no mutation). It reports, for every SECURITY
-- DEFINER function in schema public, whether anon / authenticated / service_role can EXECUTE it — so an
-- operator can see whether any service-only / internal function is reachable by a logged-in user.
--
-- Why this matters: migrations 0039/0040/0041 (owner-applied 2026-08-07) revoked EXECUTE only FROM
-- PUBLIC. On managed Supabase the `authenticated` (and `anon`) roles are typically granted EXECUTE on
-- public functions directly (not only via PUBLIC), so a `revoke … from public` alone can leave them
-- callable. Migration 0062 closes this for good; this check + the emergency hotfix are the break-glass
-- an operator can use on the hosted DB BEFORE 0062 is applied there.
--
-- This development process has NOT run this against the hosted database (owner authorisation not given).

-- (a) Full inventory — every SECURITY DEFINER function and its EXECUTE ACL.
select n.nspname                                            as schema,
       p.proname                                            as function,
       pg_get_function_identity_arguments(p.oid)            as signature,
       has_function_privilege('anon', p.oid, 'execute')          as anon_execute,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'execute')  as service_role_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
order by p.proname, signature;

-- (b) Focused — only the service-only/internal names; EXPOSED=true means a logged-in user can call it.
select p.proname                                            as function,
       pg_get_function_identity_arguments(p.oid)            as signature,
       has_function_privilege('anon', p.oid, 'execute')          as anon_execute,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
       (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute')) as exposed
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
  and p.proname in ('_journal_post_internal', '_journal_fp_matches', 'claim_outbox_batch',
                    'complete_outbox_and_advance', 'ledger_integrity_report', 'enqueue_outbox_row',
                    'reconcile_quotation_from_outbox')
order by p.proname, signature;
