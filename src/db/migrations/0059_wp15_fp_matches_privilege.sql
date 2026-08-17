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
