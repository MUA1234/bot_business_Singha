-- 0067_systemic_search_path_and_enqueue_item_boundary.sql
-- NINTH external-review bounded corrections:
--
--   CORRECTION 1 — systemic search_path audit. Migration 0066 proved that `SET search_path = public` (or
--   no search_path) plus unqualified relation references permits `pg_temp` relation shadowing, and that it
--   is NOT restricted to WP12: the accounting, approval, identity/RLS, bank-change, journal, settlement,
--   reimbursement, fingerprint and integrity functions still carry unsafe/incomplete paths. This migration
--   performs a CATALOG-DRIVEN hardening (not a text search) of the FINAL active functions after 0066: every
--   application-owned SECURITY DEFINER function and every trigger function in `public` (excluding
--   extension-owned) is re-pinned to `search_path = pg_catalog, extensions, public, pg_temp`
--   (pg_catalog first; trusted `extensions` available for digest/pgcrypto; `public` for app relations;
--   `pg_temp` explicitly LAST; no `$user`; no implicit temp-schema precedence). Only `search_path` changes —
--   never the body, owner, arguments, return type, SECURITY DEFINER/INVOKER classification or ACL. The
--   migration FAILS CLOSED if anon/authenticated/service_role has CREATE on the trusted `public`/`extensions`
--   schemas (a shadowing object could be planted there) — it does NOT alter hosted privileges; it reports.
--   A permanent integration gate (tests/integration/search-path-safety.test.ts) fails if any future
--   application SECURITY DEFINER / trigger function has an unsafe path.
--
--   CORRECTION 2 — quotation-item vs atomic-enqueue race. 0066 freezes `quotation_items` after the parent
--   is visibly queued, but `_quotation_status_for_guard()` performed an UNLOCKED parent-status read, so a
--   concurrent item mutation could still see the pre-commit `ready` status while `enqueue_quotation_outbox`
--   was queuing the previously-built message — leaving a queued outbox body/total that disagrees with the
--   committed items. Closed at the same DB linearization boundary, with ONE lock order (parent quotation
--   BEFORE child items):
--     (a) the item-freeze guard helper now reads the parent FOR UPDATE, so a concurrent item mutation
--         serializes on the quotation row that `enqueue_quotation_outbox` already locks; and
--     (b) `enqueue_quotation_outbox`, under that parent lock, locks the item rows and — for an ITEMISED
--         quotation — requires the caller's expected total to equal the authoritative live sum of item
--         line totals, else returns `stale`. Together: if the item mutation commits first, enqueue observes
--         the new authoritative sum and returns `stale` (never sends the old body); if enqueue commits
--         first, the concurrent item mutation waits on the parent lock and then fails 42501 (queued/frozen).
--     Numeric/Decimal correctness is preserved (all DB numeric; no float). enqueue keeps its exact
--     signature, SECURITY DEFINER owner, hardened search_path, service-role-only EXECUTE, and every existing
--     result/exact-payload-recovery semantic.
--
-- Forward-only, idempotent. No feature flag. The DB owner / migration admin remains trusted.

-- ─────────────────────────────────────────────────────────────────────────────
-- (1a) FAIL CLOSED if an API role can CREATE in a trusted schema (would allow a persistent shadow object).
-- This migration does NOT revoke hosted privileges — it reports an incompatible condition to the operator.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      if pg_catalog.has_schema_privilege(r, 'public', 'CREATE') then
        raise exception '0067 fail-closed: role % has CREATE on schema public — a persistent shadow object could be planted there. REVOKE CREATE (owner-approved) before applying; this migration does not alter hosted privileges.', r;
      end if;
      if pg_catalog.to_regnamespace('extensions') is not null
         and pg_catalog.has_schema_privilege(r, 'extensions', 'CREATE') then
        raise exception '0067 fail-closed: role % has CREATE on schema extensions — REVOKE CREATE (owner-approved) before applying.', r;
      end if;
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2a) Item-freeze guard helper now LOCKS the parent quotation (FOR UPDATE) — the linearization point it
-- shares with enqueue_quotation_outbox. Still SECURITY DEFINER + self-gating (returns a status only to a
-- caller holding sales.quotation.manage in that company, or the service worker) — never a cross-company
-- oracle. Schema-qualified + pg_temp-pinned. VOLATILE (it takes a row lock).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._quotation_status_for_guard(p_company uuid, p_id uuid) returns text
language plpgsql volatile security definer set search_path = pg_catalog, extensions, public, pg_temp as $$
declare v_status text;
begin
  select status into v_status
    from public.quotations
   where id = p_id and company_id = p_company
     and (public.has_capability(p_company, 'sales.quotation.manage')
          or public.caller_jwt_role() = 'service_role')
   for update;
  return v_status;
