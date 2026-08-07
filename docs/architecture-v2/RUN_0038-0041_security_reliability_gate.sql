-- ============================================================================
-- RUN-ONCE COMBINED MIGRATION — Production Security & Reliability Gate
-- Migrations 0038 → 0041, concatenated from the canonical files in
-- src/db/migrations/ (generated 2026-08-07). This is a CONVENIENCE aggregate for
-- applying all four at once in the Supabase SQL editor; the canonical per-file
-- migrations remain the source of truth.
--
-- SAFE TO RUN: forward-only, additive, idempotent, and wrapped in ONE transaction
-- (all-or-nothing). It is INERT until the feature flags are turned on — with
-- RLS_READS/RLS_WRITES/WHATSAPP_ASYNC = off it makes ZERO behaviour change (the
-- service-role client bypasses RLS and the RPCs treat the service caller as the
-- trusted worker path). It also records 0038–0041 in schema_migrations so
-- `npm run migrate:status` stays consistent.
--
-- HOW TO RUN: paste this whole file into the Supabase SQL editor and Run
--   (or:  psql "$DATABASE_URL" -f RUN_0038-0041_security_reliability_gate.sql).
-- Recommended: run against a NON-PRODUCTION database first (see MIGRATION_STATE.md).
-- ============================================================================

begin;

create table if not exists schema_migrations (
  version text primary key,
  filename text not null,
  applied_at timestamptz not null default now()
);

-- ============================================================================
-- 0038_capability_authority.sql
-- ============================================================================
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


-- ============================================================================
-- 0039_accounting_rpc_hardening.sql
-- ============================================================================
-- 0039_accounting_rpc_hardening.sql
-- Production Security & Reliability Gate — Work Package B (Accounting atomicity,
-- authority & idempotency). Makes every accounting RPC safe against retries, concurrent
-- requests, partial failures and direct RPC calls:
--
--   * Reject ANONYMOUS callers (JWT role 'anon').
--   * AUTHENTICATED callers: actor is derived from auth.uid() (p_posted_by/p_by is
--     IGNORED — no actor spoofing), and the operation-specific capability is required.
--   * SERVICE/worker callers (no JWT): trusted; the explicit actor is recorded.
--   * A shared internal poster (_journal_post_internal) does the balanced-journal insert +
--     lines + fail-closed audit. Settlement/reversal call it directly, so recording a
--     receipt/payment/reversal needs its OWN capability (finance.receipt.record /
--     finance.payment.record / finance.journal.reverse) — not finance.journal.post.
--   * Settlement/reversal take a caller idempotency key: idempotency check + journal +
--     payment + source-document update + audit all commit or roll back TOGETHER, in one
--     transaction. A failed operation does NOT consume the key. A repeated key with the
--     SAME amount returns the SAME journal and re-applies NOTHING (ROW_COUNT guard); a
--     repeated key with a DIFFERENT amount is rejected as a CONFLICT. Concurrent
--     duplicates collapse to exactly one journal + one payment + one settlement.
--   * unique_violation handling is NARROWED to the idempotency case (re-query the key;
--     re-raise any unrelated unique violation).
--   * Source rows are locked FOR UPDATE (kept from 0037) so partial settlements cannot
--     exceed the outstanding balance and a double-reverse is serialised.
--
-- These functions RECORD authorised accounting events; they never move money.
-- Preserves the (live-verified) validation logic exactly. FORWARD-ONLY, IDEMPOTENT.

-- Audit needs an idempotency column so a financial audit row can carry its key.
alter table audit_events add column if not exists idempotency_key text;

