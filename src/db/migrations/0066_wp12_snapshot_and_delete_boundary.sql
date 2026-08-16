-- 0066_wp12_snapshot_and_delete_boundary.sql
-- EIGHTH (final) external-review WP12 boundary corrections, plus the security-review hardening the eighth
-- review's own adversarial pass surfaced. Database-boundary hardenings:
--
--   (1) SIGNATURE-EXACT trusted-owner check. Migration 0065's `_is_quotation_delivery_owner()` resolved
--       the delivery-function owner by `proname` + `LIMIT 1`, which is not signature-exact and could bind
--       to a future overload with a different owner. It now resolves the owner from the EXACT regprocedure
--       identity of `enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text)`, and the
--       migration fails closed unless the three exact delivery functions
--       (enqueue_quotation_outbox / complete_outbox_and_advance / reconcile_quotation_from_outbox) all
--       exist, are all SECURITY DEFINER, share ONE trusted owner, and that owner is not — and cannot be
--       assumed (SET ROLE) by — anon/authenticated/service_role.
--
--   (2) CLAIM-then-DELETE race. A BEFORE DELETE trigger refuses a non-trusted DELETE of a quotation when
--       its status is queued/terminal OR any quotation-linked outbox row exists (pending/processing/
--       failed/sent/dead). A draft/awaiting_price quotation with no outbox history stays deletable. TRUNCATE
--       (which bypasses row triggers and which `service_role` holds) is refused by a statement-level guard.
--
--   (3) FROZEN queued snapshot. Once queued, a non-trusted writer may change nothing on the quotation but a
--       pure `sent→accepted`/`sent→rejected` decision; its `quotation_items` are immutable; AND the actual
--       delivery row `message_outbox` has its CONTENT (recipient/body/template/source/key) frozen while its
--       delivery-state stays worker-mutable — so the delivered message and the public /q/<token> page can
--       only reflect the authoritative queued snapshot. Pre-queue editing/repricing stays functional.
--
--   (4) SEARCH_PATH / pg_temp HARDENING (from the eighth review's adversarial security pass). Postgres
--       searches the session temp schema (`pg_temp`) for RELATION names BEFORE `pg_catalog` and `public`
--       unless `pg_temp` is explicitly listed later in `search_path`. A caller with the (default, PUBLIC)
--       TEMP privilege could therefore `CREATE TEMP TABLE pg_proc`/`quotations`/`message_outbox` to shadow
--       the real tables inside a SECURITY INVOKER trigger or a `SET search_path = public` SECURITY DEFINER
--       function, forging the owner check or hiding real rows. Every function here schema-qualifies EVERY
--       relation reference (`pg_catalog.*`, `public.*`) AND pins `search_path = pg_catalog, public, pg_temp`
--       (pg_temp LAST). The WP12 delivery RPCs are re-pinned the same way via ALTER FUNCTION.
--
--   (5) Doc correction: the `message_outbox` service-only DML boundary originated in migration **0038**
--       (0038_capability_authority.sql §6), NOT 0048. 0065's AUDIT NOTE said "0048"; 0065 is not rewritten.
--
-- Forward-only, idempotent. No feature flag involved. The DB owner / migration admin remains trusted.
-- NOTE (residual, documented): the same `set search_path = public` / unqualified-relation pattern exists in
-- OTHER-domain SECURITY DEFINER functions (accounting/approval RPCs, e.g. `decide_approval`, `_journal_*`).
-- A full-codebase search_path audit is a recommended systemic follow-up; it is OUT of this WP12 review's
-- bounded scope and is not silently applied here.

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) Migration-time fail-closed assertion of the trusted-owner model (exact signatures).
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  enq regprocedure := to_regprocedure('public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text)');
  cmp regprocedure := to_regprocedure('public.complete_outbox_and_advance(uuid,text,text)');
  rec regprocedure := to_regprocedure('public.reconcile_quotation_from_outbox(uuid)');
  o_enq oid; o_cmp oid; o_rec oid; sd_enq boolean; sd_cmp boolean; sd_rec boolean;
  owner_name text; r text;
