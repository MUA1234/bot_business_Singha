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
