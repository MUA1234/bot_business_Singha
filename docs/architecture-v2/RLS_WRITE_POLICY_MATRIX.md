# RLS write-policy matrix — WP8

> Every `public` table with a `company_id` is classified below. The machine-readable source
> is `security/rls-classification.json`; `tests/integration/rls-matrix-coverage.test.ts`
> fails if a new company-scoped table is left unclassified, so nothing ships on generic
> company-member write by omission. All writes are additionally company-scoped (the
> capability functions are company-scoped), so cross-company writes remain impossible.

## Classes

| Class | Write authority | Enforced by |
|---|---|---|
| **service_only** | No authenticated writes at all — written only by SECURITY DEFINER RPCs (run as owner) or the service-role worker. | RLS default-deny + `REVOKE … FROM authenticated` (0038/0042) |
| **rpc_only** | Written only via a maker-checker / decision RPC. | RLS default-deny + REVOKE (0045/0046) |
| **append_only** | Insert only (by a capability holder), never update/delete. | insert policy only (0038/0046) |
| **self_service** | A member inserts a row **for themselves**; a capability holder updates/decides. | insert bound to `auth.uid()` + capability upd/del (0042) |
| **capability** | Operation-specific capability for insert/update/delete. | `has_capability(company_id, <cap>)` (0038/0042/0047) |
| **identity** | `admin.identity.manage` only. | 0038 |
| **company_member** | Any active company member may write — deliberate for lower-sensitivity operational/CRM data. | `has_company_access(company_id)` (0034) |

## Capability mapping (sensitive tables)

| Domain | Tables | Capability |
|---|---|---|
| Finance — documents | customer_invoices(+lines), customers | `finance.invoice.create` (post via RPC `finance.invoice.post`) |
| | supplier_bills(+lines), suppliers | `finance.bill.create` (post via `finance.bill.post`) |
| | receipts, credit_notes, refunds, employee_advances, reimbursements | `finance.receipt.record` / `finance.payment.record` |
| Finance — GL config | chart_of_accounts, tax_codes, cash_accounts, exchange_rates, fiscal_years, accounting_periods | `administer_accounts` / `finance.period.close` |
| Finance — bank/recon/planning | bank_accounts, bank_transactions, bank_imports, reconciliation_*, cash_counts, commitments, obligations, recurring_obligations, budgets(+lines), forecasts(+lines/scenarios) | `finance.bank_details.request` / `finance.reconcile` |
| Procurement | purchase_requests, purchase_orders, po_lines, goods_receipts, rfqs, supplier_quotations | `procurement.request.create` / `procurement.po.approve` / `procurement.goods.receive` |
| Inventory | inventory_items, stock_movements | `procurement.goods.receive` |
| Fleet | drivers, fuel_logs, maintenance_records, licences | `operations.fleet.manage` |
| Legal | legal_matters, contracts | `legal.matter.manage` / `legal.contract.manage` |
| HR / identity | employees, profiles, memberships & identity tables | `hr.staff.manage` / `admin.identity.manage` |
| Self-service | expense_claims, leave_requests | member inserts own; `finance.payment.record` / `hr.staff.manage` to decide |

## RPC-only / maker-checker

- `supplier_bank_detail_changes` — `request_supplier_bank_change` + `decide_supplier_bank_change` (0045).
- `approval_actions` — `decide_approval` (0046); `approval_requests` is append-only (maker submits).
- Ledger (`journal_entries`/`journal_lines`), `payments`, `payment_allocations` — accounting RPCs only.

## company_member (deliberate, lower sensitivity)

leads, opportunities, orders, quotations(+items), price_confirmations, product_catalog, campaigns,
audiences, objectives, notifications, documents, approval_policies, and the org hierarchy
(divisions, branches, departments, sites, projects, cost_centres). These carry no direct
financial authority; company-scoped write is the intended rule and is reviewed here.

## Notes / limits

- Division/project **scope** on authority is enforced where the schema carries it; `financial_events`
  do not yet carry division/project, so approval-authority scope is currently amount + currency +
  domain (documented in `SINGHA_...BRIEF` follow-up).
- `RLS_WRITES` is still **off** by default; these policies are the backstop that becomes the
  live gate at the staged cutover (`RLS_CUTOVER_PLAN.md`).