begin
  if enq is null or cmp is null or rec is null then
    raise exception '0066 fail-closed: an exact delivery function is missing (enqueue=%, complete=%, reconcile=%)', enq, cmp, rec;
  end if;
  select proowner, prosecdef into o_enq, sd_enq from pg_catalog.pg_proc where oid = enq;
  select proowner, prosecdef into o_cmp, sd_cmp from pg_catalog.pg_proc where oid = cmp;
  select proowner, prosecdef into o_rec, sd_rec from pg_catalog.pg_proc where oid = rec;
  if not (sd_enq and sd_cmp and sd_rec) then
    raise exception '0066 fail-closed: all three delivery functions must be SECURITY DEFINER (enqueue=%, complete=%, reconcile=%)', sd_enq, sd_cmp, sd_rec;
  end if;
  if not (o_enq = o_cmp and o_cmp = o_rec) then
    raise exception '0066 fail-closed: the three delivery functions must share ONE trusted owner (got %, %, %)',
      o_enq::regrole, o_cmp::regrole, o_rec::regrole;
  end if;
  owner_name := o_enq::regrole::text;
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      if r = owner_name then
        raise exception '0066 fail-closed: the delivery-function owner must not be the API role %', r;
      end if;
      if pg_catalog.pg_has_role(r, o_enq, 'MEMBER') then
        raise exception '0066 fail-closed: API role % can assume the delivery-function owner % (SET ROLE reachable)', r, owner_name;
      end if;
    end if;
  end loop;
  raise notice '0066 trusted-owner model OK: owner=% (enqueue/complete/reconcile all SECURITY DEFINER; unreachable by anon/authenticated/service_role)', owner_name;
end $$;

-- ── (1)+(4) Signature-exact, owner-based trusted signal ──
-- SECURITY INVOKER (reads the real current_user). Resolves the trusted owner from the EXACT 9-arg identity
-- via `pg_catalog.pg_proc` (schema-qualified) with `search_path` pinning `pg_temp` LAST, so a temp table
-- named `pg_proc` cannot shadow the catalog and forge the decision. A future overload with a different
-- signature/owner has a different oid and cannot affect this exact lookup. Absent function → false (fail closed).
create or replace function public._is_quotation_delivery_owner() returns boolean
language plpgsql stable set search_path = pg_catalog, public, pg_temp as $$
declare v_owner oid;
begin
  select p.proowner into v_owner
    from pg_catalog.pg_proc p
   where p.oid = to_regprocedure('public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text)');
  if v_owner is null then
    return false;
  end if;
  return current_user::regrole::oid = v_owner;
end $$;
grant execute on function public._is_quotation_delivery_owner() to public;

-- ─────────────────────────────────────────────────────────────────────────────
-- (3) FROZEN snapshot + lifecycle: consolidated BEFORE UPDATE trigger on the WHOLE quotations row.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.quotations_enforce_status_transition()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$   -- SECURITY INVOKER
declare legal boolean; privileged boolean; trusted boolean;
begin
  trusted := public._is_quotation_delivery_owner();

  if new.sent_at is distinct from old.sent_at and not trusted then
    raise exception 'quotation.sent_at may be changed only by the service-only delivery-completion RPCs (WP12)'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status is distinct from old.status then
    legal := case old.status
      when 'draft'          then new.status in ('awaiting_price','ready')
      when 'awaiting_price' then new.status in ('draft','ready')
      when 'ready'          then new.status in ('draft','awaiting_price','queued','sent')
      when 'queued'         then new.status in ('sent')
      when 'sent'           then new.status in ('accepted','rejected')
      when 'accepted'       then false
      when 'rejected'       then false
      else false
    end;
    if not legal then
      raise exception 'illegal quotation status transition % -> % (quotation %) (WP12 lifecycle)',
        old.status, new.status, new.id using errcode = 'check_violation';
    end if;
    privileged := (old.status = 'ready' and new.status in ('queued','sent'))
               or (old.status = 'queued' and new.status = 'sent');
    if privileged and not trusted then
      raise exception 'quotation delivery transition % -> % is RPC-only; use the service-only delivery RPCs — a direct table UPDATE is refused (WP12)',
        old.status, new.status using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- FROZEN snapshot: once queued/terminal a NON-TRUSTED writer may not change any customer-facing field;
  -- the only permitted mutation is the pure status decision (constrained legal above). Trusted exempt.
  if not trusted and old.status in ('queued','sent','accepted','rejected') then
    if new.id           is distinct from old.id
       or new.company_id   is distinct from old.company_id
       or new.order_id     is distinct from old.order_id
       or new.quote_number is distinct from old.quote_number
       or new.currency     is distinct from old.currency
       or new.subtotal     is distinct from old.subtotal
       or new.tax_amount   is distinct from old.tax_amount
       or new.total        is distinct from old.total
       or new.notes        is distinct from old.notes
       or new.public_token is distinct from old.public_token
       or new.created_at   is distinct from old.created_at
       or new.sent_at      is distinct from old.sent_at then
      raise exception 'quotation % is frozen after queueing; its content is immutable to non-owners — only a sent->accepted/rejected decision is permitted (WP12 snapshot immutability)',
        old.id using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists quotations_status_transition_guard on quotations;
