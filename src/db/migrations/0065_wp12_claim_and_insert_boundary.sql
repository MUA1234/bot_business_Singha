-- 0065_wp12_claim_and_insert_boundary.sql
-- FINAL external-review WP12 boundary corrections (three findings):
--   (1) The scheduled drain (`claim_outbox_batch`) claimed ANY due outbox row without checking the
--       linked quotation, so a STALE `ready` quotation's outbox row (left `pending` after 0064 returned
--       `inconsistent`) could still be claimed + sent, and `complete_outbox_and_advance` could then do
--       `ready→sent` — bypassing the exact-payload guard. Now a quotation-delivery row is claimable ONLY
--       when its linked quotation is committed `queued`. `queued` becomes the proof that the atomic
--       enqueue / exact recovery succeeded; a `ready` (stale) row is unclaimable by inline AND scheduled drains.
--   (2) The 0064 lifecycle trigger was BEFORE UPDATE only, so a permitted direct INSERT (authenticated
--       with `sales.quotation.manage`, or `service_role`) could fabricate a `queued`/`sent`/`accepted`/
--       `rejected` quotation. A non-trusted direct writer may now create a quotation ONLY in the valid
--       initial state (`draft`, `sent_at` null). The trusted-writer check is a POSITIVE allowlist derived
--       from the delivery functions' OWNER (not a role-name denylist), so a future custom role cannot
--       bypass it. `sent_at` may be changed only in the trusted (owner) delivery-RPC context.
--   (3) Bounded DML audit: message_outbox is already service-only for writes (0048), so the queued
--       snapshot cannot be altered by authenticated users; a DELETE that orphans a row leaves it
--       unclaimable by (1) (no `queued` quotation → fail closed). See the note at the end.
--
-- Forward-only, idempotent. Service-role-only for the RPC. No feature flag involved.

-- ── Positive trusted-owner signal (SECURITY INVOKER — MUST read the real current_user) ──
-- Returns true iff the CURRENT execution role is the owner of the delivery functions. Inside a
-- SECURITY DEFINER delivery RPC, current_user = the function owner → true; a direct table write by
-- anon/authenticated/service_role/any custom role has current_user = that role → false; the DB
-- owner/migration admin (which owns the functions) → true. Derived from the function identity, so it is
-- NOT a role-name denylist and cannot be forged with a JWT field, header, application boolean or GUC.
create or replace function public._is_quotation_delivery_owner() returns boolean
language sql stable as $$
  select current_user::regrole::oid = (
    select p.proowner
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'enqueue_quotation_outbox'
    limit 1
  );
$$;
grant execute on function public._is_quotation_delivery_owner() to public;

-- ── (1) Quotation-aware claim: only a `queued` quotation's row is claimable ──
create or replace function public.claim_outbox_batch(p_limit integer, p_owner text, p_lease_seconds integer default 120)
returns setof message_outbox language plpgsql security definer set search_path = public as $$
begin
  return query
  update message_outbox m
     set status = 'processing',
         locked_at = now(),
         lock_owner = p_owner,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where m.id in (
     select c.id from message_outbox c
      where (
        -- unchanged retry/lease eligibility
        c.status = 'pending'
        or (c.status = 'failed' and (c.next_retry_at is null or c.next_retry_at <= now()))
        or (c.status = 'processing' and c.lease_expires_at is not null and c.lease_expires_at <= now())
      )
      and (
        -- Generic (non-quotation) rows: neither the source type nor the purpose is a quotation.
        (coalesce(c.source_type, '') <> 'quotation' and coalesce(c.message_purpose, '') <> 'quotation')
        or
        -- Quotation-delivery rows: claimable ONLY when fully consistent AND the linked quotation is
        -- committed `queued` in the SAME company. A row that looks like a quotation on EITHER field but
        -- has mismatched/missing quotation metadata falls through both branches → fail-closed unclaimable.
        (
          c.source_type = 'quotation' and c.message_purpose = 'quotation' and c.source_id is not null
          and exists (
            select 1 from quotations q
            where q.id = c.source_id and q.company_id = c.company_id and q.status = 'queued'
          )
        )
      )
      order by c.created_at
      for update skip locked
      limit p_limit
   )
   returning m.*;
end $$;

-- ── (2) INSERT lifecycle boundary: a non-trusted writer may create only the valid initial state ──
create or replace function public.quotations_enforce_insert_initial_state()
returns trigger language plpgsql as $$   -- SECURITY INVOKER (default) — MUST read the real current_user
begin
  if not public._is_quotation_delivery_owner()
     and (new.status is distinct from 'draft' or new.sent_at is not null) then
    raise exception 'quotation may only be created in the initial state (status=draft, sent_at null) — delivery states are set only by the service-only delivery RPCs (WP12)'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists quotations_insert_initial_state_guard on quotations;
create trigger quotations_insert_initial_state_guard
  before insert on quotations
  for each row execute function public.quotations_enforce_insert_initial_state();

-- ── (2) UPDATE lifecycle boundary: positive owner check for privileged transitions + sent_at guard ──
-- Replaces the 0064 trigger function. The privileged delivery transitions and any `sent_at` change are
-- allowed ONLY in the trusted delivery-owner context (i.e. inside the SECURITY DEFINER delivery RPCs, or
-- by the DB owner). This is a POSITIVE allowlist — a direct write by authenticated/service_role/ANY
-- custom role is refused. Non-privileged transitions (pre-queue re-pricing, sent→accepted/rejected)
-- remain functional for any legal writer.
create or replace function public.quotations_enforce_status_transition()
returns trigger language plpgsql as $$   -- SECURITY INVOKER (default)
declare legal boolean; privileged boolean; trusted boolean;
begin
  trusted := public._is_quotation_delivery_owner();

  -- `sent_at` is delivery-completion metadata: only the trusted (owner) RPC context may set/change it.
  if new.sent_at is distinct from old.sent_at and not trusted then
    raise exception 'quotation.sent_at may be changed only by the service-only delivery-completion RPCs (WP12)'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status is not distinct from old.status then
    return new;  -- no status change (column-only update, e.g. totals) — allowed
  end if;

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

  -- The delivery transitions are RPC-ONLY (positive owner allowlist, not a role-name denylist).
  privileged := (old.status = 'ready' and new.status in ('queued','sent'))
             or (old.status = 'queued' and new.status = 'sent');
  if privileged and not trusted then
    raise exception 'quotation delivery transition % -> % is RPC-only; use the service-only delivery RPCs — a direct table UPDATE is refused (WP12)',
      old.status, new.status using errcode = 'insufficient_privilege';
  end if;

  return new;
end $$;

-- Recreate the UPDATE trigger to also fire on `sent_at` (so a status-less sent_at change is guarded).
drop trigger if exists quotations_status_transition_guard on quotations;
create trigger quotations_status_transition_guard
  before update of status, sent_at on quotations
  for each row execute function public.quotations_enforce_status_transition();

-- ── Grants: claim_outbox_batch stays service-only ──
do $$
begin
  revoke all on function public.claim_outbox_batch(integer,text,integer) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.claim_outbox_batch(integer,text,integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.claim_outbox_batch(integer,text,integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.claim_outbox_batch(integer,text,integer) to service_role;
  end if;
end $$;

-- AUDIT NOTE (finding 3): message_outbox is service-only for writes (0048: authenticated/anon have no
-- INSERT/UPDATE/DELETE), so the authoritative queued snapshot cannot be altered by an authenticated user.
-- A DELETE of a quotation orphans its outbox row, but (1) makes that row unclaimable (no committed
-- `queued` quotation → fail closed), so it can never be sent. `sent_at` fabrication is blocked above.
