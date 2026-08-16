-- 0064_wp12_delivery_transition_boundary.sql
-- FINAL external-review WP12 database-integrity corrections:
--   (1) The privileged DELIVERY transitions must be RPC-ONLY — a direct table UPDATE (even by an
--       authenticated user with `sales.quotation.manage`, or by `service_role`) must NOT bypass the
--       atomic delivery machinery. Otherwise a direct `ready→queued` creates a queued quotation with no
--       outbox row, and a direct `ready→sent` marks a quotation sent without provider completion.
--   (2) The `ready` + existing-outbox-row recovery inside `enqueue_quotation_outbox` must compare the
--       EXACT delivery identity + payload before recovering, or it can queue/drain a STALE row (e.g. an
--       old total 100 after the quotation was repriced to 120).
--
-- Forward-only, idempotent. Service-role-only for the RPC. No feature flag involved.
--
-- MECHANISM (non-spoofable, DB-boundary). The lifecycle trigger is SECURITY INVOKER, so it observes the
-- REAL `current_user`. Inside a SECURITY DEFINER delivery RPC (owned by `postgres`), `current_user` is
-- the function owner; a direct table write by an API role has `current_user` = that API role
-- (`anon`/`authenticated`/`service_role`). The API roles cannot `SET ROLE` to the owner (no membership),
-- and the trigger is NOT SECURITY DEFINER (which would make every caller look like the owner), so the
-- distinction cannot be forged with a JWT field, header, application boolean or GUC. The DB
-- owner/migration admin (`current_user = postgres`) stays trusted.

-- ── (1) Lifecycle trigger: legal transitions + RPC-only delivery transitions ──
create or replace function public.quotations_enforce_status_transition()
returns trigger language plpgsql as $$   -- SECURITY INVOKER (default) — MUST read the real current_user
declare legal boolean; privileged boolean;
begin
  if new.status is not distinct from old.status then
    return new;  -- no status change (column-only update) — always allowed
  end if;

  -- Legality of the transition (independent of who is calling).
  legal := case old.status
    when 'draft'          then new.status in ('awaiting_price','ready')
    when 'awaiting_price' then new.status in ('draft','ready')
    when 'ready'          then new.status in ('draft','awaiting_price','queued','sent')
    when 'queued'         then new.status in ('sent')
    when 'sent'           then new.status in ('accepted','rejected')
    when 'accepted'       then false   -- absorbing
    when 'rejected'       then false   -- absorbing
    else false
  end;
  if not legal then
    raise exception 'illegal quotation status transition % -> % (quotation %) (WP12 lifecycle)',
      old.status, new.status, new.id using errcode = 'check_violation';
  end if;

  -- The DELIVERY transitions are RPC-ONLY. `ready→queued` may occur only inside
  -- `enqueue_quotation_outbox`; `queued→sent` and the documented `ready→sent` recovery only inside
  -- `complete_outbox_and_advance` / `reconcile_quotation_from_outbox` — all SECURITY DEFINER, so their
  -- internal UPDATE runs with `current_user` = the owner, never an API role. A direct table write by an
  -- API role is refused here (before any row changes), so it cannot bypass the atomic/fenced machinery.
  privileged := (old.status = 'ready' and new.status in ('queued','sent'))
             or (old.status = 'queued' and new.status = 'sent');
  if privileged and current_user in ('anon','authenticated','service_role') then
    raise exception 'quotation delivery transition % -> % is RPC-only; use the service-only delivery RPCs — a direct table UPDATE is refused (WP12)',
      old.status, new.status using errcode = 'insufficient_privilege';
  end if;

  return new;
end $$;

-- The trigger definition from 0063 continues to reference this function; re-assert it for clarity.
drop trigger if exists quotations_status_transition_guard on quotations;
create trigger quotations_status_transition_guard
  before update of status on quotations
  for each row execute function public.quotations_enforce_status_transition();