create trigger quotations_status_transition_guard
  before update on quotations
  for each row execute function public.quotations_enforce_status_transition();

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) DELETE boundary + (4) TRUNCATE guard on quotations.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.quotations_enforce_delete_boundary()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$   -- SECURITY INVOKER
begin
  if public._is_quotation_delivery_owner() then
    return old;  -- trusted maintenance override
  end if;
  if old.status in ('queued','sent','accepted','rejected') then
    raise exception 'quotation % cannot be deleted in status % (queued/terminal quotations are immutable to non-owners) (WP12)',
      old.id, old.status using errcode = 'insufficient_privilege';
  end if;
  if exists (
    select 1 from public.message_outbox m
     where m.company_id = old.company_id and m.source_type = 'quotation' and m.source_id = old.id
  ) then
    raise exception 'quotation % has outbox delivery history and cannot be deleted by a non-owner (WP12 claim-then-delete boundary)',
      old.id using errcode = 'insufficient_privilege';
  end if;
  return old;  -- draft/awaiting_price with no outbox history → deletable (existing product contract)
end $$;

drop trigger if exists quotations_delete_boundary_guard on quotations;
create trigger quotations_delete_boundary_guard
  before delete on quotations
  for each row execute function public.quotations_enforce_delete_boundary();

-- TRUNCATE bypasses row-level triggers, and `service_role` holds TRUNCATE on these tables (Supabase
-- `grant all ... to service_role`) even though `authenticated` does not. Statement-level BEFORE TRUNCATE
-- guards close that path for quotations, quotation_items AND message_outbox. The trusted owner may truncate.
create or replace function public.quotations_block_nontrusted_truncate()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$   -- SECURITY INVOKER
begin
  if not public._is_quotation_delivery_owner() then
    raise exception 'TRUNCATE of % is not permitted to non-owners (WP12 delete/snapshot boundary)', tg_table_name
      using errcode = 'insufficient_privilege';
  end if;
  return null;
end $$;
drop trigger if exists quotations_no_truncate_guard on quotations;
create trigger quotations_no_truncate_guard
  before truncate on quotations
  for each statement execute function public.quotations_block_nontrusted_truncate();
drop trigger if exists quotation_items_no_truncate_guard on quotation_items;
create trigger quotation_items_no_truncate_guard
  before truncate on quotation_items
  for each statement execute function public.quotations_block_nontrusted_truncate();
drop trigger if exists message_outbox_no_truncate_guard on message_outbox;
create trigger message_outbox_no_truncate_guard
  before truncate on message_outbox
  for each statement execute function public.quotations_block_nontrusted_truncate();

