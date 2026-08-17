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
--   committed items. Closed at the DB linearization boundary with a SINGLE lock — the parent quotation row:
--     (a) the item-freeze guard helper reads the parent FOR UPDATE, so every non-trusted item mutation
--         (INSERT/UPDATE/DELETE) must acquire the SAME quotation-row lock that `enqueue_quotation_outbox`
--         holds. enqueue takes NO item-row locks (deliberately: the target item row is locked by Postgres
--         BEFORE its row trigger fires, so an enqueue that then locked item rows would create a genuine
--         parent→child vs child→parent AB-BA deadlock — found by the pre-submission adversarial pass and
--         reproduced on a live PostgreSQL 16; a single lock object cannot form a cycle). Under the parent
--         lock, enqueue's per-statement MVCC snapshot reads only COMMITTED item state: any mutation that
--         committed first is visible; any uncommitted mutation is waiting on the parent lock and — once
--         enqueue commits `queued` — is refused 42501 by the freeze guard (READ COMMITTED re-evaluation).
--     (b) `enqueue_quotation_outbox`, under that parent lock, requires — UNCONDITIONALLY, on the `ready`
--         path — the caller's expected total to equal the authoritative live SUM(line_total) of the
--         quotation's items, and refuses (also `stale`) if ANY item is an incomplete snapshot line:
--         `status <> 'priced'`, NULL `unit_price`, NULL `line_total` (SUM silently skips NULL — a priced
--         item with a NULL line_total would ride an under-counted total), or a currency different from
--         the LOCKED quotation currency (the public quotation renders every line in the quotation
--         currency; a numeric match in the wrong currency must never send) — exactly the completeness
--         predicate `refreshQuotationStatus` uses to keep a quotation out of `ready`. There is NO
--         item-count exemption: deleting ALL items of a `ready` quotation makes the live sum 0, which no
--         longer matches a non-zero expected total → `stale` (the pre-submission adversarial pass showed
--         the earlier `v_item_count > 0` guard let a delete-to-zero race ship a customer-facing total
--         backed by zero items). A quotation that never had items enqueues only with an expected total
--         of 0 — the degenerate seed case, impossible for a real priced quotation.
--     Numeric/Decimal correctness is preserved (all DB numeric; no float). enqueue keeps its exact
--     signature, SECURITY DEFINER owner, hardened search_path, service-role-only EXECUTE, and every existing
--     result/exact-payload-recovery semantic.
--
--   Also from the same adversarial pass: `quotation_items_enforce_frozen` now FAILS CLOSED when the
--   status guard returns NULL (an unclassifiable caller — e.g. a raw `service_role` session with no
--   PostgREST JWT claims, which `caller_jwt_role()` cannot vouch for and RLS does not backstop because
--   `service_role` has BYPASSRLS). Previously a NULL guard result skipped the freeze silently.
--
-- Forward-only, idempotent. No feature flag. The DB owner / migration admin remains trusted.

