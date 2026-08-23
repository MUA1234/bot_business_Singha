-- 0096_management_directives.sql
-- GOV-001 — Management directives with response obligations.
-- Company-scoped registry of directives issued to named humans with a required response window.
-- Forward-only and idempotent.

create table if not exists management_directives (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  title text not null,
  body text,
  issued_by uuid references users(id),
  issued_to uuid not null references users(id),
  response_required_by timestamptz not null,
  status text not null default 'issued' check (status in ('issued','acknowledged','overdue','closed')),
  response text,
  acknowledged_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists management_directives_company_status_idx on management_directives (company_id, status);
create index if not exists management_directives_issued_to_idx on management_directives (issued_to);
create index if not exists management_directives_due_idx on management_directives (company_id, response_required_by);

-- Capability for directive management (additive; idempotent).
insert into permissions (key, label) values ('admin.directive.manage','Admin: manage directives') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('owner_management','admin.directive.manage'),
  ('system_administrator','admin.directive.manage')
on conflict do nothing;

-- RLS: company isolation for reads; capability-gated writes.
alter table management_directives enable row level security;

do $$
begin
  -- read: company members see directives in their company; recipients always see their own
  drop policy if exists management_directives_read on management_directives;
  create policy management_directives_read on management_directives for select using (
    public.has_company_access(company_id) or issued_to = auth.uid()
  );

  drop policy if exists management_directives_cap_ins on management_directives;
  drop policy if exists management_directives_cap_upd on management_directives;
  drop policy if exists management_directives_cap_del on management_directives;
  create policy management_directives_cap_ins on management_directives for insert with check (public.has_capability(company_id, 'admin.directive.manage'));
  create policy management_directives_cap_upd on management_directives for update using (public.has_capability(company_id, 'admin.directive.manage') or issued_to = auth.uid()) with check (public.has_capability(company_id, 'admin.directive.manage') or issued_to = auth.uid());
  create policy management_directives_cap_del on management_directives for delete using (public.has_capability(company_id, 'admin.directive.manage'));
end $$;

-- Updated-at maintenance (function already canonical from 0093).
drop trigger if exists management_directives_updated_at on management_directives;
create trigger management_directives_updated_at
  before update on management_directives
  for each row
  execute function public.set_updated_at();
