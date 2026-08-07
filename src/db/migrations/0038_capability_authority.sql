-- 0038_capability_authority.sql
-- Production Security & Reliability Gate — Work Package A (Database authority & RLS).
--
-- Makes Postgres the FINAL authority boundary. Direct use of the authenticated Supabase
-- API can no longer bypass application permissions:
--   1. Domain-qualified capability vocabulary (finance.*, procurement.*, legal.*, hr.*,
--      operations.*, admin.identity.manage) seeded into `permissions`.
--   2. Least-privilege role → capability mappings (managers do NOT get finance/legal/HR).
--   3. has_company_access made SUSPENSION-SAFE: once a user has a membership row in a
--      company, that membership's status is authoritative — a suspended member loses
--      access even if a legacy user_company_access row still exists. Legacy-only users
--      (no membership yet) keep working during the staged cutover.
--   4. has_capability made DELEGATION-AWARE (date-windowed, domain-scoped, and never
--      granting the delegate more than the delegator holds), plus amount ceilings via
--      authority_ceiling()/within_authority().
--   5. Generic company-access write policies from 0034/0036 REPLACED with capability
--      policies on sensitive finance/procurement/legal/HR/approval tables.
--   6. Service-only tables (payments, ledger, outbox, idempotency, worker/append-only)
--      REJECT direct authenticated writes entirely (RPC/worker paths only).
--   7. Approval-action writes enforce separation of duties in the policy itself.
--
-- ADDITIVE, FORWARD-ONLY, IDEMPOTENT (safe to re-run). Inert while the app uses the
-- service-role client (RLS bypassed); becomes live per page-group at the RLS_WRITES
-- cutover (WP D), each staged + owner-approved. Cross-company access stays impossible.

set local search_path = public;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Domain-qualified capability vocabulary
-- ─────────────────────────────────────────────────────────────────────────────
insert into permissions (key, label) values
  ('finance.invoice.create','Finance: create customer invoice'),
  ('finance.invoice.post','Finance: post customer invoice'),
  ('finance.receipt.record','Finance: record customer receipt'),
  ('finance.bill.create','Finance: create supplier bill'),
  ('finance.bill.post','Finance: post supplier bill'),
  ('finance.payment.record','Finance: record supplier payment / reimbursement'),
  ('finance.journal.post','Finance: post manual journal'),
  ('finance.journal.reverse','Finance: reverse journal'),
  ('finance.reconcile','Finance: reconcile'),
  ('finance.period.close','Finance: close/reopen accounting period'),
  ('finance.bank_details.request','Finance: request supplier bank-detail change (maker)'),
  ('finance.bank_details.approve','Finance: approve supplier bank-detail change (checker)'),
  ('procurement.request.create','Procurement: create request / RFQ'),
  ('procurement.po.approve','Procurement: approve purchase order'),
  ('procurement.goods.receive','Procurement: receive goods'),
  ('legal.matter.manage','Legal: manage matters'),
  ('legal.contract.manage','Legal: manage contracts'),
  ('hr.staff.manage','HR: manage staff records'),
  ('operations.task.manage','Operations: manage tasks (create/assign/close)'),
  ('operations.task.work','Operations: work an assigned task'),
  ('admin.identity.manage','Admin: manage identity (memberships, roles, delegations)')
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Least-privilege role → capability mappings.
--    Managers (project_manager) get operations/procurement, NOT finance/legal/HR.
-- ─────────────────────────────────────────────────────────────────────────────
insert into role_permissions (role_key, permission_key) values
  -- Accountant/poster: the full finance posting authority.
  ('accountant','finance.invoice.create'), ('accountant','finance.invoice.post'),
  ('accountant','finance.receipt.record'), ('accountant','finance.bill.create'),
  ('accountant','finance.bill.post'), ('accountant','finance.payment.record'),
  ('accountant','finance.journal.post'), ('accountant','finance.journal.reverse'),
  ('accountant','finance.reconcile'), ('accountant','finance.period.close'),
  ('accountant','finance.bank_details.request'),
  -- Finance reviewer: create/record/reconcile + maker of bank changes; NOT post/reverse.
  ('finance_reviewer','finance.invoice.create'), ('finance_reviewer','finance.receipt.record'),
  ('finance_reviewer','finance.bill.create'), ('finance_reviewer','finance.reconcile'),
  ('finance_reviewer','finance.bank_details.request'),
  -- Payment roles (record vs approve): separation of duties on bank-detail changes.
  ('payment_initiator','finance.payment.record'), ('payment_initiator','finance.bank_details.request'),
  ('payment_approver','finance.bank_details.approve'),
  -- Project/division manager: operations + procurement only.
  ('project_manager','operations.task.manage'), ('project_manager','operations.task.work'),
  ('project_manager','procurement.request.create'), ('project_manager','procurement.po.approve'),
  ('project_manager','procurement.goods.receive'),
  -- Staff: work assigned tasks, raise procurement requests.
  ('staff_submitter','operations.task.work'), ('staff_submitter','procurement.request.create'),
  -- Owner/management: cross-domain management authority (legal/HR/procurement approve),
  -- but NOT accounting posting (that stays with the accountant).
  ('owner_management','legal.matter.manage'), ('owner_management','legal.contract.manage'),
  ('owner_management','hr.staff.manage'), ('owner_management','operations.task.manage'),
  ('owner_management','procurement.po.approve'), ('owner_management','finance.reconcile')