-- ─────────────────────────────────────────────────────────────────────────────
-- (3b) quotation_items of a queued/terminal quotation are immutable to non-trusted writers.
-- Parent status is read through a SELF-GATING SECURITY DEFINER helper (schema-qualified + pg_temp-pinned)
-- so an RLS-invisible parent (a capability holder whose department is outside the quotations READ policy)
-- cannot bypass the freeze, while the helper returns a status ONLY to a caller who already holds
-- `sales.quotation.manage` in that company (or the service worker) — never a cross-company oracle.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._quotation_status_for_guard(p_company uuid, p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select status from public.quotations
   where id = p_id and company_id = p_company
     and (public.has_capability(p_company, 'sales.quotation.manage')
          or public.caller_jwt_role() = 'service_role');
$$;
grant execute on function public._quotation_status_for_guard(uuid,uuid) to public;

create or replace function public.quotation_items_enforce_frozen()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$   -- SECURITY INVOKER
declare s_new text; s_old text;
begin
  if public._is_quotation_delivery_owner() then
    return coalesce(new, old);  -- trusted maintenance override
  end if;
  if tg_op in ('INSERT','UPDATE') then
    s_new := public._quotation_status_for_guard(new.company_id, new.quotation_id);
    if s_new in ('queued','sent','accepted','rejected') then
      raise exception 'quotation_items % refused: parent quotation % is frozen (status %) (WP12 snapshot immutability)',
        tg_op, new.quotation_id, s_new using errcode = 'insufficient_privilege';
    end if;
  end if;
  if tg_op in ('UPDATE','DELETE') then
    s_old := public._quotation_status_for_guard(old.company_id, old.quotation_id);
    if s_old in ('queued','sent','accepted','rejected') then
      raise exception 'quotation_items % refused: parent quotation % is frozen (status %) (WP12 snapshot immutability)',
        tg_op, old.quotation_id, s_old using errcode = 'insufficient_privilege';
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists quotation_items_frozen_guard on quotation_items;
create trigger quotation_items_frozen_guard
  before insert or update or delete on quotation_items
  for each row execute function public.quotation_items_enforce_frozen();

-- ─────────────────────────────────────────────────────────────────────────────
-- (3c) message_outbox content freeze: the DELIVERED message (recipient/body/template/source/key) is
-- immutable after enqueue; only delivery-state (status/attempts/lease/provider id/timestamps) stays
-- mutable — so the worker keeps working while a compromised `service_role` cannot rewrite the message body
-- or recipient of a queued/pending row, and cannot DELETE a claimed row to strand the quotation. INSERT is
-- performed by the SECURITY DEFINER enqueue RPCs (owner context = trusted), so it is unaffected.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.message_outbox_enforce_content_freeze()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$   -- SECURITY INVOKER
begin
  if public._is_quotation_delivery_owner() then
    return coalesce(new, old);  -- trusted (enqueue/complete/reconcile RPCs run as owner)
  end if;
  if tg_op = 'DELETE' then
    raise exception 'message_outbox rows may not be deleted by a non-owner (WP12: would orphan a claimed delivery)'
      using errcode = 'insufficient_privilege';
  end if;
  if new.company_id      is distinct from old.company_id
     or new.channel         is distinct from old.channel
     or new.recipient       is distinct from old.recipient
     or new.body            is distinct from old.body
     or new.idempotency_key is distinct from old.idempotency_key
     or new.correlation_id  is distinct from old.correlation_id
     or new.template_name   is distinct from old.template_name
     or new.template_params is distinct from old.template_params
     or new.template_lang   is distinct from old.template_lang
     or new.source_type     is distinct from old.source_type
     or new.source_id       is distinct from old.source_id
     or new.message_purpose is distinct from old.message_purpose then
    raise exception 'message_outbox delivery content (recipient/body/template/source/key) is immutable after enqueue; only delivery-state may change (WP12 snapshot immutability)'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists message_outbox_content_freeze_guard on message_outbox;
create trigger message_outbox_content_freeze_guard
  before update or delete on message_outbox
  for each row execute function public.message_outbox_enforce_content_freeze();

-- ─────────────────────────────────────────────────────────────────────────────
-- (4) Re-pin the WP12 delivery RPCs' search_path with pg_temp LAST (they reference public tables
-- unqualified; ALTER … SET search_path demotes pg_temp without touching their bodies). None use pgcrypto,
-- so `pg_catalog, public, pg_temp` is complete. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────
alter function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) set search_path = pg_catalog, public, pg_temp;
alter function public.complete_outbox_and_advance(uuid,text,text) set search_path = pg_catalog, public, pg_temp;
alter function public.reconcile_quotation_from_outbox(uuid) set search_path = pg_catalog, public, pg_temp;
alter function public.claim_outbox_batch(integer,text,integer) set search_path = pg_catalog, public, pg_temp;
alter function public.enqueue_outbox_row(uuid,text,text,text,text,text,text,jsonb,text,uuid,text) set search_path = pg_catalog, public, pg_temp;

-- AUDIT NOTE (correcting 0065): message_outbox is service-only for writes since migration **0038**
-- (0038_capability_authority.sql §6 — RLS + no write policy + REVOKE INSERT/UPDATE/DELETE from
-- authenticated), not 0048. Beyond that, this migration additionally freezes the message CONTENT against
-- `service_role` (3c) and blocks a non-trusted DELETE/TRUNCATE of the delivery row, so the queued snapshot
-- — the quotation body, its quotation_items, and the actual outbound message — is immutable to every
-- non-owner writer. Together with 0063–0065 the delivered message and the public /q/<token> page can only
-- ever reflect the authoritative queued snapshot.
