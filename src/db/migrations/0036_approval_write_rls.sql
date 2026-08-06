-- 0036_approval_write_rls.sql
-- WP1 — the human approval workflow tables (approval_requests, approval_actions) are
-- USER-written (a finance reviewer approves), but were excluded from 0034's domain
-- write policies. Add company-scoped write policies so the approvals action can move
-- onto the authenticated RLS client. App-layer separation-of-duties still applies.
-- ADDITIVE, FORWARD-ONLY, IDEMPOTENT.

do $$
declare t text;
begin
  foreach t in array array['approval_requests','approval_actions'] loop
    if to_regclass('public.'||t) is null then continue; end if;
    if exists (select 1 from pg_policies where schemaname='public' and tablename=t and cmd in ('INSERT','UPDATE','DELETE','ALL')) then continue; end if;
    execute format('create policy %I on %I for insert with check (has_company_access(company_id))', t||'_w_ins', t);
    execute format('create policy %I on %I for update using (has_company_access(company_id)) with check (has_company_access(company_id))', t||'_w_upd', t);
    execute format('create policy %I on %I for delete using (has_company_access(company_id))', t||'_w_del', t);
  end loop;
end $$;