-- ─────────────────────────────────────────────────────────────────────────────
-- (1a) FAIL CLOSED if an API role can CREATE in a trusted schema (would allow a persistent shadow object).
-- This migration does NOT revoke hosted privileges — it reports an incompatible condition to the operator.
-- Coupling note (reviewed): this precondition deliberately shares the migration (and its transaction) with
-- Corrections 1b/2 — the systemic hardening must not be recorded as applied into a schema where an API
-- role can plant persistent shadow objects. If it trips, the whole of 0067 rolls back and the runner
-- stops; the operator remediates the privilege (owner-approved) and re-runs — nothing is half-applied.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare r text; s text; g record;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      foreach s in array (case when pg_catalog.to_regnamespace('extensions') is not null
                               then array['public','extensions'] else array['public'] end) loop
        -- Direct or inherited CREATE (has_schema_privilege reflects PUBLIC grants and INHERIT membership).
        if pg_catalog.has_schema_privilege(r, s, 'CREATE') then
          raise exception '0067 fail-closed: role % has CREATE on schema % — a persistent shadow object could be planted there. REVOKE CREATE (owner-approved) before applying; this migration does not alter hosted privileges.', r, s;
        end if;
        -- SET-ROLE-reachable CREATE: has_schema_privilege does NOT count privilege a NOINHERIT role can
        -- reach by explicitly SET ROLE-ing to a role it is a member of (verified empirically). PostgREST
        -- never issues SET ROLE, but a raw-SQL session as the API role could — treat it as the same hole.
        for g in
          select gr.rolname
            from pg_catalog.pg_roles gr
           where gr.rolname <> r
             and pg_catalog.pg_has_role(r, gr.oid, 'MEMBER')          -- r may SET ROLE gr (direct/transitive)
             and pg_catalog.has_schema_privilege(gr.oid, s, 'CREATE') -- incl. a superuser target: worst case
        loop
          raise exception '0067 fail-closed: role % can reach CREATE on schema % via SET ROLE % — revoke that membership or its CREATE (owner-approved) before applying.', r, s, g.rolname;
        end loop;
      end loop;
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2a) Item-freeze guard helper now LOCKS the parent quotation (FOR UPDATE) — the SINGLE linearization
-- lock it shares with enqueue_quotation_outbox (which takes no item-row locks; see Correction 2 header).
-- Still SECURITY DEFINER + self-gating (returns a status only to a caller holding
-- sales.quotation.manage in that company, or the service worker) — never a cross-company oracle. A NULL
-- return means THE CALLER COULD NOT BE CLASSIFIED (no capability, no service JWT) — the freeze trigger
-- below treats that as a refusal, never as "not frozen". Schema-qualified + pg_temp-pinned. VOLATILE
-- (it takes a row lock).
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
-- (2a′) The freeze trigger FAILS CLOSED on an unclassifiable caller. 0066's version treated a NULL guard
-- result as "not frozen", which silently waived the freeze for exactly the caller RLS cannot backstop:
-- a raw `service_role` session with no PostgREST JWT claims (`caller_jwt_role()` NULL, BYPASSRLS on).
-- Now: the trusted owner is exempt as before; a caller the guard cannot vouch for is refused ANY
-- quotation_items write regardless of parent status (PostgREST paths always carry claims; owner
-- maintenance is exempt; nothing legitimate is lost). Same body otherwise; schema-qualified;
-- pg_temp-pinned to the canonical path.
--
-- CASCADE-DELETE COMPATIBILITY (verified on live PostgreSQL 16): deleting a quotation (an authorised
-- pre-queue delete that already passed `quotations_enforce_delete_boundary`) cascades to its items via
-- the `quotation_items.quotation_id … ON DELETE CASCADE` FK. PostgreSQL executes referential-action
-- queries in the security context of the REFERENCING TABLE'S OWNER (`current_user` becomes the
-- `quotation_items` owner inside this trigger; observed empirically: current_user=owner,
-- pg_trigger_depth()=2, guard=NULL), so the cascade takes the trusted-owner branch below and the
-- fail-closed NULL branch is never reached for it — parent AND items delete cleanly. This trust is
-- NON-SPOOFABLE: client-initiated DML (including a trigger an attacker attaches to their own temp
-- table) always runs with the attacker's `current_user`, never the table owner's. The invariant the
-- trust rests on — quotations/quotation_items owner == the delivery-function owner — is ASSERTED
-- fail-closed in (2a″) below.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.quotation_items_enforce_frozen()
returns trigger language plpgsql set search_path = pg_catalog, extensions, public, pg_temp as $$   -- SECURITY INVOKER
declare s_new text; s_old text;
begin
  if public._is_quotation_delivery_owner() then
    return coalesce(new, old);  -- trusted maintenance override
  end if;
  if tg_op in ('INSERT','UPDATE') then
    s_new := public._quotation_status_for_guard(new.company_id, new.quotation_id);
    if s_new is null then
      raise exception 'quotation_items % refused: caller cannot be classified for quotation % (no capability / no service JWT) — fail closed (WP12 snapshot immutability)',
        tg_op, new.quotation_id using errcode = 'insufficient_privilege';
    end if;
    if s_new in ('queued','sent','accepted','rejected') then
      raise exception 'quotation_items % refused: parent quotation % is frozen (status %) (WP12 snapshot immutability)',
        tg_op, new.quotation_id, s_new using errcode = 'insufficient_privilege';
    end if;
  end if;
  if tg_op in ('UPDATE','DELETE') then
    s_old := public._quotation_status_for_guard(old.company_id, old.quotation_id);
    if s_old is null then
      raise exception 'quotation_items % refused: caller cannot be classified for quotation % (no capability / no service JWT) — fail closed (WP12 snapshot immutability)',
        tg_op, old.quotation_id using errcode = 'insufficient_privilege';
    end if;
    if s_old in ('queued','sent','accepted','rejected') then
      raise exception 'quotation_items % refused: parent quotation % is frozen (status %) (WP12 snapshot immutability)',
        tg_op, old.quotation_id, s_old using errcode = 'insufficient_privilege';
    end if;
  end if;
  return coalesce(new, old);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2a″) FAIL CLOSED: pin the ownership invariant the cascade trust (2a′) rests on. The authorised
