-- 0022_notifications.sql
-- In-app notifications (Architecture V2 change plan §10 UX). ADDITIVE, company-scoped,
-- RLS-protected. Forward-only, idempotent.

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  recipient_id uuid not null references profiles(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_recipient_idx on notifications (company_id, recipient_id, is_read, created_at);

alter table notifications enable row level security;
drop policy if exists notifications_read on notifications;
-- A user reads only their own notifications.
create policy notifications_read on notifications for select
  using (has_company_access(company_id) and recipient_id = auth.uid());
