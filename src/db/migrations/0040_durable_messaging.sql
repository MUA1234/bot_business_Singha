-- 0040_durable_messaging.sql
-- Production Security & Reliability Gate — Work Package C (Durable WhatsApp & outbox).
--
--   1. message_outbox gains a LEASE so two workers can never send the same row:
--      status 'processing', locked_at, lock_owner, lease_expires_at, dead_at.
--   2. claim_outbox_batch(): atomically claims a batch with FOR UPDATE SKIP LOCKED,
--      moves rows to 'processing' under a lease, and RECOVERS rows whose lease expired
--      (a crashed worker). Only service_role may call it.
--   3. wa_messages resume-safety: a `handled_at` marker so a crash BETWEEN logging the
--      inbound message and sending the reply is RESUMED (re-processed), not dropped as a
--      duplicate. A guarded partial unique index prevents duplicate inbound rows going
--      forward (skipped if the live table already has duplicates, so it can't break).
--
-- ADDITIVE, FORWARD-ONLY, IDEMPOTENT.

-- ── 1. Outbox lease columns + 'processing' status ────────────────────────────
alter table message_outbox add column if not exists locked_at timestamptz;
alter table message_outbox add column if not exists lock_owner text;
alter table message_outbox add column if not exists lease_expires_at timestamptz;
alter table message_outbox add column if not exists dead_at timestamptz;

alter table message_outbox drop constraint if exists message_outbox_status_check;
alter table message_outbox add constraint message_outbox_status_check
  check (status in ('pending','processing','sent','failed','dead'));

create index if not exists message_outbox_claim_idx
  on message_outbox (status, next_retry_at, created_at);

-- ── 2. Atomic claim with lease + expired-lease recovery ──────────────────────
create or replace function public.claim_outbox_batch(
  p_limit int, p_owner text, p_lease_seconds int default 120
) returns setof message_outbox
language plpgsql security definer set search_path = public as $$
begin
  return query
  update message_outbox m
     set status = 'processing',
         locked_at = now(),
         lock_owner = p_owner,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where m.id in (
     select id from message_outbox c
      where (
        c.status = 'pending'
        or (c.status = 'failed' and (c.next_retry_at is null or c.next_retry_at <= now()))
        -- Recover a row abandoned by a crashed worker (lease expired).
        or (c.status = 'processing' and c.lease_expires_at is not null and c.lease_expires_at <= now())
      )
      order by c.created_at
      for update skip locked
      limit p_limit
   )
   returning m.*;
end $$;

-- ── 3. wa_messages resume-safety ─────────────────────────────────────────────
alter table wa_messages add column if not exists handled_at timestamptz;

do $$
begin
  -- Only add the uniqueness guard if the live data has no existing duplicates.
  if not exists (
    select 1 from (
      select company_id, wa_message_id
      from wa_messages
      where direction = 'inbound' and wa_message_id is not null
      group by company_id, wa_message_id having count(*) > 1
    ) d
  ) then
    create unique index if not exists wa_messages_inbound_uq
      on wa_messages (company_id, wa_message_id)
      where direction = 'inbound' and wa_message_id is not null;
  end if;
end $$;

-- ── Grants: the claim function is a service-role/worker path only ─────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.claim_outbox_batch(int,text,int) from public;
    grant execute on function public.claim_outbox_batch(int,text,int) to service_role;
  end if;
end $$;