end $$;
grant execute on function public._quotation_status_for_guard(uuid,uuid) to public;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2b) enqueue_quotation_outbox: add the authoritative item-state guard. Replaces the 0064 body; the ONLY
-- behavioural additions are the item-row lock + itemised-total validation on the `ready` path. Every other
-- result and the EXACT-payload recovery are preserved verbatim. Schema-qualified + pg_temp-pinned.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.enqueue_quotation_outbox(
  p_company uuid, p_quotation uuid, p_recipient text, p_body text, p_idempotency_key text,
  p_expected_total numeric, p_expected_currency text,
  p_channel text default 'whatsapp', p_message_purpose text default 'quotation'
) returns text language plpgsql security definer set search_path = pg_catalog, extensions, public, pg_temp as $$
declare
  v_status text; v_total numeric; v_currency text;
  v_company uuid; v_src_type text; v_src_id uuid; v_n int;
  v_channel text; v_recipient text; v_body text; v_purpose text; v_found boolean;
  v_item_count int; v_item_total numeric;
begin
  -- Linearization point: lock the company-scoped quotation row (parent BEFORE child items).
  select status, total, currency into v_status, v_total, v_currency
    from public.quotations where id = p_quotation and company_id = p_company for update;
  if not found then return 'inconsistent'; end if;

  if v_status in ('sent','accepted','rejected') then return 'terminal'; end if;

  -- Already queued → reconcile the EXACT existing row; its original snapshot is authoritative (no rebuild).
  if v_status = 'queued' then
    select company_id, source_type, source_id into v_company, v_src_type, v_src_id
      from public.message_outbox where idempotency_key = p_idempotency_key;
    if not found then return 'inconsistent'; end if;
    if v_company is distinct from p_company
       or v_src_type is distinct from 'quotation'
       or v_src_id  is distinct from p_quotation then
      return 'inconsistent';
    end if;
    return 'duplicate';
  end if;

  if v_status <> 'ready' then return 'not_ready'; end if;

  -- The caller's message must still match the authoritative total/currency UNDER THE LOCK.
  if p_expected_total is distinct from v_total
     or upper(btrim(coalesce(p_expected_currency,''))) is distinct from upper(btrim(coalesce(v_currency,''))) then
    return 'stale';
  end if;

  -- AUTHORITATIVE ITEM-STATE GUARD (closes the item-mutation vs enqueue race). Under the parent lock, lock
  -- the child item rows (parent-before-child order → no deadlock) and, for an ITEMISED quotation, require
  -- the expected total to equal the live sum of item line totals. A concurrent item mutation that committed
  -- FIRST changed this sum → `stale` (never send the stale body); a mutation that has NOT committed is held
  -- by the item guard's parent lock until this txn commits `queued`, then refused (42501). A non-itemised
  -- quotation (no rows) has no item state to disagree with — the quotations.total check above governs it.
  perform 1 from public.quotation_items where quotation_id = p_quotation and company_id = p_company for update;
  select count(*), coalesce(sum(line_total), 0) into v_item_count, v_item_total
    from public.quotation_items where quotation_id = p_quotation and company_id = p_company;
  if v_item_count > 0 and p_expected_total is distinct from v_item_total then
    return 'stale';
  end if;
  -- NOTE (semantics): the authoritative total of an ITEMISED quotation is the live item sum (checked
  -- above). A quotation with NO line items falls back to its stored `quotations.total` (the total/currency
  -- check higher up governs it) — in production a `ready` quotation is always itemised (refreshQuotation
  -- Status sets total = SUM(line_total); total>0 implies items exist), so the item-less branch is
  -- reached only by item-free test seeds. NOTE (forward-risk): `quotations.tax_amount` is currently a
  -- dormant column (never set non-zero); if tax is ever wired so `total = subtotal + tax`, this check must
  -- compare `p_expected_total` against `subtotal` (or `SUM(line_total) + tax`), not the bare item sum.

  -- ready + existing row → require an EXACT delivery-identity + payload match before recovering, else
  -- fail closed (a stale/legacy row must never be queued or drained).
  select company_id, source_type, source_id, channel, recipient, body, message_purpose
    into v_company, v_src_type, v_src_id, v_channel, v_recipient, v_body, v_purpose
    from public.message_outbox where idempotency_key = p_idempotency_key;
  v_found := found;
  if v_found then
    if v_company    is distinct from p_company
       or v_src_type  is distinct from 'quotation'
       or v_src_id    is distinct from p_quotation
       or v_channel   is distinct from p_channel
       or v_recipient is distinct from p_recipient
       or v_body      is distinct from p_body
       or v_purpose   is distinct from p_message_purpose then
      return 'inconsistent';   -- stale / cross-identity row → never queue or drain it
    end if;
    update public.quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
    return 'duplicate';        -- exact match → documented legacy recovery
  end if;

  -- No existing row → insert + advance ready→queued atomically.
  insert into public.message_outbox (company_id, channel, recipient, body, idempotency_key, status, attempts,
                                     source_type, source_id, message_purpose)
  values (p_company, p_channel, p_recipient, p_body, p_idempotency_key, 'pending', 0,
          'quotation', p_quotation, p_message_purpose)
  on conflict (idempotency_key) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    select company_id, source_type, source_id, channel, recipient, body, message_purpose
      into v_company, v_src_type, v_src_id, v_channel, v_recipient, v_body, v_purpose
      from public.message_outbox where idempotency_key = p_idempotency_key;
    if v_company is distinct from p_company or v_src_type is distinct from 'quotation' or v_src_id is distinct from p_quotation
       or v_channel is distinct from p_channel or v_recipient is distinct from p_recipient
       or v_body is distinct from p_body or v_purpose is distinct from p_message_purpose then
      return 'inconsistent';
    end if;
    update public.quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
    return 'duplicate';
  end if;

  update public.quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
  if not found then
    raise exception 'atomic quotation enqueue: % not ready at queue time', p_quotation;
  end if;
  return 'enqueued';
end $$;

-- Re-assert service-only grants for the replaced RPC (CREATE OR REPLACE preserves ACLs; be explicit).
do $$
begin
  revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from public;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from authenticated;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant execute on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) to service_role;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (1b) SYSTEMIC HARDENING — re-pin search_path on every application-owned SECURITY DEFINER function and
-- every trigger function in `public`, EXCLUDING extension-owned functions. Catalog-driven (operates on the
-- final active functions after 0066, not on historical text). Only search_path changes. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare r record; n int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace nsp on nsp.oid = p.pronamespace
    where nsp.nspname = 'public'
      and (p.prosecdef or p.prorettype = 'pg_catalog.trigger'::regtype)  -- SECURITY DEFINER or trigger fn
      and p.proowner = current_user::regrole::oid                        -- application-owned (migration role)
      and not exists (select 1 from pg_catalog.pg_depend d                -- exclude extension-owned
                       where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set search_path = pg_catalog, extensions, public, pg_temp', r.sig);
    n := n + 1;
  end loop;
  raise notice '0067: hardened search_path (pg_catalog, extensions, public, pg_temp) on % application SECURITY DEFINER / trigger function(s)', n;
end $$;