on conflict do nothing;

-- System administrator holds every permission (re-run after adding new perms above).
insert into role_permissions (role_key, permission_key)
select 'system_administrator', p.key from permissions p
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Suspension-safe access anchor.
--    Membership is authoritative once it exists: a suspended/ended member is denied
--    even if a legacy user_company_access row remains. Legacy-only users (no membership)
--    still resolve via the legacy table, so the staged cutover breaks nobody.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.has_company_access(target_company uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    -- If the user has ANY membership row in this company, membership status decides.
    when exists (
      select 1 from memberships m
      where m.user_id = auth.uid() and m.company_id = target_company
    ) then exists (
      select 1 from memberships m
      where m.user_id = auth.uid() and m.company_id = target_company and m.status = 'active'
    )
    -- Otherwise fall back to the legacy access table (pre-membership users).
    else exists (
      select 1 from user_company_access uca
      where uca.user_id = auth.uid() and uca.company_id = target_company
    )
  end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Delegation-aware capability resolution + authority ceilings.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.has_capability(target_company uuid, capability text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    -- (a) Direct: the user's own active membership roles grant the capability.
    exists (
      select 1
      from memberships m
      join membership_roles mr on mr.membership_id = m.id
      join role_permissions rp on rp.role_key = mr.role_key
      where m.user_id = auth.uid()
        and m.company_id = target_company
        and m.status = 'active'
        and rp.permission_key = capability
    )
    or
    -- (b) Delegated: an active, in-window delegation TO the user, where the DELEGATOR
    --     actually holds the capability (a delegate never exceeds the delegator) and
    --     the delegation domain covers this capability (null domain = all domains).
    exists (
      select 1
      from delegations d
      join memberships tm on tm.id = d.to_membership   and tm.user_id = auth.uid() and tm.status = 'active'
      join memberships fm on fm.id = d.from_membership and fm.status = 'active'
      join membership_roles fmr on fmr.membership_id = fm.id
      join role_permissions frp on frp.role_key = fmr.role_key
      where d.company_id = target_company
        and now() between d.starts_at and d.ends_at
        and frp.permission_key = capability
        and (
          d.domain is null
          or split_part(capability, '.', 1) = d.domain
          or capability = d.domain
          or capability like d.domain || '.%'
        )
    );
$$;

-- Effective amount ceiling (numeric; NULL = unlimited) for the current user in a domain,
-- as the LEAST of their own authority_rules and any active delegation's max_amount.
create or replace function public.authority_ceiling(target_company uuid, target_domain text)
returns numeric
language sql stable security definer set search_path = public
as $$
  select min(cap) from (
    select ar.max_amount as cap
    from memberships m
    join authority_rules ar on ar.membership_id = m.id
    where m.user_id = auth.uid() and m.company_id = target_company and m.status = 'active'
      and ar.domain = target_domain and ar.max_amount is not null
    union all
    select d.max_amount as cap
    from delegations d
    join memberships tm on tm.id = d.to_membership and tm.user_id = auth.uid() and tm.status = 'active'
    where d.company_id = target_company and now() between d.starts_at and d.ends_at
      and (d.domain = target_domain or d.domain is null) and d.max_amount is not null
  ) c;
$$;

-- True when `amount` is within the caller's authority ceiling for the domain (or none).
create or replace function public.within_authority(target_company uuid, target_domain text, amount numeric)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(amount <= public.authority_ceiling(target_company, target_domain), true);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Capability-gated write policies on sensitive tables.
--    Drops the generic company-access policies from 0034 (named <t>_w_ins/upd/del) and
--    the identity policies from 0023 (<t>_write_ins/upd/del), replacing them with
--    capability policies (<t>_cap_ins/upd/del). Company scope is still enforced (the
--    capability functions are company-scoped), so cross-company writes stay impossible.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  -- table : capability required for insert/update/delete
  pairs text[][] := array[
    -- Finance master + documents
    ['customer_invoices','finance.invoice.create'],
    ['customer_invoice_lines','finance.invoice.create'],
    ['customers','finance.invoice.create'],
    ['supplier_bills','finance.bill.create'],
    ['supplier_bill_lines','finance.bill.create'],
    ['suppliers','finance.bill.create'],
    ['reimbursements','finance.payment.record'],
    ['accounting_periods','finance.period.close'],
    ['chart_of_accounts','administer_accounts'],
    ['tax_codes','administer_accounts'],
    ['bank_accounts','finance.bank_details.request'],
    -- Procurement
    ['purchase_requests','procurement.request.create'],
    ['purchase_orders','procurement.po.approve'],
    ['goods_receipts','procurement.goods.receive'],
    ['rfqs','procurement.request.create'],
    -- Legal
    ['legal_matters','legal.matter.manage'],
    ['contracts','legal.contract.manage'],
    -- HR
    ['employees','hr.staff.manage'],
    -- Identity (tighten 0023 from administer_accounts to admin.identity.manage)
    ['organisation_units','admin.identity.manage'],
    ['memberships','admin.identity.manage'],
    ['membership_roles','admin.identity.manage'],
    ['authority_rules','admin.identity.manage'],
    ['membership_assignments','admin.identity.manage'],
    ['employee_profiles','admin.identity.manage'],
    ['delegations','admin.identity.manage']
  ];
  t text; cap text;
begin
  for i in 1 .. array_length(pairs,1) loop
    t := pairs[i][1]; cap := pairs[i][2];
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('alter table %I enable row level security', t);
    -- Remove the generic/broad policies from earlier migrations.
    execute format('drop policy if exists %I on %I', t||'_w_ins', t);
    execute format('drop policy if exists %I on %I', t||'_w_upd', t);
    execute format('drop policy if exists %I on %I', t||'_w_del', t);
    execute format('drop policy if exists %I on %I', t||'_write_ins', t);
    execute format('drop policy if exists %I on %I', t||'_write_upd', t);
    execute format('drop policy if exists %I on %I', t||'_write_del', t);
    -- Capability-gated write policies (company scope lives inside has_capability).
    execute format('drop policy if exists %I on %I', t||'_cap_ins', t);
    execute format('drop policy if exists %I on %I', t||'_cap_upd', t);
    execute format('drop policy if exists %I on %I', t||'_cap_del', t);
    execute format($f$create policy %I on %I for insert with check (public.has_capability(company_id, %L))$f$, t||'_cap_ins', t, cap);
    execute format($f$create policy %I on %I for update using (public.has_capability(company_id, %L)) with check (public.has_capability(company_id, %L))$f$, t||'_cap_upd', t, cap, cap);
    execute format($f$create policy %I on %I for delete using (public.has_capability(company_id, %L))$f$, t||'_cap_del', t, cap);
  end loop;
end $$;

-- Self-service tables: any active company member may INSERT their own row, but only a
-- capability holder may UPDATE/DELETE (approve/decide). Company scope on every clause.
do $$
declare
  pairs text[][] := array[
    ['expense_claims','finance.payment.record'],
    ['leave_requests','hr.staff.manage']
  ];
  t text; cap text;
begin
  for i in 1 .. array_length(pairs,1) loop
    t := pairs[i][1]; cap := pairs[i][2];
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_w_ins', t);
    execute format('drop policy if exists %I on %I', t||'_w_upd', t);
    execute format('drop policy if exists %I on %I', t||'_w_del', t);
    execute format('drop policy if exists %I on %I', t||'_cap_ins', t);
    execute format('drop policy if exists %I on %I', t||'_cap_upd', t);
    execute format('drop policy if exists %I on %I', t||'_cap_del', t);
    execute format($f$create policy %I on %I for insert with check (public.has_company_access(company_id))$f$, t||'_cap_ins', t);
    execute format($f$create policy %I on %I for update using (public.has_capability(company_id, %L)) with check (public.has_capability(company_id, %L))$f$, t||'_cap_upd', t, cap, cap);
    execute format($f$create policy %I on %I for delete using (public.has_capability(company_id, %L))$f$, t||'_cap_del', t, cap);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Service-only tables: NO direct authenticated writes. Drop any generic write
--    policy so RLS default-denies; writes happen only via SECURITY DEFINER RPCs
--    (which run as the function owner) or the service-role worker client.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  service_only text[] := array[
    'payments',            -- written only by settlement RPCs
    'journal_entries','journal_lines',   -- ledger: post_manual_journal / reverse only
    'message_outbox',      -- outbox worker only
    'idempotency_keys',    -- claimed inside RPCs
    'audit_events',        -- append-only
    'source_events','dead_letter_events','ai_runs','ai_recommendations',
    'clarification_requests','duplicate_candidates','policy_evaluations',
    'financial_events','financial_event_versions','financial_event_allocations',
    'management_cases','capacity_snapshots','conversation_references','document_extractions'
  ];
  t text;
begin
  foreach t in array service_only loop
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_w_ins', t);
    execute format('drop policy if exists %I on %I', t||'_w_upd', t);
    execute format('drop policy if exists %I on %I', t||'_w_del', t);
    execute format('drop policy if exists %I on %I', t||'_cap_ins', t);
    execute format('drop policy if exists %I on %I', t||'_cap_upd', t);
    execute format('drop policy if exists %I on %I', t||'_cap_del', t);
    -- Belt-and-braces: also revoke table DML from the authenticated role directly.
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke insert, update, delete on %I from authenticated', t);
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Approval workflow: capability + separation of duties enforced by RLS.
--    - A request may be raised by any capability holder (submit_for_approval),
--      and submitted_by must be the caller (no maker spoofing).
--    - An action requires the 'approve' capability, actor_user_id must be the caller,
--      and the caller must NOT be the maker of the linked request (SoD). The existing
--      UNIQUE (request, actor) already blocks the same approver acting twice.
--    - No UPDATE/DELETE policy → approval history is append-only for authenticated users.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.approval_requests') is not null then
    alter table approval_requests enable row level security;
    drop policy if exists approval_requests_w_ins on approval_requests;
    drop policy if exists approval_requests_w_upd on approval_requests;
    drop policy if exists approval_requests_w_del on approval_requests;
    drop policy if exists approval_requests_cap_ins on approval_requests;
    create policy approval_requests_cap_ins on approval_requests for insert
      with check (public.has_capability(company_id,'submit_for_approval') and submitted_by = auth.uid());
  end if;

  if to_regclass('public.approval_actions') is not null then
    alter table approval_actions enable row level security;
    drop policy if exists approval_actions_w_ins on approval_actions;
    drop policy if exists approval_actions_w_upd on approval_actions;
    drop policy if exists approval_actions_w_del on approval_actions;
    drop policy if exists approval_actions_cap_ins on approval_actions;
    create policy approval_actions_cap_ins on approval_actions for insert
      with check (
        public.has_capability(company_id,'approve')
        and actor_user_id = auth.uid()
        and not exists (
          select 1 from approval_requests r
          where r.id = approval_request_id and r.submitted_by = auth.uid()
        )
      );
  end if;
end $$;