-- quotations→quotation_items ON DELETE CASCADE is exempt from the fail-closed freeze ONLY because the RI
-- action runs as the `quotation_items` table owner and that owner IS the trusted delivery owner
-- (`_is_quotation_delivery_owner()` resolves the owner of the exact 9-arg `enqueue_quotation_outbox`).
-- If either table were ever re-owned away from the delivery-function owner, the cascade would stop being
-- trusted and every legitimate draft/awaiting_price delete of an itemised quotation would fail 42501.
-- Refuse to record this migration as applied in that state.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare fn_owner oid; t regclass; t_owner oid;
begin
  select p.proowner into fn_owner
    from pg_catalog.pg_proc p
   where p.oid = pg_catalog.to_regprocedure(
     'public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text)');
  if fn_owner is null then
    raise exception '0067 fail-closed: the exact 9-arg public.enqueue_quotation_outbox is missing — WP12 delivery state is inconsistent';
  end if;
  foreach t in array array['public.quotations'::regclass, 'public.quotation_items'::regclass] loop
    select c.relowner into t_owner from pg_catalog.pg_class c where c.oid = t;
    if t_owner is distinct from fn_owner then
      raise exception '0067 fail-closed: % is owned by % but the delivery functions are owned by % — the authorised ON DELETE CASCADE would no longer run as the trusted owner (the fail-closed freeze would refuse legitimate pre-queue deletes). Align ownership before applying.',
        t, t_owner::regrole, fn_owner::regrole;
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2b) enqueue_quotation_outbox: add the authoritative item-state guard. Replaces the 0064 body; the ONLY
-- behavioural addition is the item-snapshot validation on the `ready` path (no item-row locks — see the
-- Correction 2 header for why locking child rows here would deadlock). Every other
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
  v_item_bad int; v_item_total numeric;
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

  -- AUTHORITATIVE ITEM-STATE GUARD (closes the item-mutation vs enqueue race). The parent row lock taken
  -- above is the SINGLE linearization lock: every non-trusted item INSERT/UPDATE/DELETE must acquire it in
  -- its BEFORE trigger (freeze guard FOR UPDATE), so this per-statement MVCC read sees exactly the
  -- COMMITTED item state — a mutation that committed first is visible here (→ `stale` if it diverged); an
  -- uncommitted one is waiting on the parent lock and is refused 42501 after this txn commits `queued`.
  -- DELIBERATELY NO item-row locks: the target item row is locked by Postgres BEFORE its row trigger runs,
  -- so locking child rows here would create a parent→child vs child→parent AB-BA deadlock (reproduced on
  -- live PostgreSQL 16 by the pre-submission adversarial pass). One lock object → no cycle is possible.
  --
  -- UNCONDITIONAL: the expected total must equal the live SUM(line_total) — there is NO item-count
  -- exemption (deleting ALL items leaves sum 0, which cannot match a non-zero total → `stale`; a
  -- never-itemised quotation enqueues only at total 0, the degenerate case). And EVERY item must be a
  -- COMPLETE snapshot line (the same completeness predicate `refreshQuotationStatus` uses to hold a
  -- quotation out of `ready`): `status = 'priced'`, non-null `unit_price`, non-null `line_total`
  -- (SUM silently ignores NULL — a priced-with-NULL-line_total item would otherwise ride an
  -- under-counted total), and a currency equal to the LOCKED quotation currency (the public quotation
  -- renders every line in the quotation currency; the catalogue-pricing path historically could copy a
  -- catalogue currency onto an item — a numeric match in the wrong currency must never send). Anything
  -- incomplete must re-enter the pricing flow, not ride an old body. No float; no conversion.
  -- NOTE (forward-risk): `quotations.tax_amount` is currently a dormant column (never set non-zero); if
  -- tax is ever wired so `total = subtotal + tax`, this check must compare `p_expected_total` against
  -- `subtotal` (or `SUM(line_total) + tax`), not the bare item sum.
  select count(*) filter (where status is distinct from 'priced'
                             or unit_price is null
                             or line_total is null
                             or upper(btrim(currency)) is distinct from upper(btrim(v_currency))),
         coalesce(sum(line_total), 0)
    into v_item_bad, v_item_total
    from public.quotation_items where quotation_id = p_quotation and company_id = p_company;
  if v_item_bad > 0 or p_expected_total is distinct from v_item_total then
    return 'stale';
  end if;

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
-- (1b) SYSTEMIC HARDENING — re-pin search_path on every non-extension SECURITY DEFINER function and every
-- trigger function in `public`. Catalog-driven (operates on the final active functions after 0066, not on
-- historical text). Only search_path changes. Idempotent.
--
-- Ownership: the ALTER loop selects every function the migration session CAN alter — owned by
-- `current_user` OR by any role it holds (pg_has_role … 'USAGE'; a superuser holds them all) — NOT a
-- strict `proowner = current_user` match, which would SILENTLY skip functions applied out-of-band under a
-- different owner (e.g. the hosted 0038–0041 functions applied via the SQL editor) while the disposable
-- CI database, where one session owns everything, still reported success.
--
-- SELF-VERIFY (owner-agnostic, fail-closed): after the loop, EVERY non-extension SECURITY DEFINER /
-- trigger function in `public` — REGARDLESS of owner — must carry EXACTLY the canonical parsed path
-- `pg_catalog, extensions, public, pg_temp` (elements compared after trimming whitespace and identifier
-- quotes). Anything else aborts the migration naming the function(s). This is deliberately STRICTER than
-- "pg_temp last": a pg_temp-last path can still lead with an attacker-writable schema
-- (`attacker_schema, pg_catalog, public, pg_temp`) that wins relation resolution — the fail-closed CREATE
-- check in (1a) guards only the canonical trusted schemas, so ONLY the canonical path is acceptable. It
-- also subsumes the `$user` and duplicated-pg_temp cases (neither can equal the canonical array). The
-- owner then applies docs/architecture-v2/hosted_secdef_searchpath_hardening.sql as the true owner for
-- anything this session could not alter. A silent partial hardening is thereby impossible.
--
-- Path-order note (reviewed): `extensions` precedes `public` so pgcrypto et al. resolve for finance
-- fingerprints; an extension object can therefore shadow a like-named `public` relation inside hardened
-- functions. Accepted deliberately: API roles cannot CREATE in either schema (block 1a fails closed on
-- that), extension installation is owner-gated DDL, and no collision exists today; this matches the
-- hosted companion scripts and Supabase's recommended pattern.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare r record; n int := 0; bad text;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace nsp on nsp.oid = p.pronamespace
    where nsp.nspname = 'public'
      and (p.prosecdef or p.prorettype = 'pg_catalog.trigger'::regtype)  -- SECURITY DEFINER or trigger fn
      and pg_catalog.pg_has_role(current_user, p.proowner, 'USAGE')      -- alterable by this session
      and not exists (select 1 from pg_catalog.pg_depend d                -- exclude extension-owned
                       where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set search_path = pg_catalog, extensions, public, pg_temp', r.sig);
    n := n + 1;
  end loop;
  raise notice '0067: hardened search_path (pg_catalog, extensions, public, pg_temp) on % application SECURITY DEFINER / trigger function(s)', n;

  -- Owner-agnostic residual check: fail closed unless EVERY in-scope function carries EXACTLY the
  -- canonical parsed path (trim whitespace + strip enclosing identifier quotes per element).
  select string_agg(sig, ', ' order by sig) into bad
  from (
    select p.oid::regprocedure::text as sig,
           (select c from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%') as sp
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace nsp on nsp.oid = p.pronamespace
    where nsp.nspname = 'public'
      and (p.prosecdef or p.prorettype = 'pg_catalog.trigger'::regtype)
      and not exists (select 1 from pg_catalog.pg_depend d
                       where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  ) f
  cross join lateral (
    select case when f.sp is null then null
                else (select array_agg(regexp_replace(btrim(x), '^"([^"]*)"$', '\1'))
                        from unnest(string_to_array(substr(f.sp, 13), ',')) x) end as elems
  ) e
  where e.elems is null
     or e.elems is distinct from array['pg_catalog','extensions','public','pg_temp'];
  if bad is not null then
    raise exception '0067 fail-closed: search_path hardening left function(s) without the exact canonical path (pg_catalog, extensions, public, pg_temp): %. Apply docs/architecture-v2/hosted_secdef_searchpath_hardening.sql as their owner, then re-run migrations.', bad;
  end if;
end $$;