-- ── (2) enqueue_quotation_outbox: EXACT-payload recovery on the ready + existing-row path ──
-- Replaces the 0063 body. The only behavioural change is that the `ready` + existing-row recovery now
-- requires the existing row's FULL delivery identity + payload (company, source type, source id,
-- idempotency key, channel, recipient, body, message purpose) to match this request before it recovers
-- `ready→queued`; any mismatch returns `inconsistent` and leaves the quotation `ready` (no create/
-- modify/queue/drain — the caller emits the operator-visible inconsistency log and never drains). For an
-- already-`queued` quotation the ORIGINAL queued snapshot remains authoritative (no payload rebuild).
create or replace function public.enqueue_quotation_outbox(
  p_company uuid, p_quotation uuid, p_recipient text, p_body text, p_idempotency_key text,
  p_expected_total numeric, p_expected_currency text,
  p_channel text default 'whatsapp', p_message_purpose text default 'quotation'
) returns text language plpgsql security definer set search_path = public as $$
declare
  v_status text; v_total numeric; v_currency text;
  v_company uuid; v_src_type text; v_src_id uuid; v_n int;
  v_channel text; v_recipient text; v_body text; v_purpose text; v_found boolean;
begin
  select status, total, currency into v_status, v_total, v_currency
    from quotations where id = p_quotation and company_id = p_company for update;
  if not found then return 'inconsistent'; end if;

  if v_status in ('sent','accepted','rejected') then return 'terminal'; end if;

  -- Already queued → reconcile the EXACT existing row; its original snapshot is authoritative (no rebuild).
  if v_status = 'queued' then
    select company_id, source_type, source_id into v_company, v_src_type, v_src_id
      from message_outbox where idempotency_key = p_idempotency_key;
    if not found then return 'inconsistent'; end if;
    if v_company is distinct from p_company
       or v_src_type is distinct from 'quotation'
       or v_src_id  is distinct from p_quotation then
      return 'inconsistent';
    end if;
    return 'duplicate';
  end if;

  if v_status <> 'ready' then return 'not_ready'; end if;

  if p_expected_total is distinct from v_total
     or upper(btrim(coalesce(p_expected_currency,''))) is distinct from upper(btrim(coalesce(v_currency,''))) then
    return 'stale';
  end if;

  -- ready + existing row → require an EXACT delivery-identity + payload match before recovering, else
  -- fail closed (a stale/legacy row must never be queued or drained).
  select company_id, source_type, source_id, channel, recipient, body, message_purpose
    into v_company, v_src_type, v_src_id, v_channel, v_recipient, v_body, v_purpose
    from message_outbox where idempotency_key = p_idempotency_key;
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
    update quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
    return 'duplicate';        -- exact match → documented legacy recovery
  end if;

  -- No existing row → insert + advance ready→queued atomically.
  insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, attempts,
                              source_type, source_id, message_purpose)
  values (p_company, p_channel, p_recipient, p_body, p_idempotency_key, 'pending', 0,
          'quotation', p_quotation, p_message_purpose)
  on conflict (idempotency_key) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    -- Lost an insert race on the key (defensive; unreachable under the row lock for this quotation's key).
    -- Re-verify the EXACT payload before recovering; else fail closed.
    select company_id, source_type, source_id, channel, recipient, body, message_purpose
      into v_company, v_src_type, v_src_id, v_channel, v_recipient, v_body, v_purpose
      from message_outbox where idempotency_key = p_idempotency_key;
    if v_company is distinct from p_company or v_src_type is distinct from 'quotation' or v_src_id is distinct from p_quotation
       or v_channel is distinct from p_channel or v_recipient is distinct from p_recipient
       or v_body is distinct from p_body or v_purpose is distinct from p_message_purpose then
      return 'inconsistent';
    end if;
    update quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
    return 'duplicate';
  end if;

  update quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
  if not found then
    raise exception 'atomic quotation enqueue: % not ready at queue time', p_quotation;
  end if;
  return 'enqueued';
end $$;

-- Re-assert service-only grants for the replaced RPC (CREATE OR REPLACE preserves ACLs, but be explicit).
do $$
begin
  revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text) to service_role;
  end if;
end $$;

-- NOTE on complete_outbox_and_advance / reconcile_quotation_from_outbox: both are SECURITY DEFINER owned
-- by the migration role, so their internal `queued→sent` / `ready→sent` UPDATEs run with current_user =
-- owner and are therefore PERMITTED by the strengthened trigger, while remaining service-role-only
-- (0062). No replacement is required; the integration tests exercise both under the new trigger.
