-- 0104_communication_preferences.sql
-- COM-007 — Human handover, opt-out and communication preferences.
-- Company-scoped preferences per channel identity. Opt-out blocks automated outbound
-- sends to that identity; handover parks inbound messages from that identity for a
-- person instead of running automated dispatch.

create table if not exists communication_preferences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  channel text not null check (channel in ('whatsapp','email')),
  identity text not null,
  opt_out boolean not null default false,
  handover_to uuid references profiles(id) on delete set null,
  handover_at timestamptz,
  handover_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, channel, identity)
);

create index if not exists communication_preferences_lookup_idx
  on communication_preferences (company_id, channel, identity);

-- RLS: company-scoped reads; writes through capability or service-role.
alter table communication_preferences enable row level security;

do $$
begin
  drop policy if exists communication_preferences_read on communication_preferences;
  create policy communication_preferences_read on communication_preferences for select using (
    has_company_access(company_id)
  );

  drop policy if exists communication_preferences_cap_ins on communication_preferences;
  drop policy if exists communication_preferences_cap_upd on communication_preferences;
  drop policy if exists communication_preferences_cap_del on communication_preferences;
  create policy communication_preferences_cap_ins on communication_preferences for insert with check (
    has_capability(company_id, 'customer.manage') or has_capability(company_id, 'operations.manage')
  );
  create policy communication_preferences_cap_upd on communication_preferences for update using (
    has_capability(company_id, 'customer.manage') or has_capability(company_id, 'operations.manage')
  ) with check (
    has_company_access(company_id)
  );
  create policy communication_preferences_cap_del on communication_preferences for delete using (
    has_capability(company_id, 'customer.manage') or has_capability(company_id, 'operations.manage')
  );
end $$;