-- ─────────────────────────────────────────────────────────────────────────────
-- Caller role helper: the JWT role, or NULL when there is no JWT (trusted server).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.caller_jwt_role()
returns text language sql stable set search_path = public as $$
  select nullif(current_setting('request.jwt.claims', true), '')::json->>'role';
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Internal poster — NO caller-capability check (the calling function already gated).
-- Validates + totals BEFORE the idempotency compare, so a reused key with a changed
-- amount is a conflict. SECURITY DEFINER, fixed search_path. NOT granted to
-- authenticated: only the definer functions (run as owner) and service_role may call it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public._journal_post_internal(
  p_company uuid,
  p_date date,
  p_currency text,
  p_memo text,
  p_actor uuid,
  p_lines jsonb,
  p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_line jsonb;
  v_journal_id uuid;
  v_existing uuid;
  v_existing_total numeric;
  v_period_id uuid;
  v_period_status text;
  v_line_no int := 0;
  v_debit numeric;
  v_credit numeric;
  v_code text;
begin
  if p_lines is null or jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal needs at least two lines';
  end if;

  select id, status into v_period_id, v_period_status
  from accounting_periods
  where company_id = p_company and p_date between start_date and end_date
  order by start_date desc
  limit 1;
  if v_period_status is not null and v_period_status in ('closed', 'locked') then
    raise exception 'Accounting period is % for %', v_period_status, p_date;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_code := v_line->>'account_code';
    v_debit := round(coalesce((v_line->>'debit')::numeric, 0), 2);
    v_credit := round(coalesce((v_line->>'credit')::numeric, 0), 2);
    if v_debit < 0 or v_credit < 0 then raise exception 'Line has a negative amount'; end if;
    if v_debit > 0 and v_credit > 0 then raise exception 'Line % has both a debit and a credit', v_code; end if;
    if not exists (select 1 from chart_of_accounts where company_id = p_company and code = v_code and is_active) then
      raise exception 'Account % not found or inactive in this company', v_code;
    end if;
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
  end loop;

  if round(v_total_debit, 2) <> round(v_total_credit, 2) then
    raise exception 'Journal is unbalanced: debit % <> credit %', v_total_debit, v_total_credit;
  end if;
  if round(v_total_debit, 2) = 0 then raise exception 'A zero-value journal is not allowed'; end if;

  -- Deterministic idempotency: a repeated key with the SAME total returns the original;
  -- a repeated key with a DIFFERENT total is a conflict.
  if p_idempotency_key is not null then
    select id, total_debit into v_existing, v_existing_total
    from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key;
    if v_existing is not null then
      if round(v_existing_total, 2) <> round(v_total_debit, 2) then
        raise exception 'idempotency key reused with a different amount (conflict)';
      end if;
      return v_existing;
    end if;
  end if;

  begin
    insert into journal_entries (
      company_id, period_id, posting_date, currency, exchange_rate, memo, status,
      correlation_id, idempotency_key, total_debit, total_credit, posted_at, posted_by, created_by
    ) values (
      p_company, v_period_id, p_date, p_currency, 1, p_memo, 'posted',
      'corr_' || gen_random_uuid(), coalesce(p_idempotency_key, 'jm_' || gen_random_uuid()),
      round(v_total_debit, 2), round(v_total_credit, 2), now(), p_actor, p_actor
    ) returning id into v_journal_id;
  exception when unique_violation then
    -- NARROWED: only idempotent if the key row now exists AND its total matches; any
    -- unrelated unique violation propagates.
    if p_idempotency_key is not null then
      select id, total_debit into v_journal_id, v_existing_total
      from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key;
      if v_journal_id is not null then
        if round(v_existing_total, 2) <> round(v_total_debit, 2) then
          raise exception 'idempotency key reused with a different amount (conflict)';
        end if;
        return v_journal_id;
      end if;
    end if;
    raise;
  end;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_line_no := v_line_no + 1;
    insert into journal_lines (journal_id, company_id, account_code, debit, credit, description, line_no)
    values (
      v_journal_id, p_company, v_line->>'account_code',
      round(coalesce((v_line->>'debit')::numeric, 0), 2),
      round(coalesce((v_line->>'credit')::numeric, 0), 2),
      v_line->>'description', v_line_no
    );
  end loop;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, 'user', p_actor, 'journal.posted', 'journal', v_journal_id,
          jsonb_build_object('total', round(v_total_debit, 2), 'memo', p_memo), p_idempotency_key);

  return v_journal_id;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Public: post a manual journal. Requires finance.journal.post for authenticated users.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.post_manual_journal(
  p_company uuid, p_date date, p_currency text, p_memo text, p_posted_by uuid,
  p_lines jsonb, p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_actor uuid;
begin
  if public.caller_jwt_role() = 'anon' then raise exception 'anonymous callers cannot post journals'; end if;
  if auth.uid() is not null then
    if not public.has_capability(p_company, 'finance.journal.post') then
      raise exception 'missing capability finance.journal.post';
    end if;
    v_actor := auth.uid();
  else
    v_actor := p_posted_by;
  end if;
  return public._journal_post_internal(p_company, p_date, p_currency, p_memo, v_actor, p_lines, p_idempotency_key);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Customer receipt. Requires finance.receipt.record. Fully idempotent on the key.
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists public.settle_customer_invoice(uuid,uuid,numeric,text,text,uuid,date);
create or replace function public.settle_customer_invoice(
  p_company uuid, p_invoice uuid, p_amount numeric, p_cash_code text, p_ar_code text, p_by uuid, p_date date,
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_currency text; v_total numeric; v_settled numeric; v_customer uuid; v_number text;
  v_journal uuid; v_lines jsonb; v_new_settled numeric; v_status text; v_actor uuid; v_idem text; v_ins int;
begin
  if public.caller_jwt_role() = 'anon' then raise exception 'anonymous callers cannot record receipts'; end if;
  if auth.uid() is not null then
    if not public.has_capability(p_company, 'finance.receipt.record') then raise exception 'missing capability finance.receipt.record'; end if;
    v_actor := auth.uid();
  else
    v_actor := p_by;
  end if;

  select currency, total_amount, coalesce(amount_settled, 0), customer_id, invoice_number
    into v_currency, v_total, v_settled, v_customer, v_number
  from customer_invoices where id = p_invoice and company_id = p_company
  for update;                                            -- lock the source row
  if v_currency is null then raise exception 'Invoice not found'; end if;
  if p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if round(p_amount, 2) > round(v_total - v_settled, 2) then raise exception 'Amount exceeds outstanding %', (v_total - v_settled); end if;

  v_idem := coalesce(p_idempotency_key, 'settle_ci:' || p_invoice || ':' || round(p_amount,2) || ':' || p_date);
  v_lines := jsonb_build_array(
    jsonb_build_object('account_code', p_cash_code, 'debit', p_amount, 'credit', 0, 'description', 'Receipt ' || v_number),
    jsonb_build_object('account_code', p_ar_code, 'debit', 0, 'credit', p_amount, 'description', 'Receipt ' || v_number)
  );
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Receipt for ' || v_number, v_actor, v_lines, v_idem);

  -- Payment carries the key (payments UNIQUE(company_id, idempotency_key)). If nothing
  -- was inserted, this is a retry of an already-recorded receipt → re-apply NOTHING.
  insert into payments (company_id, direction, party_type, party_id, currency, amount, method, payment_date, journal_id, status, idempotency_key)
  values (p_company, 'in', 'customer', v_customer, v_currency, round(p_amount, 2), 'record', p_date, v_journal, 'recorded', v_idem)
  on conflict (company_id, idempotency_key) do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then return v_journal; end if;   -- idempotent retry: invoice already settled by this key

  v_new_settled := v_settled + round(p_amount, 2);
  v_status := case when round(v_new_settled, 2) >= round(v_total, 2) then 'paid' else 'part_paid' end;
  update customer_invoices set amount_settled = v_new_settled, status = v_status where id = p_invoice and company_id = p_company;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, 'user', v_actor, 'customer_invoice.receipt_recorded', 'customer_invoice', p_invoice,
          jsonb_build_object('amount', round(p_amount,2), 'journal_id', v_journal), v_idem);
  return v_journal;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Supplier payment. Requires finance.payment.record + amount within authority ceiling.
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists public.settle_supplier_bill(uuid,uuid,numeric,text,text,uuid,date);
create or replace function public.settle_supplier_bill(
  p_company uuid, p_bill uuid, p_amount numeric, p_ap_code text, p_cash_code text, p_by uuid, p_date date,
  p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_currency text; v_total numeric; v_settled numeric; v_supplier uuid; v_number text;
  v_journal uuid; v_lines jsonb; v_new_settled numeric; v_status text; v_actor uuid; v_idem text; v_ins int;
begin
  if public.caller_jwt_role() = 'anon' then raise exception 'anonymous callers cannot record payments'; end if;
  if auth.uid() is not null then
    if not public.has_capability(p_company, 'finance.payment.record') then raise exception 'missing capability finance.payment.record'; end if;
    if not public.within_authority(p_company, 'payment', round(p_amount,2)) then raise exception 'amount exceeds your payment authority ceiling'; end if;
    v_actor := auth.uid();
  else
    v_actor := p_by;
  end if;

  select currency, total_amount, coalesce(amount_settled, 0), supplier_id, bill_number
    into v_currency, v_total, v_settled, v_supplier, v_number
  from supplier_bills where id = p_bill and company_id = p_company
  for update;
  if v_currency is null then raise exception 'Bill not found'; end if;
  if p_amount <= 0 then raise exception 'Amount must be positive'; end if;
  if round(p_amount, 2) > round(v_total - v_settled, 2) then raise exception 'Amount exceeds outstanding %', (v_total - v_settled); end if;

  v_idem := coalesce(p_idempotency_key, 'settle_sb:' || p_bill || ':' || round(p_amount,2) || ':' || p_date);
  v_lines := jsonb_build_array(
    jsonb_build_object('account_code', p_ap_code, 'debit', p_amount, 'credit', 0, 'description', 'Payment ' || v_number),
    jsonb_build_object('account_code', p_cash_code, 'debit', 0, 'credit', p_amount, 'description', 'Payment ' || v_number)
  );
  v_journal := public._journal_post_internal(p_company, p_date, v_currency, 'Payment for ' || v_number, v_actor, v_lines, v_idem);

  insert into payments (company_id, direction, party_type, party_id, currency, amount, method, payment_date, journal_id, status, idempotency_key)
  values (p_company, 'out', 'supplier', v_supplier, v_currency, round(p_amount, 2), 'record', p_date, v_journal, 'recorded', v_idem)
  on conflict (company_id, idempotency_key) do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then return v_journal; end if;

  v_new_settled := v_settled + round(p_amount, 2);
  v_status := case when round(v_new_settled, 2) >= round(v_total, 2) then 'paid' else 'part_paid' end;
  update supplier_bills set amount_settled = v_new_settled, status = v_status where id = p_bill and company_id = p_company;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, 'user', v_actor, 'supplier_bill.payment_recorded', 'supplier_bill', p_bill,
          jsonb_build_object('amount', round(p_amount,2), 'journal_id', v_journal), v_idem);
  return v_journal;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Reversal. Requires finance.journal.reverse. Idempotent + serialised double-reverse.
-- ─────────────────────────────────────────────────────────────────────────────
drop function if exists public.reverse_journal(uuid,uuid,uuid,date);
create or replace function public.reverse_journal(
  p_company uuid, p_journal uuid, p_by uuid, p_date date, p_idempotency_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_currency text; v_status text; v_lines jsonb; v_rev uuid; v_actor uuid; v_idem text;
begin
  if public.caller_jwt_role() = 'anon' then raise exception 'anonymous callers cannot reverse journals'; end if;
  if auth.uid() is not null then
    if not public.has_capability(p_company, 'finance.journal.reverse') then raise exception 'missing capability finance.journal.reverse'; end if;
    v_actor := auth.uid();
  else
    v_actor := p_by;
  end if;

  select currency, status into v_currency, v_status from journal_entries where id = p_journal and company_id = p_company
  for update;                                            -- lock so a double-reverse serialises
  if v_currency is null then raise exception 'Journal not found'; end if;

  v_idem := coalesce(p_idempotency_key, 'reverse:' || p_journal);
  if v_status = 'reversed' then
    -- Idempotent retry OR concurrent double-reverse: return the reversal made by this key.
    select id into v_rev from journal_entries where company_id = p_company and idempotency_key = v_idem;
    if v_rev is not null then return v_rev; end if;
    raise exception 'Journal already reversed';
  elsif v_status <> 'posted' then
    raise exception 'Only a posted journal can be reversed (is %)', v_status;
  end if;

  select jsonb_agg(jsonb_build_object('account_code', account_code, 'debit', credit, 'credit', debit, 'description', 'Reversal'))
    into v_lines from journal_lines where journal_id = p_journal and company_id = p_company;
  if v_lines is null then raise exception 'Journal has no lines'; end if;

  v_rev := public._journal_post_internal(p_company, p_date, v_currency, 'Reversal of journal ' || p_journal, v_actor, v_lines, v_idem);
  update journal_entries set status = 'reversed' where id = p_journal and company_id = p_company;
  update journal_entries set reversal_of_journal_id = p_journal where id = v_rev and company_id = p_company;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, 'user', v_actor, 'journal.reversed', 'journal', p_journal,
          jsonb_build_object('reversal_journal_id', v_rev), v_idem);
  return v_rev;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants: internal poster is NOT for authenticated. Public RPCs are.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public._journal_post_internal(uuid,date,text,text,uuid,jsonb,text) from public;
    revoke all on function public.post_manual_journal(uuid,date,text,text,uuid,jsonb,text) from public;
    revoke all on function public.settle_customer_invoice(uuid,uuid,numeric,text,text,uuid,date,text) from public;
    revoke all on function public.settle_supplier_bill(uuid,uuid,numeric,text,text,uuid,date,text) from public;
    revoke all on function public.reverse_journal(uuid,uuid,uuid,date,text) from public;

    grant execute on function public._journal_post_internal(uuid,date,text,text,uuid,jsonb,text) to service_role;
    grant execute on function public.post_manual_journal(uuid,date,text,text,uuid,jsonb,text) to authenticated, service_role;
    grant execute on function public.settle_customer_invoice(uuid,uuid,numeric,text,text,uuid,date,text) to authenticated, service_role;
    grant execute on function public.settle_supplier_bill(uuid,uuid,numeric,text,text,uuid,date,text) to authenticated, service_role;
    grant execute on function public.reverse_journal(uuid,uuid,uuid,date,text) to authenticated, service_role;
  end if;
end $$;


-- ============================================================================
-- 0040_durable_messaging.sql
-- ============================================================================
-- 0040_durable_messaging.sql
-- Production Security & Reliability Gate — Work Package C (Durable WhatsApp & outbox).
--
--   1. message_outbox gains a LEASE so two workers can never send the same row:
--      status 'processing', locked_at, lock_owner, lease_expires_at, dead_at.
--   2. claim_outbox_batch(): atomically claims a batch with FOR UPDATE SKIP LOCKED,
--      moves rows to 'processing' under a lease, and RECOVERS rows whose lease expired
--      (a crashed worker). Only service_role may call it.
--   3. wa_messages resume-safety: a `handled_at` marker so a crash BETWEEN logging the
--      inbound message and sending the reply is RESUMED (re-processed), not dropped as a
--      duplicate. A guarded partial unique index prevents duplicate inbound rows going
--      forward (skipped if the live table already has duplicates, so it can't break).
--
-- ADDITIVE, FORWARD-ONLY, IDEMPOTENT.

-- ── 1. Outbox lease columns + 'processing' status ────────────────────────────
alter table message_outbox add column if not exists locked_at timestamptz;
alter table message_outbox add column if not exists lock_owner text;
alter table message_outbox add column if not exists lease_expires_at timestamptz;
alter table message_outbox add column if not exists dead_at timestamptz;

alter table message_outbox drop constraint if exists message_outbox_status_check;
alter table message_outbox add constraint message_outbox_status_check
  check (status in ('pending','processing','sent','failed','dead'));

create index if not exists message_outbox_claim_idx
  on message_outbox (status, next_retry_at, created_at);

-- ── 2. Atomic claim with lease + expired-lease recovery ──────────────────────
create or replace function public.claim_outbox_batch(
  p_limit int, p_owner text, p_lease_seconds int default 120
) returns setof message_outbox
language plpgsql security definer set search_path = public as $$
begin
  return query
  update message_outbox m
     set status = 'processing',
         locked_at = now(),
         lock_owner = p_owner,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where m.id in (
     select id from message_outbox c
      where (
        c.status = 'pending'
        or (c.status = 'failed' and (c.next_retry_at is null or c.next_retry_at <= now()))
        -- Recover a row abandoned by a crashed worker (lease expired).
        or (c.status = 'processing' and c.lease_expires_at is not null and c.lease_expires_at <= now())
      )
      order by c.created_at
      for update skip locked
      limit p_limit
   )
   returning m.*;
end $$;

-- ── 3. wa_messages resume-safety ─────────────────────────────────────────────
alter table wa_messages add column if not exists handled_at timestamptz;

do $$
begin
  -- Only add the uniqueness guard if the live data has no existing duplicates.
  if not exists (
    select 1 from (
      select company_id, wa_message_id
      from wa_messages
      where direction = 'inbound' and wa_message_id is not null
      group by company_id, wa_message_id having count(*) > 1
    ) d
  ) then
    create unique index if not exists wa_messages_inbound_uq
      on wa_messages (company_id, wa_message_id)
      where direction = 'inbound' and wa_message_id is not null;
  end if;
end $$;

-- ── Grants: the claim function is a service-role/worker path only ─────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.claim_outbox_batch(int,text,int) from public;
    grant execute on function public.claim_outbox_batch(int,text,int) to service_role;
  end if;
end $$;


-- ============================================================================
-- 0041_ledger_integrity_report.sql
-- ============================================================================
-- 0041_ledger_integrity_report.sql
-- Production Security & Reliability Gate — Work Package E (observability). A read-only
-- integrity probe for the health surface: it detects ledger imbalance, header/line
-- mismatches, orphaned journal lines and postings that landed in a locked/closed period.
-- It reports — it changes nothing. Service-role only (the health endpoint runs as the
-- service role and may span companies). FORWARD-ONLY, IDEMPOTENT.

create or replace function public.ledger_integrity_report(p_company uuid default null)
returns table(
  imbalanced_journals bigint,
  header_line_mismatch bigint,
  orphaned_lines bigint,
  locked_period_postings bigint
)
language sql stable security definer set search_path = public as $$
  with line_sums as (
    select jl.journal_id, jl.company_id, sum(jl.debit) as d, sum(jl.credit) as c
    from journal_lines jl
    where p_company is null or jl.company_id = p_company
    group by jl.journal_id, jl.company_id
  )
  select
    -- lines within a journal do not balance
    (select count(*) from line_sums where round(d, 2) <> round(c, 2)),
    -- header totals disagree with the sum of the lines
    (select count(*) from journal_entries je
       join line_sums ls on ls.journal_id = je.id
       where (p_company is null or je.company_id = p_company)
         and (round(je.total_debit, 2) <> round(ls.d, 2) or round(je.total_credit, 2) <> round(ls.c, 2))),
    -- a line whose journal is missing or belongs to another company
    (select count(*) from journal_lines jl
       left join journal_entries je on je.id = jl.journal_id
       where (p_company is null or jl.company_id = p_company)
         and (je.id is null or je.company_id <> jl.company_id)),
    -- a posted journal sitting inside a closed/locked period
    (select count(*) from journal_entries je
       join accounting_periods ap
         on ap.company_id = je.company_id and je.posting_date between ap.start_date and ap.end_date
       where (p_company is null or je.company_id = p_company)
         and je.status = 'posted' and ap.status in ('closed', 'locked'));
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.ledger_integrity_report(uuid) from public;
    grant execute on function public.ledger_integrity_report(uuid) to service_role;
  end if;
end $$;


-- Record these four as applied (matches scripts/migrate.mjs bookkeeping).
insert into schema_migrations (version, filename) values
  ('0038','0038_capability_authority.sql'),
  ('0039','0039_accounting_rpc_hardening.sql'),
  ('0040','0040_durable_messaging.sql'),
  ('0041','0041_ledger_integrity_report.sql')
on conflict (version) do nothing;

commit;
