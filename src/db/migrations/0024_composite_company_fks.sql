-- 0024_composite_company_fks.sql
-- WP1 §6 (NEXT_PHASE_DEVELOPER_BRIEF) — enforce "a child row cannot reference a parent
-- in another company" across the remaining parent/child tables that both carry
-- company_id. Extends the composite FKs added in 0009 (quotation chains) and 0023
-- (work-task chains).
--
-- ADDITIVE, FORWARD-ONLY, IDEMPOTENT and DEFENSIVE: every pair is guarded by
-- to_regclass() + column-existence checks and wrapped so a schema variance skips that
-- one pair (raise notice) instead of aborting the migration. FKs are added NOT VALID
-- so no legacy row blocks the migration; validate later once data is confirmed clean.
--
-- Mechanism: give each PARENT a unique (id, company_id); add a composite FK on the
-- CHILD's (fk_col, company_id) → parent (id, company_id).

do $$
declare
  r record;
  parent_uq text;
  child_fk text;
begin
  for r in
    select * from (values
      -- Accounting core
      ('fiscal_years','accounting_periods','fiscal_year_id'),
      ('accounting_periods','journal_entries','period_id'),
      ('journal_entries','journal_lines','journal_id'),
      -- Subledgers
      ('customer_invoices','customer_invoice_lines','invoice_id'),
      ('supplier_bills','supplier_bill_lines','bill_id'),
      ('payments','payment_allocations','payment_id'),
      ('loans','loan_schedules','loan_id'),
      -- Procurement
      ('purchase_orders','po_lines','purchase_order_id'),
      ('purchase_orders','goods_receipts','purchase_order_id'),
      ('rfqs','supplier_quotations','rfq_id'),
      -- Legal
      ('legal_matters','contracts','legal_matter_id'),
      ('contracts','obligations','contract_id'),
      -- Fleet
      ('vehicles','trips','vehicle_id'),
      ('vehicles','fuel_logs','vehicle_id'),
      ('vehicles','maintenance_records','vehicle_id'),
      ('vehicles','vehicle_documents','vehicle_id'),
      -- Inventory / CRM / Marketing
      ('inventory_items','stock_movements','item_id'),
      ('leads','opportunities','lead_id'),
      ('audiences','campaigns','audience_id'),
      -- Identity (memberships / org units are the parents)
      ('memberships','membership_roles','membership_id'),
      ('memberships','authority_rules','membership_id'),
      ('memberships','membership_assignments','membership_id'),
      ('memberships','employee_profiles','membership_id'),
      ('memberships','capacity_snapshots','membership_id'),
      ('memberships','task_assignments','membership_id'),
      ('memberships','delegations','from_membership'),
      ('memberships','delegations','to_membership'),
      ('organisation_units','membership_assignments','org_unit_id'),
      ('organisation_units','projects','org_unit_id'),
      ('projects','tasks','project_id')
    ) as t(parent, child, fk_col)
  loop
    begin
      -- Skip if either table is absent (module not migrated) or columns missing.
      if to_regclass('public.'||r.parent) is null or to_regclass('public.'||r.child) is null then
        raise notice 'skip %/% — table absent', r.parent, r.child; continue;
      end if;
      if not exists (select 1 from information_schema.columns
                     where table_name = r.parent and column_name = 'company_id')
         or not exists (select 1 from information_schema.columns
                        where table_name = r.child and column_name = 'company_id')
         or not exists (select 1 from information_schema.columns
                        where table_name = r.child and column_name = r.fk_col) then
        raise notice 'skip %/% (% ) — company_id/fk column missing', r.parent, r.child, r.fk_col; continue;
      end if;

      -- 1. Parent needs a unique (id, company_id) to be referenced compositely.
      parent_uq := r.parent||'_id_company_uq';
      if not exists (select 1 from pg_constraint where conname = parent_uq) then
        execute format('alter table %I add constraint %I unique (id, company_id)', r.parent, parent_uq);
      end if;

      -- 2. Child composite FK (fk_col, company_id) -> parent (id, company_id), NOT VALID.
      child_fk := r.child||'_'||r.fk_col||'_company_fk';
      if not exists (select 1 from pg_constraint where conname = child_fk) then
        execute format(
          'alter table %I add constraint %I foreign key (%I, company_id) references %I (id, company_id) not valid',
          r.child, child_fk, r.fk_col, r.parent);
      end if;
    exception when others then
      raise notice 'skip %/% (%) — %', r.parent, r.child, r.fk_col, sqlerrm;
    end;
  end loop;
end $$;
