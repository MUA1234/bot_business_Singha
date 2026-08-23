-- 0108_push_subscriptions.sql
-- MOB-003 — Versioned mobile APIs and push-notification readiness.
-- A user-scoped store for Web Push subscriptions. The table is intentionally small:
-- it records exactly what a service worker needs to target a user later. Actual sending
-- is owner-gated (VAPID keys, delivery provider) and is not wired yet.

create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, user_id, endpoint)
);

create index if not exists push_subscriptions_user_idx
  on push_subscriptions (company_id, user_id);

-- Self-service RLS: a user may only read/write their own subscriptions.
alter table push_subscriptions enable row level security;

do $$
begin
  drop policy if exists push_subscriptions_select on push_subscriptions;
  drop policy if exists push_subscriptions_insert on push_subscriptions;
  drop policy if exists push_subscriptions_update on push_subscriptions;
  drop policy if exists push_subscriptions_delete on push_subscriptions;

  create policy push_subscriptions_select on push_subscriptions for select using (
    auth.uid() = user_id
  );

  -- A user can only subscribe for a company they are an active member of.
  create policy push_subscriptions_insert on push_subscriptions for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from memberships
      where company_id = push_subscriptions.company_id
        and user_id = auth.uid()
        and status = 'active'
    )
  );

  create policy push_subscriptions_update on push_subscriptions for update using (
    auth.uid() = user_id
  ) with check (
    auth.uid() = user_id
    and exists (
      select 1 from memberships
      where company_id = push_subscriptions.company_id
        and user_id = auth.uid()
        and status = 'active'
    )
  );

  create policy push_subscriptions_delete on push_subscriptions for delete using (
    auth.uid() = user_id
  );
end $$;

create trigger push_subscriptions_updated_at
  before update on push_subscriptions
  for each row
  execute function public.set_updated_at();
