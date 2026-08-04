-- 0007_app_profiles_and_orders.sql
-- The operational APP layer on top of the accounting core:
--   • employee profiles (username → department + admin flag)
--   • extensible departments catalog
--   • product / price catalog (what the AI quoting engine prices against)
--   • WhatsApp conversation + order + quotation + price-confirmation tables
--
-- Everything is company-scoped (CLAUDE.md: explicit company_id everywhere) and
-- RLS-protected. A single default company (Singha) is seeded so the pilot works
-- without a separate provisioning step. Cross-department leakage is prevented by
-- department-aware RLS + explicit filtering in server code.

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────────────────────
-- Default company (pilot). Deterministic UUID so app code can reference it.
-- ─────────────────────────────────────────────────────────────────────────────
insert into companies (id, name, legal_name, base_currency, country, status)
values ('00000000-0000-0000-0000-00000000515a', 'Singha', 'Singha (Pvt) Ltd', 'LKR', 'LK', 'active')
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Departments catalog (extensible). Keys match src/lib/departments.ts.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists departments_catalog (
  key         text primary key,
  label       text not null,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into departments_catalog (key, label, description) values
  ('admin',       'Admin / Owner',    'Full control of the platform.'),
  ('sales',       'Sales & Orders',   'WhatsApp orders, customers and quotations.'),
  ('finance',     'Finance',          'Invoices, payments, approvals, exports.'),
  ('marketing',   'Marketing',        'Campaigns, audiences and broadcasts.'),
  ('operations',  'Operations',       'Fulfilment, tasks and delivery.'),
  ('hr',          'Human Resources',  'Staff records and internal requests.'),
  ('procurement', 'Procurement',      'Suppliers, purchasing and inventory.')
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- Employee profiles. id == auth.users.id. Username is unique; login maps
-- <username>@singha.local → this row. `department` decides the dashboard.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete restrict
              default '00000000-0000-0000-0000-00000000515a',
  username    text not null unique,
  full_name   text,
  department  text not null references departments_catalog(key),
  is_admin    boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid
);

create index if not exists profiles_company_dept_idx on profiles (company_id, department);

-- Helper functions for RLS (SECURITY DEFINER so policies can read profiles).
create or replace function public.my_department()
returns text language sql stable security definer set search_path = public as $$
  select department from profiles where id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from profiles where id = auth.uid() and is_active), false)
$$;

create or replace function public.my_company()
returns uuid language sql stable security definer set search_path = public as $$
  select company_id from profiles where id = auth.uid()
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Product / price catalog. The AI quoting engine prices against this; a miss
-- means the line needs human price confirmation.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists product_catalog (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  name        text not null,
  sku         text,
  unit_price  numeric(18,2),
  currency    char(3) not null default 'LKR',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid
);
create index if not exists product_catalog_company_idx on product_catalog (company_id, is_active);

-- ─────────────────────────────────────────────────────────────────────────────
-- WhatsApp conversations (order intake state machine) + message log.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists wa_conversations (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id) on delete cascade,
  customer_wa_id  text not null,              -- E.164 without '+', as Meta sends it
  customer_name   text,
  status          text not null default 'collecting'
                  check (status in ('collecting','quoting','awaiting_price','quoted','closed')),
  state           jsonb not null default '{}'::jsonb,  -- collected fields so far
  last_inbound_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (company_id, customer_wa_id)
);

