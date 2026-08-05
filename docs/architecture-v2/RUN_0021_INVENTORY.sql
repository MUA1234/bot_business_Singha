-- Singha — migration 0021: inventory items + stock movements. Additive, idempotent.

begin;
create extension if not exists pgcrypto;

-- 0021_inventory.sql
-- Architecture V2 change plan §9.2 — inventory items + stock movements. ADDITIVE,
-- company-scoped, RLS-protected. Forward-only, idempotent.

create table if not exists inventory_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  sku text,
  unit text,
  location text,
  quantity_on_hand numeric(18,3) not null default 0,
  reorder_level numeric(18,3) not null default 0,
  unit_cost numeric(18,2) not null default 0,
  currency char(3) not null default 'LKR',
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (company_id, sku)
);
create index if not exists inventory_items_company_idx on inventory_items (company_id);

create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  item_id uuid not null references inventory_items(id) on delete cascade,
  direction text not null check (direction in ('in','out','adjust')),
  quantity numeric(18,3) not null,
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid
);
create index if not exists stock_movements_item_idx on stock_movements (item_id, created_at);

alter table inventory_items enable row level security;
alter table stock_movements enable row level security;
drop policy if exists inventory_items_read on inventory_items;
drop policy if exists stock_movements_read on stock_movements;
create policy inventory_items_read on inventory_items for select using (has_company_access(company_id));
create policy stock_movements_read on stock_movements for select using (has_company_access(company_id));

commit;
