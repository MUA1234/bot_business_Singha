-- 0099_directive_escalation.sql
-- GOV-002 — Directive acknowledgement and escalation.
-- Extends management_directives with an optional escalation chain and tracks the
-- current escalation level. A cron route evaluates unacknowledged/overdue directives
-- and advances them up the chain, writing audit events. Forward-only and idempotent.

-- 1. Extend management_directives with escalation tracking.
alter table management_directives add column if not exists escalation_chain jsonb default '[]';
alter table management_directives add column if not exists escalated_to uuid references users(id) on delete set null;
alter table management_directives add column if not exists escalation_level int not null default 0;
alter table management_directives add column if not exists escalated_at timestamptz;
alter table management_directives add column if not exists escalation_reason text;

-- Ensure the default is pinned for newly added rows (idempotent).
alter table management_directives alter column escalation_level set default 0;

-- 2. Update the status check to include 'escalated'.
do $$
begin
  -- Drop the existing check if it is present (GOV-001 inline check or a prior named one).
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.management_directives'::regclass
      and contype = 'c'
      and conname = 'management_directives_status_check'
  ) then
    alter table public.management_directives drop constraint management_directives_status_check;
  end if;

  -- Also drop any legacy inline-generated check that does not allow 'escalated'.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.management_directives'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%(%issued%acknowledged%overdue%closed%)%'
      and pg_get_constraintdef(oid) not like '%escalated%'
  ) then
    alter table public.management_directives drop constraint management_directives_status_check;
  end if;

  -- Add the canonical named check.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.management_directives'::regclass
      and conname = 'management_directives_status_check'
  ) then
    alter table public.management_directives
      add constraint management_directives_status_check
      check (status in ('issued','acknowledged','overdue','closed','escalated'));
  end if;
end $$;

-- 3. Index to support the cron sweep over active, overdue directives.
create index if not exists management_directives_status_due_idx
  on management_directives (status, response_required_by);

-- 4. RLS refresh: escalated_to must also see/update the directive they now own.
do $$
begin
  drop policy if exists management_directives_read on management_directives;
  create policy management_directives_read on management_directives for select using (
    public.has_company_access(company_id) or issued_to = auth.uid() or escalated_to = auth.uid()
  );

  drop policy if exists management_directives_cap_ins on management_directives;
  drop policy if exists management_directives_cap_upd on management_directives;
  drop policy if exists management_directives_cap_del on management_directives;
  create policy management_directives_cap_ins on management_directives for insert with check (public.has_capability(company_id, 'admin.directive.manage'));
  create policy management_directives_cap_upd on management_directives for update using (
    public.has_capability(company_id, 'admin.directive.manage') or issued_to = auth.uid() or escalated_to = auth.uid()
  ) with check (
    public.has_capability(company_id, 'admin.directive.manage') or issued_to = auth.uid() or escalated_to = auth.uid()
  );
  create policy management_directives_cap_del on management_directives for delete using (public.has_capability(company_id, 'admin.directive.manage'));
end $$;