create table if not exists wa_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references wa_conversations(id) on delete cascade,
  company_id       uuid not null references companies(id) on delete cascade,
  direction        text not null check (direction in ('inbound','outbound')),
  body             text,
  wa_message_id    text,                      -- provider id (idempotency for sends)
  created_at       timestamptz not null default now()
);
create index if not exists wa_messages_conv_idx on wa_messages (conversation_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Orders (captured customer request) + quotations + line items.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists orders (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id) on delete cascade,
  conversation_id  uuid references wa_conversations(id) on delete set null,
  customer_name    text,
  customer_phone   text,
  customer_address text,
  customer_email   text,
  request_text     text,                      -- the raw ask, for staff context
  status           text not null default 'new'
                   check (status in ('new','quoted','confirmed','cancelled')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists orders_company_idx on orders (company_id, status);

create table if not exists quotations (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  order_id      uuid references orders(id) on delete set null,
  quote_number  text not null,
  currency      char(3) not null default 'LKR',
  status        text not null default 'draft'
                check (status in ('draft','awaiting_price','ready','sent','accepted','rejected')),
  subtotal      numeric(18,2) not null default 0,
  tax_amount    numeric(18,2) not null default 0,
  total         numeric(18,2) not null default 0,
  notes         text,
  public_token  text not null unique,         -- for the shareable /q/<token> page
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  unique (company_id, quote_number)
);
create index if not exists quotations_company_idx on quotations (company_id, status);

create table if not exists quotation_items (
  id            uuid primary key default gen_random_uuid(),
  quotation_id  uuid not null references quotations(id) on delete cascade,
  company_id    uuid not null references companies(id) on delete cascade,
  description   text not null,
  quantity      numeric(18,3) not null default 1,
  unit_price    numeric(18,2),                -- null until priced/confirmed
  currency      char(3) not null default 'LKR',
  line_total    numeric(18,2),
  status        text not null default 'needs_confirmation'
                check (status in ('priced','needs_confirmation')),
  catalog_id    uuid references product_catalog(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists quotation_items_quote_idx on quotation_items (quotation_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Price confirmations — routed to a department dashboard for a human decision.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists price_confirmations (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies(id) on delete cascade,
  quotation_id       uuid not null references quotations(id) on delete cascade,
  quotation_item_id  uuid not null references quotation_items(id) on delete cascade,
  department         text not null references departments_catalog(key),
  description        text not null,
  quantity           numeric(18,3) not null default 1,
  currency           char(3) not null default 'LKR',
  ai_suggested_price numeric(18,2),
  status             text not null default 'open'
                     check (status in ('open','resolved','dismissed')),
  resolved_price     numeric(18,2),
  resolved_by        uuid,
  resolved_at        timestamptz,
  note               text,
  created_at         timestamptz not null default now()
);
create index if not exists price_conf_dept_idx on price_confirmations (company_id, department, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security. Service-role server jobs bypass RLS; these protect any
-- user/anon-token access. Department scoping is the anti-leakage boundary.
-- ─────────────────────────────────────────────────────────────────────────────
alter table departments_catalog  enable row level security;
alter table profiles             enable row level security;
alter table product_catalog      enable row level security;
alter table wa_conversations     enable row level security;
alter table wa_messages          enable row level security;
alter table orders               enable row level security;
alter table quotations           enable row level security;
alter table quotation_items      enable row level security;
alter table price_confirmations  enable row level security;

-- Everyone signed-in may read the department catalog.
drop policy if exists dept_cat_read on departments_catalog;
create policy dept_cat_read on departments_catalog for select using (auth.uid() is not null);

-- Profiles: read your own; admins read all in their company.
drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles for select
  using (id = auth.uid() or (is_admin() and company_id = my_company()));

-- Catalog: sales/finance/admin of the company may read; admin writes (via app it's
-- service-role, but keep read policy for user-scoped dashboards).
drop policy if exists catalog_read on product_catalog;
create policy catalog_read on product_catalog for select
  using (company_id = my_company() and (is_admin() or my_department() in ('sales','finance')));

-- Orders / quotations / items: sales + admin of the company.
drop policy if exists orders_read on orders;
create policy orders_read on orders for select
  using (company_id = my_company() and (is_admin() or my_department() in ('sales','finance')));

drop policy if exists quotations_read on quotations;
create policy quotations_read on quotations for select
  using (company_id = my_company() and (is_admin() or my_department() in ('sales','finance')));

drop policy if exists quotation_items_read on quotation_items;
create policy quotation_items_read on quotation_items for select
  using (company_id = my_company() and (is_admin() or my_department() in ('sales','finance')));

-- Price confirmations: only the routed department (or admin) sees them.
drop policy if exists price_conf_read on price_confirmations;
create policy price_conf_read on price_confirmations for select
  using (company_id = my_company() and (is_admin() or department = my_department()));

-- Conversations / messages: sales + admin.
drop policy if exists wa_conv_read on wa_conversations;
create policy wa_conv_read on wa_conversations for select
  using (company_id = my_company() and (is_admin() or my_department() = 'sales'));

drop policy if exists wa_msg_read on wa_messages;
create policy wa_msg_read on wa_messages for select
  using (company_id = my_company() and (is_admin() or my_department() = 'sales'));
