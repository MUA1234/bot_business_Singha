-- 0098_conflicting_directive_resolution.sql
-- GOV-003 — Conflicting-instruction detection and resolution.
-- Extends management_directives with optional target/action and adds a
-- company-scoped conflict registry that is auto-populated by a trigger.
-- Forward-only and idempotent.

-- 1. Extend management_directives so a directive can name a target and action.
alter table management_directives add column if not exists target_type text;
alter table management_directives add column if not exists target_id text;
alter table management_directives add column if not exists action text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'management_directives_action_check'
      and conrelid = 'public.management_directives'::regclass
  ) then
    alter table management_directives
      add constraint management_directives_action_check
      check (action is null or action in ('approve','reject','hold','proceed','stop'));
  end if;
end $$;

create index if not exists management_directives_target_idx
  on management_directives (company_id, target_type, target_id, action);

-- 2. Conflict registry.
create table if not exists management_directive_conflicts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  directive_a_id uuid not null references management_directives(id) on delete cascade,
  directive_b_id uuid not null references management_directives(id) on delete cascade,
  target_type text,
  target_id text,
  status text not null default 'open' check (status in ('open','resolved')),
  resolution text,
  resolved_by uuid references users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists management_directive_conflicts_company_status_idx
  on management_directive_conflicts (company_id, status);

-- Deduplicate conflict pairs regardless of which directive appears first.
create unique index if not exists management_directive_conflicts_pair_uidx
  on management_directive_conflicts (
    company_id,
    least(directive_a_id, directive_b_id),
    greatest(directive_a_id, directive_b_id)
  );

-- 3. Reuse GOV-001 capability (idempotent).
insert into permissions (key, label) values ('admin.directive.manage','Admin: manage directives') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('owner_management','admin.directive.manage'),
  ('system_administrator','admin.directive.manage')
on conflict do nothing;

-- 4. RLS: company-isolated reads; capability-gated writes.
alter table management_directive_conflicts enable row level security;

do $$
begin
  drop policy if exists management_directive_conflicts_read on management_directive_conflicts;
  create policy management_directive_conflicts_read on management_directive_conflicts for select using (
    public.has_company_access(company_id)
  );

  drop policy if exists management_directive_conflicts_cap_ins on management_directive_conflicts;
  drop policy if exists management_directive_conflicts_cap_upd on management_directive_conflicts;
  drop policy if exists management_directive_conflicts_cap_del on management_directive_conflicts;
  create policy management_directive_conflicts_cap_ins on management_directive_conflicts for insert with check (public.has_capability(company_id, 'admin.directive.manage'));
  create policy management_directive_conflicts_cap_upd on management_directive_conflicts for update using (public.has_capability(company_id, 'admin.directive.manage')) with check (public.has_capability(company_id, 'admin.directive.manage'));
  create policy management_directive_conflicts_cap_del on management_directive_conflicts for delete using (public.has_capability(company_id, 'admin.directive.manage'));
end $$;

-- 5. Trigger function: detect conflicts on insert/update and auto-resolve when a directive goes inactive.
create or replace function public.detect_management_directive_conflicts()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_is_active boolean := NEW.status in ('issued','overdue')
    and NEW.target_type is not null
    and NEW.target_id is not null
    and NEW.action is not null;
begin
  -- Resolve stale open conflicts involving this directive first (other side inactive,
  -- target differs, or actions now match).
  update public.management_directive_conflicts c
  set status = 'resolved',
      resolution = coalesce(resolution, 'Auto-resolved: directive changed and no longer conflicts'),
      resolved_at = coalesce(resolved_at, now())
  where c.status = 'open'
    and c.company_id = NEW.company_id
    and (c.directive_a_id = NEW.id or c.directive_b_id = NEW.id)
    and not exists (
      select 1
      from public.management_directives d
      where d.id = case when c.directive_a_id = NEW.id then c.directive_b_id else c.directive_a_id end
        and d.company_id = NEW.company_id
        and d.status in ('issued','overdue')
        and d.target_type = NEW.target_type
        and d.target_id = NEW.target_id
        and d.action <> NEW.action
    );

  -- If this directive is no longer active or no longer names a target/action,
  -- resolve any remaining open conflicts it participates in.
  if not v_is_active then
    update public.management_directive_conflicts c
    set status = 'resolved',
        resolution = coalesce(resolution, 'Auto-resolved: directive became inactive or target removed'),
        resolved_at = coalesce(resolved_at, now())
    where c.status = 'open'
      and c.company_id = NEW.company_id
      and (c.directive_a_id = NEW.id or c.directive_b_id = NEW.id);
  end if;

  -- Create (or reopen) conflicts for every other active directive on the same target
  -- with a contradictory action.
  if v_is_active then
    insert into public.management_directive_conflicts (
      company_id, directive_a_id, directive_b_id, target_type, target_id, status
    )
    select NEW.company_id, NEW.id, d.id, NEW.target_type, NEW.target_id, 'open'
    from public.management_directives d
    where d.company_id = NEW.company_id
      and d.id <> NEW.id
      and d.status in ('issued','overdue')
      and d.target_type = NEW.target_type
      and d.target_id = NEW.target_id
      and d.action <> NEW.action
    on conflict (
      company_id,
      least(directive_a_id, directive_b_id),
      greatest(directive_a_id, directive_b_id)
    )
    do update set
      status = 'open',
      resolution = null,
      resolved_by = null,
      resolved_at = null
    where management_directive_conflicts.status <> 'open';
  end if;

  return NEW;
end;
$$;

revoke all on function public.detect_management_directive_conflicts() from public, anon, authenticated, service_role;

drop trigger if exists management_directives_conflict_detection on management_directives;
create trigger management_directives_conflict_detection
  after insert or update on management_directives
  for each row
  execute function public.detect_management_directive_conflicts();

-- 6. Updated-at maintenance (canonical helper from 0093).
drop trigger if exists management_directive_conflicts_updated_at on management_directive_conflicts;
create trigger management_directive_conflicts_updated_at
  before update on management_directive_conflicts
  for each row
  execute function public.set_updated_at();
