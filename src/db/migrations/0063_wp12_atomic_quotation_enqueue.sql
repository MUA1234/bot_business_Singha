-- 0063_wp12_atomic_quotation_enqueue.sql
-- FINAL external-review correction 1: close the quotation enqueue time-of-check/time-of-use race
-- ATOMICALLY at the database boundary, and enforce the legal quotation lifecycle in the database.
--
-- The prior application flow could: re-read the quotation as `ready`; a concurrent transaction moves it
-- to `sent`/`accepted`/`rejected`; `enqueueOutbox()` inserts a pending row; the guarded `ready→queued`
-- update then matches zero rows — leaving a live pending row for a terminal quotation. This migration
-- removes that window: a single SECURITY DEFINER RPC locks the quotation row, inspects the authoritative
-- status under that lock, and (only if still legally sendable as `ready`) inserts the outbox row AND
-- advances `ready→queued` in the SAME transaction. Any failure rolls back both. A BEFORE UPDATE trigger
-- makes the illegal transitions (e.g. `queued → accepted/rejected`) impossible even outside the RPC.
--
-- Forward-only, idempotent. Service-role-only. No feature flag involved (active whenever the code path
-- runs; the containment for unreviewed work is the un-migrated hosted DB, not a flag).

-- ── Legal quotation lifecycle, enforced at the DB boundary ────────────────────
-- draft/awaiting_price/ready → queued → sent → accepted/rejected, plus pre-queue re-pricing shuffles
-- and the documented `ready→sent` recovery that complete_outbox_and_advance / reconcile_quotation_from_outbox
-- perform (their WHERE allows `status in ('queued','ready')`). Every X→X (no-op / column-only update) is
-- allowed. A `queued` quotation can NEVER jump to a terminal state while its outbox message is live —
-- that is the specific safety the review requires.
create or replace function public.quotations_enforce_status_transition()
returns trigger language plpgsql as $$
declare legal boolean;
begin
  if new.status is not distinct from old.status then
    return new;  -- no status change (column-only update) — always allowed
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
      old.status, new.status, new.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists quotations_status_transition_guard on quotations;
create trigger quotations_status_transition_guard
  before update of status on quotations
  for each row execute function public.quotations_enforce_status_transition();

-- ── Atomic, service-only quotation enqueue ────────────────────────────────────
-- Linearization point: the `SELECT … FOR UPDATE` on the company-scoped quotation row. All ordering
-- decisions (terminal wins / enqueue wins / duplicate) are made under that single row lock, so two
-- concurrent finalisers and a concurrent terminal transition are fully serialized on it.
--
-- Result contract:
--   'enqueued'     — a NEW pending outbox row was created AND the quotation advanced ready→queued (atomic)
--   'duplicate'    — an outbox row for THIS (company, quotation, key) already exists; quotation is queued;
--                    the caller reconciles/drains that exact row (no new row, no second send)
--   'terminal'     — the quotation is already sent/accepted/rejected; nothing created, nothing to drain
--   'not_ready'    — the quotation is draft/awaiting_price; not sendable now
--   'stale'        — the caller's message total/currency no longer matches the locked row; do NOT queue
--   'inconsistent' — missing/cross-company quotation, a queued quotation with no row, or an idempotency
--                    key owned by a different company/source → FAIL CLOSED (nothing created/drained)
create or replace function public.enqueue_quotation_outbox(
  p_company uuid, p_quotation uuid, p_recipient text, p_body text, p_idempotency_key text,
  p_expected_total numeric, p_expected_currency text,
  p_channel text default 'whatsapp', p_message_purpose text default 'quotation'
) returns text language plpgsql security definer set search_path = public as $$
declare
  v_status text; v_total numeric; v_currency text;
  v_company uuid; v_src_type text; v_src_id uuid; v_n int;
begin
  -- LOCK the quotation row (linearization point). Cross-company / missing → fail closed.
  select status, total, currency into v_status, v_total, v_currency
    from quotations where id = p_quotation and company_id = p_company for update;
  if not found then return 'inconsistent'; end if;

  -- Terminal wins the race → never create or drain a row.
  if v_status in ('sent','accepted','rejected') then return 'terminal'; end if;

  -- Already queued → the row must already exist and be OURS; caller reconciles that exact row.
  if v_status = 'queued' then
    select company_id, source_type, source_id into v_company, v_src_type, v_src_id
      from message_outbox where idempotency_key = p_idempotency_key;
    if not found then return 'inconsistent'; end if;                 -- queued with no row → fail closed
    if v_company is distinct from p_company
       or v_src_type is distinct from 'quotation'
       or v_src_id  is distinct from p_quotation then
      return 'inconsistent';                                          -- key owned elsewhere → fail closed
    end if;
    return 'duplicate';
  end if;

  -- Only `ready` may create a NEW row.
  if v_status <> 'ready' then return 'not_ready'; end if;

  -- The caller's message must match the authoritative total/currency UNDER THE LOCK, else it is stale.
  if p_expected_total is distinct from v_total
     or upper(btrim(coalesce(p_expected_currency,''))) is distinct from upper(btrim(coalesce(v_currency,''))) then
    return 'stale';
  end if;

  -- Idempotency-key collision under the lock: if a row exists it must be ours, else fail closed.
  select company_id, source_type, source_id into v_company, v_src_type, v_src_id
    from message_outbox where idempotency_key = p_idempotency_key;
  if found then
    if v_company is distinct from p_company
       or v_src_type is distinct from 'quotation'
       or v_src_id  is distinct from p_quotation then
      return 'inconsistent';
    end if;
    update quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
    return 'duplicate';                                              -- our row already exists → duplicate
  end if;

  -- ATOMIC: insert the outbox row AND advance ready→queued in ONE transaction. If either fails, both
  -- roll back (they are a single statement / function invocation), so there is never a queued quotation
  -- without its row nor a row without the queued quotation.
  insert into message_outbox (company_id, channel, recipient, body, idempotency_key, status, attempts,
                              source_type, source_id, message_purpose)
  values (p_company, p_channel, p_recipient, p_body, p_idempotency_key, 'pending', 0,
          'quotation', p_quotation, p_message_purpose)
  on conflict (idempotency_key) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    -- Lost an insert race on the key (astronomically unlikely under the lock, since the key is unique to
    -- this quotation). Re-verify ownership; ours → duplicate, else fail closed.
    select company_id, source_type, source_id into v_company, v_src_type, v_src_id
      from message_outbox where idempotency_key = p_idempotency_key;
    if v_company is distinct from p_company or v_src_type is distinct from 'quotation' or v_src_id is distinct from p_quotation then
      return 'inconsistent';
    end if;
    update quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
    return 'duplicate';
  end if;

  update quotations set status = 'queued' where id = p_quotation and company_id = p_company and status = 'ready';
  if not found then
    -- Impossible while we hold the lock and the status was `ready`; fail closed (rolls back the insert).
    raise exception 'atomic quotation enqueue: % not ready at queue time', p_quotation;
  end if;
  return 'enqueued';
end $$;

-- ── Grants: service-only for the new RPC (revoke PUBLIC/anon/authenticated; grant service_role) ──
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
