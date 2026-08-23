-- 0095_integration_gateway.sql
-- INT-001 — Integration Gateway and connector registry.
-- Company-scoped registry of applications, connectors, event contracts and command contracts
-- with signature-required and replay-protection flags. Forward-only and idempotent.

create table if not exists integrations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists connectors (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references integrations(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  direction text not null default 'bidirectional' check (direction in ('inbound','outbound','bidirectional')),
  protocol text not null default 'https' check (protocol in ('https','webhook','email','sms','whatsapp','grpc','file')),
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists integration_event_contracts (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references connectors(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  event_type text not null,
  schema_ref text,
  signature_required boolean not null default true,
  replay_protection boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connector_id, event_type)
);

create table if not exists integration_command_contracts (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references connectors(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  command_type text not null,
  schema_ref text,
  signature_required boolean not null default true,
  replay_protection boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connector_id, command_type)
);

create index if not exists integrations_company_status_idx on integrations (company_id, status);
create index if not exists connectors_integration_idx on connectors (integration_id);
create index if not exists connectors_company_idx on connectors (company_id);
create index if not exists event_contracts_connector_idx on integration_event_contracts (connector_id);
create index if not exists command_contracts_connector_idx on integration_command_contracts (connector_id);

-- Capability for integration management (additive; idempotent).
insert into permissions (key, label) values ('admin.integration.manage','Admin: manage integration gateway') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('owner_management','admin.integration.manage'),
  ('system_administrator','admin.integration.manage')
on conflict do nothing;

-- RLS: company isolation for reads; capability-gated writes.
alter table integrations enable row level security;
alter table connectors enable row level security;
alter table integration_event_contracts enable row level security;
alter table integration_command_contracts enable row level security;

do $$
begin
  -- integrations
  drop policy if exists integrations_read on integrations;
  create policy integrations_read on integrations for select using (public.has_company_access(company_id));
  drop policy if exists integrations_cap_ins on integrations;
  drop policy if exists integrations_cap_upd on integrations;
  drop policy if exists integrations_cap_del on integrations;
  create policy integrations_cap_ins on integrations for insert with check (public.has_capability(company_id, 'admin.integration.manage'));
  create policy integrations_cap_upd on integrations for update using (public.has_capability(company_id, 'admin.integration.manage')) with check (public.has_capability(company_id, 'admin.integration.manage'));
  create policy integrations_cap_del on integrations for delete using (public.has_capability(company_id, 'admin.integration.manage'));

  -- connectors
  drop policy if exists connectors_read on connectors;
  create policy connectors_read on connectors for select using (public.has_company_access(company_id));
  drop policy if exists connectors_cap_ins on connectors;
  drop policy if exists connectors_cap_upd on connectors;
  drop policy if exists connectors_cap_del on connectors;
  create policy connectors_cap_ins on connectors for insert with check (public.has_capability(company_id, 'admin.integration.manage'));
  create policy connectors_cap_upd on connectors for update using (public.has_capability(company_id, 'admin.integration.manage')) with check (public.has_capability(company_id, 'admin.integration.manage'));
  create policy connectors_cap_del on connectors for delete using (public.has_capability(company_id, 'admin.integration.manage'));

  -- event contracts
  drop policy if exists event_contracts_read on integration_event_contracts;
  create policy event_contracts_read on integration_event_contracts for select using (public.has_company_access(company_id));
  drop policy if exists event_contracts_cap_ins on integration_event_contracts;
  drop policy if exists event_contracts_cap_upd on integration_event_contracts;
  drop policy if exists event_contracts_cap_del on integration_event_contracts;
  create policy event_contracts_cap_ins on integration_event_contracts for insert with check (public.has_capability(company_id, 'admin.integration.manage'));
  create policy event_contracts_cap_upd on integration_event_contracts for update using (public.has_capability(company_id, 'admin.integration.manage')) with check (public.has_capability(company_id, 'admin.integration.manage'));
  create policy event_contracts_cap_del on integration_event_contracts for delete using (public.has_capability(company_id, 'admin.integration.manage'));

  -- command contracts
  drop policy if exists command_contracts_read on integration_command_contracts;
  create policy command_contracts_read on integration_command_contracts for select using (public.has_company_access(company_id));
  drop policy if exists command_contracts_cap_ins on integration_command_contracts;
  drop policy if exists command_contracts_cap_upd on integration_command_contracts;
  drop policy if exists command_contracts_cap_del on integration_command_contracts;
  create policy command_contracts_cap_ins on integration_command_contracts for insert with check (public.has_capability(company_id, 'admin.integration.manage'));
  create policy command_contracts_cap_upd on integration_command_contracts for update using (public.has_capability(company_id, 'admin.integration.manage')) with check (public.has_capability(company_id, 'admin.integration.manage'));
  create policy command_contracts_cap_del on integration_command_contracts for delete using (public.has_capability(company_id, 'admin.integration.manage'));
end $$;

-- Updated-at maintenance (function already canonical from 0093).
drop trigger if exists integrations_updated_at on integrations;
create trigger integrations_updated_at
  before update on integrations
  for each row
  execute function public.set_updated_at();

drop trigger if exists connectors_updated_at on connectors;
create trigger connectors_updated_at
  before update on connectors
  for each row
  execute function public.set_updated_at();

drop trigger if exists event_contracts_updated_at on integration_event_contracts;
create trigger event_contracts_updated_at
  before update on integration_event_contracts
  for each row
  execute function public.set_updated_at();

drop trigger if exists command_contracts_updated_at on integration_command_contracts;
create trigger command_contracts_updated_at
  before update on integration_command_contracts
  for each row
  execute function public.set_updated_at();
