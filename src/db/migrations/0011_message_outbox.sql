-- 0011_message_outbox.sql
-- Architecture V2 change plan §5.7 — transactional outbox for outbound messages.
-- ADDITIVE: creates the table only. The live synchronous WhatsApp reply (owner
-- instruction 2026-08-04) is unchanged; the delivery worker that drains this table
-- is wired in a later, tested step. Forward-only and idempotent.

create table if not exists message_outbox (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  channel text not null default 'whatsapp' check (channel in ('whatsapp','email')),
  recipient text not null,
  body text not null,
  -- Hard dedup: one logical send exists once, so a retry/concurrent finalise no-ops.
  idempotency_key text not null unique,
  status text not null default 'pending' check (status in ('pending','sent','failed','dead')),
  attempts int not null default 0,
  last_error text,
  provider_message_id text,
  correlation_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists message_outbox_status_idx on message_outbox (status, created_at);

-- RLS: company-scoped reads; sends are service-role only (default deny for users).
alter table message_outbox enable row level security;
drop policy if exists message_outbox_read on message_outbox;
create policy message_outbox_read on message_outbox for select
  using (company_id is not null and has_company_access(company_id));
