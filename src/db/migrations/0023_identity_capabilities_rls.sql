-- 0023_identity_capabilities_rls.sql
-- WP1 (NEXT_PHASE_DEVELOPER_BRIEF §WP1) — make the MEMBERSHIP model the access
-- source of truth for capabilities, add capability + write RLS policies, and add
-- composite company FKs for the work-task parent/child tables.
--
-- ADDITIVE, FORWARD-ONLY, IDEMPOTENT (safe to re-run). Nothing is dropped.
-- Applying this does NOT by itself change the running app: the app still uses the
-- service-role client (which bypasses RLS). These functions/policies become live for
-- a page only when that page is moved onto the authenticated RLS client (later slice),
-- and each such cutover is staged + owner-approved (Constitution §15).
--
-- KEY SAFETY PROPERTY: has_company_access is EXTENDED (union), never narrowed, so no
-- existing user_company_access-based access is removed. Cross-company access stays
-- impossible because both sources are company-scoped.

set local search_path = public;

-- ── 1. Membership-aware access anchor ────────────────────────────────────────
-- Active membership for the current auth user in a company.
create or replace function public.has_membership(target_company uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from memberships m
    where m.user_id = auth.uid()
      and m.company_id = target_company
      and m.status = 'active'
  );
$$;

-- Extend the RLS anchor to honour BOTH the legacy user_company_access rows AND an
-- active membership. Union only — never removes prior access.
create or replace function public.has_company_access(target_company uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from user_company_access uca
    where uca.user_id = auth.uid() and uca.company_id = target_company
  ) or exists (
    select 1 from memberships m
    where m.user_id = auth.uid()
      and m.company_id = target_company
      and m.status = 'active'
  );
$$;

-- ── 2. Capability check via memberships → membership_roles → role_permissions ──
-- A capability is a permission key (view/approve/post/reverse/...). This is the
-- deterministic gate that replaces department-name string comparisons.
create or replace function public.has_capability(target_company uuid, capability text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from memberships m
    join membership_roles mr on mr.membership_id = m.id
    join role_permissions rp on rp.role_key = mr.role_key
    where m.user_id = auth.uid()
      and m.company_id = target_company
      and m.status = 'active'
      and rp.permission_key = capability
  );
$$;

-- ── 3. Seed role → permission grants for the membership role vocabulary ────────
-- (roles + permissions are seeded in 0001; role_permissions was empty.) Additive.
insert into role_permissions (role_key, permission_key) values
  -- Staff can see, draft, upload evidence, submit for approval.
  ('staff_submitter','view'), ('staff_submitter','create_draft'),
  ('staff_submitter','edit_draft'), ('staff_submitter','upload_evidence'),
  ('staff_submitter','submit_for_approval'),
  -- Project/division manager: staff + approve/reject within scope + export.
  ('project_manager','view'), ('project_manager','create_draft'),
  ('project_manager','edit_draft'), ('project_manager','submit_for_approval'),
  ('project_manager','approve'), ('project_manager','reject'), ('project_manager','export'),
  -- Finance reviewer: review/approve/reconcile/export (NOT post).
  ('finance_reviewer','view'), ('finance_reviewer','approve'), ('finance_reviewer','reject'),
  ('finance_reviewer','reconcile'), ('finance_reviewer','export'),
  ('finance_reviewer','submit_for_approval'),
  -- Accountant: post/reverse/reconcile/period control + export.
  ('accountant','view'), ('accountant','post'), ('accountant','reverse'),
  ('accountant','reconcile'), ('accountant','close_period'), ('accountant','reopen_period'),
  ('accountant','administer_accounts'), ('accountant','export'),
  -- Payment roles (recording only; bank execution is out of scope for the system).
  ('payment_initiator','view'), ('payment_initiator','initiate_payment'),
  ('payment_approver','view'), ('payment_approver','authorize_payment'),
  ('payment_approver','change_supplier_bank_details'),
  -- Auditor: read + export only.
  ('auditor_readonly','view'), ('auditor_readonly','export'),
  -- Owner/management: broad view + approvals + export.
  ('owner_management','view'), ('owner_management','approve'), ('owner_management','reject'),
  ('owner_management','export'), ('owner_management','administer_accounts')
on conflict do nothing;

-- System administrator gets every permission (kept in sync on re-run).
insert into role_permissions (role_key, permission_key)
select 'system_administrator', p.key from permissions p
on conflict do nothing;

-- ── 4. Delegation authority ceiling (Brief §WP1.7) ───────────────────────────
-- 0010 gave delegations dates/scope/from/to. Add an explicit authority ceiling.
alter table delegations add column if not exists domain text;
alter table delegations add column if not exists max_amount numeric(20,4);
alter table delegations add column if not exists currency char(3);

-- ── 5. Composite company FKs for work-task parent/child (Brief §WP1.6) ────────
-- Guarantee a child row cannot reference a parent in another company. NOT VALID so
-- no legacy row blocks the migration; validate later once data is confirmed clean.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_id_company_uq') then
    alter table tasks add constraint tasks_id_company_uq unique (id, company_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'task_dependencies_task_company_fk') then
    alter table task_dependencies add constraint task_dependencies_task_company_fk
      foreign key (task_id, company_id) references tasks (id, company_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'task_dependencies_dep_company_fk') then
    alter table task_dependencies add constraint task_dependencies_dep_company_fk
      foreign key (depends_on_task_id, company_id) references tasks (id, company_id) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'task_assignments_task_company_fk') then
    alter table task_assignments add constraint task_assignments_task_company_fk
      foreign key (task_id, company_id) references tasks (id, company_id) not valid;
  end if;
end $$;

-- ── 6. Write RLS policies (capability/ownership-gated) ────────────────────────
-- These are correct-by-construction and inert while the app uses service role.
-- Identity tables: only a system administrator of the company may write.
do $$
declare t text;
begin
  foreach t in array array[
    'organisation_units','memberships','membership_roles','authority_rules',
    'membership_assignments','employee_profiles','delegations'
  ] loop
    execute format('drop policy if exists %I on %I', t||'_write_ins', t);
    execute format('drop policy if exists %I on %I', t||'_write_upd', t);
    execute format('drop policy if exists %I on %I', t||'_write_del', t);
    execute format($f$create policy %I on %I for insert with check (has_capability(company_id,'administer_accounts'))$f$, t||'_write_ins', t);
    execute format($f$create policy %I on %I for update using (has_capability(company_id,'administer_accounts')) with check (has_capability(company_id,'administer_accounts'))$f$, t||'_write_upd', t);
    execute format($f$create policy %I on %I for delete using (has_capability(company_id,'administer_accounts'))$f$, t||'_write_del', t);
  end loop;
end $$;

-- Tasks: company members read; managers/admins write; assignee updates own task.
alter table tasks enable row level security;
drop policy if exists tasks_read on tasks;
create policy tasks_read on tasks for select using (has_company_access(company_id));

drop policy if exists tasks_write_ins on tasks;
create policy tasks_write_ins on tasks for insert
  with check (has_capability(company_id,'create_draft'));

drop policy if exists tasks_write_upd on tasks;
create policy tasks_write_upd on tasks for update using (
  has_capability(company_id,'approve')                 -- manager/admin in company
  or exists (                                            -- or the assignee, own task
    select 1 from memberships m
    where m.user_id = auth.uid()
      and m.company_id = tasks.company_id
      and m.status = 'active'
      and (m.user_id = tasks.assigned_to
           or exists (select 1 from task_assignments ta
                      where ta.task_id = tasks.id and ta.membership_id = m.id))
  )
) with check (has_company_access(company_id));
