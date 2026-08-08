-- 0047_rls_write_matrix.sql
-- Correction phase — WP8. Replace the remaining broad company-member write policies on
-- SENSITIVE tables (finance/bank/reconciliation/planning/commitments/inventory/fleet/
-- identity) with operation-specific capability policies. Lower-sensitivity operational/CRM
-- tables intentionally keep company-scoped write (documented in RLS_WRITE_POLICY_MATRIX.md
-- and enforced-complete by tests/integration/rls-matrix-coverage.test.ts).
-- FORWARD-ONLY, IDEMPOTENT.

-- New capability for fleet records (vehicles/drivers/fuel/maintenance/licences).
insert into permissions (key, label) values ('operations.fleet.manage','Operations: manage fleet records') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('project_manager','operations.fleet.manage'), ('owner_management','operations.fleet.manage')
on conflict do nothing;
insert into role_permissions (role_key, permission_key) select 'system_administrator','operations.fleet.manage' on conflict do nothing;

do $$
declare
  pairs text[][] := array[
    -- Finance GL config
    ['cash_accounts','administer_accounts'], ['exchange_rates','administer_accounts'], ['fiscal_years','administer_accounts'],
    -- Bank / reconciliation
    ['bank_transactions','finance.reconcile'], ['bank_imports','finance.reconcile'],
    ['reconciliation_sessions','finance.reconcile'], ['reconciliation_matches','finance.reconcile'],
    ['cash_counts','finance.reconcile'],
    -- Commitments / recurring obligations / planning
    ['commitments','finance.reconcile'], ['obligations','finance.reconcile'], ['recurring_obligations','finance.reconcile'],
    ['budgets','finance.reconcile'], ['budget_lines','finance.reconcile'],
    ['forecasts','finance.reconcile'], ['forecast_lines','finance.reconcile'], ['forecast_scenarios','finance.reconcile'],
    -- Inventory
    ['inventory_items','procurement.goods.receive'], ['stock_movements','procurement.goods.receive'],
    -- Procurement detail
    ['po_lines','procurement.po.approve'], ['supplier_quotations','procurement.request.create'],
    -- Fleet
    ['drivers','operations.fleet.manage'], ['fuel_logs','operations.fleet.manage'],
    ['maintenance_records','operations.fleet.manage'], ['licences','operations.fleet.manage'],
    ['vehicles','operations.fleet.manage'], ['vehicle_documents','operations.fleet.manage'], ['trips','operations.fleet.manage'],
    -- Task workflow detail (tasks itself is gated in 0023)
    ['task_assignments','operations.task.work'], ['task_dependencies','operations.task.work'],
    ['task_check_ins','operations.task.work'], ['task_evidence','operations.task.work'],
    -- Identity-sensitive legacy tables
    ['profiles','admin.identity.manage'], ['user_company_access','admin.identity.manage']
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
    execute format($f$create policy %I on %I for insert with check (public.has_capability(company_id, %L))$f$, t||'_cap_ins', t, cap);
    execute format($f$create policy %I on %I for update using (public.has_capability(company_id, %L)) with check (public.has_capability(company_id, %L))$f$, t||'_cap_upd', t, cap, cap);
    execute format($f$create policy %I on %I for delete using (public.has_capability(company_id, %L))$f$, t||'_cap_del', t, cap);
  end loop;
end $$;
