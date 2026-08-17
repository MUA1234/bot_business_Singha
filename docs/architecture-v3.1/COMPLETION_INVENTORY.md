# Completion Inventory (machine-generated — do not hand-edit)

> Regenerate with `node scripts/completion-inventory.mjs`. Deterministic: changes only when code changes.
> Suspect lists are HEURISTIC work lists (each entry needs triage), not verdicts.

## 1. supabaseAdmin() usage — 38 file(s)

| file | refs |
|---|---|
| src/app/api/cron/ai-monitor/route.ts | 2 |
| src/app/api/cron/daily-digest/route.ts | 2 |
| src/app/api/cron/follow-ups/route.ts | 2 |
| src/app/api/cron/outbox/route.ts | 2 |
| src/app/api/exports/[kind]/route.ts | 2 |
| src/app/api/health/route.ts | 2 |
| src/app/api/webhooks/whatsapp/route.ts | 2 |
| src/app/app/_actions/price.ts | 2 |
| src/app/app/admin/audit/page.tsx | 2 |
| src/app/app/admin/catalog/page.tsx | 2 |
| src/app/app/admin/departments/page.tsx | 2 |
| src/app/app/admin/employees/actions.ts | 6 |
| src/app/app/admin/employees/page.tsx | 2 |
| src/app/app/admin/health/page.tsx | 2 |
| src/app/app/admin/objectives/page.tsx | 2 |
| src/app/app/admin/outbox/actions.ts | 2 |
| src/app/app/admin/outbox/page.tsx | 2 |
| src/app/app/admin/page.tsx | 2 |
| src/app/app/command/analyze/actions.ts | 3 |
| src/app/app/hr/capacity/actions.ts | 2 |
| src/app/app/hr/capacity/page.tsx | 2 |
| src/app/app/hr/page.tsx | 2 |
| src/app/app/hr/staff/[id]/page.tsx | 2 |
| src/app/app/hr/staff/page.tsx | 2 |
| src/app/app/messages/[id]/actions.ts | 2 |
| src/app/app/operations/tasks/actions.ts | 15 |
| src/app/login/actions.ts | 2 |
| src/components/PriceRequests.tsx | 3 |
| src/inngest/functions.ts | 2 |
| src/lib/audit.ts | 2 |
| src/lib/auth.ts | 3 |
| src/lib/documents.ts | 3 |
| src/lib/ledger-report.ts | 2 |
| src/lib/notify.ts | 2 |
| src/lib/order-intake.ts | 2 |
| src/lib/outbox-enqueue.ts | 2 |
| src/lib/quotations.ts | 6 |
| src/lib/task-access.ts | 4 |

Allowlist: none yet — Phase 2 introduces it; until then --check does not fail on this category

## 2. money-as-Number suspects — 67 line(s) (Phase-1A triage list)

| file:line | code |
|---|---|
| src/app/api/health/route.ts:76 | `imbalancedJournals: Number(row.imbalanced_journals ?? 0),` |
| src/app/app/admin/catalog/actions.ts:28 | `const unit_price = priceRaw === "" ? null : Number(priceRaw);` |
| src/app/app/admin/catalog/page.tsx:59 | `<td>{r.unit_price == null ? <span className="badge warn">Varies</span> : `${r.currency} ${Number(r.u` |
| src/app/app/admin/health/page.tsx:39 | `const aiCost = aiRuns.reduce((s: number, r: any) => s + Number(r.cost_usd ?? 0), 0);` |
| src/app/app/finance/accounts/page.tsx:41 | `<td className="num">{Number(r.opening_balance ?? 0).toLocaleString()}</td>` |
| src/app/app/finance/approvals/page.tsx:98 | `<td className="num">{ev?.amount != null ? `${ev.currency ?? ""} ${Number(ev.amount).toLocaleString()` |
| src/app/app/finance/approvals/page.tsx:141 | `<td>{r.resolved_price != null ? `${r.currency} ${Number(r.resolved_price).toLocaleString()}` : "—"}<` |
| src/app/app/finance/cash-counts/page.tsx:63 | `<td className="num">{c.cash_accounts?.currency} {Number(c.counted_amount).toLocaleString()}</td>` |
| src/app/app/finance/commitments/page.tsx:54 | `<td className="num">{c.currency} {Number(c.amount).toLocaleString()}</td>` |
| src/app/app/finance/commitments/page.tsx:80 | `<tr key={r.id}><td>{r.description}</td><td><span className="badge">{r.cadence}</span></td><td classN` |
| src/app/app/finance/customer-invoices/[id]/page.tsx:42 | `<p className="muted mt-1">{(inv as any).customers?.name ?? "Customer"} · <span className="badge">{in` |
| src/app/app/finance/customer-invoices/[id]/page.tsx:54 | `<tr key={i}><td>{l.description}</td><td className="num">{Number(l.quantity)}</td><td className="num"` |
| src/app/app/finance/customer-invoices/[id]/page.tsx:80 | `<button className="btn" type="submit">Post {inv.currency} {Number(inv.total_amount ?? 0).toLocaleStr` |
| src/app/app/finance/customer-invoices/page.tsx:61 | `<td className="num">{r.currency} {Number(r.total_amount ?? 0).toLocaleString()}</td>` |
| src/app/app/finance/expenses/page.tsx:47 | `<td className="num">{c.currency} {Number(c.amount).toLocaleString()}</td>` |
| src/app/app/finance/forecast/page.tsx:53 | `const outstanding = (r: any) => String(Number(r.total_amount ?? 0) - Number(r.amount_settled ?? 0));` |
| src/app/app/finance/forecast/page.tsx:54 | `const inflows: CashFlowItem[] = invoices.filter((r) => Number(outstanding(r)) > 0).map((r) => ({ dat` |
| src/app/app/finance/forecast/page.tsx:58 | `...bills.filter((r) => Number(outstanding(r)) > 0).map((r) => ({ date: r.due_date ?? today(), amount` |
| src/app/app/finance/forecast/page.tsx:60 | `...commitments.filter((c) => Number(c.amount ?? 0) > 0).map((c): CashFlowItem => ({ date: c.expected` |
| src/app/app/finance/forecast/page.tsx:88 | `<div className="card stat"><div className="k">Lowest point</div><div className="v" style={{ fontSize` |
| src/app/app/finance/invoices/page.tsx:41 | `<td>{q.currency} {Number(q.total).toLocaleString()}</td>` |
| src/app/app/finance/journals/[id]/page.tsx:67 | `<td className="num" style={{ fontWeight: 700 }}>{j.currency} {Number(j.total_debit ?? 0).toLocaleStr` |
| src/app/app/finance/journals/[id]/page.tsx:68 | `<td className="num" style={{ fontWeight: 700 }}>{j.currency} {Number(j.total_credit ?? 0).toLocaleSt` |
| src/app/app/finance/journals/new/JournalForm.tsx:74 | `Debit <b>{currency} {Number(check.totalDebit).toLocaleString()}</b> · Credit <b>{currency} {Number(c` |
| src/app/app/finance/journals/page.tsx:54 | `<td className="num">{r.currency} {Number(r.total_debit ?? 0).toLocaleString()}</td>` |
| src/app/app/finance/journals/page.tsx:55 | `<td className="num">{r.currency} {Number(r.total_credit ?? 0).toLocaleString()}</td>` |
| src/app/app/finance/page.tsx:43 | `const quotedValue = (sent ?? []).reduce((s: number, q: any) => s + Number(q.total \|\| 0), 0);` |
| src/app/app/finance/page.tsx:49 | `outstanding: String(Number(r.total_amount ?? 0) - Number(r.amount_settled ?? 0)),` |
| src/app/app/finance/page.tsx:79 | `<div className="v" style={{ fontSize: "1.5rem", color: "var(--ok)" }}>{currency} {Number(ar.total).t` |
| src/app/app/finance/page.tsx:84 | `<div className="v" style={{ fontSize: "1.5rem", color: "var(--warn)" }}>{currency} {Number(ap.total)` |
| src/app/app/finance/receivables/page.tsx:44 | `const outstanding = Number(r.total_amount ?? 0) - Number(r.amount_settled ?? 0);` |
| src/app/app/finance/reconciliation/page.tsx:92 | `<td className="num">{t.currency} {Number(t.amount).toLocaleString()}</td>` |
| src/app/app/finance/reconciliation/page.tsx:101 | `<input type="hidden" name="amount" value={Math.abs(Number(t.amount))} />` |
| src/app/app/finance/supplier-bills/[id]/page.tsx:43 | `<p className="muted mt-1">{(bill as any).suppliers?.name ?? "Supplier"} · <span className="badge">{b` |
| src/app/app/finance/supplier-bills/[id]/page.tsx:55 | `<tr key={i}><td>{l.description}</td><td className="num">{Number(l.quantity)}</td><td className="num"` |
| src/app/app/finance/supplier-bills/[id]/page.tsx:81 | `<button className="btn" type="submit">Post {bill.currency} {Number(bill.total_amount ?? 0).toLocaleS` |
| src/app/app/finance/supplier-bills/page.tsx:61 | `<td className="num">{r.currency} {Number(r.total_amount ?? 0).toLocaleString()}</td>` |
| src/app/app/finance/tax-codes/page.tsx:49 | `<td className="num dim">{Number(taxAmount("1000", Number(r.rate), "LKR")).toLocaleString()}</td>` |
| src/app/app/fleet/vehicles/[id]/page.tsx:82 | `<span>{Number(f.litres ?? 0)} L @ {Number(f.odometer ?? 0)} km</span><span className="dim">{Number(f` |
| src/app/app/fleet/vehicles/actions.ts:59 | `const cost = Number(formData.get("cost") ?? 0) \|\| null;` |
| src/app/app/fleet/vehicles/actions.ts:72 | `const cost = Number(formData.get("cost") ?? 0) \|\| null;` |
| src/app/app/marketing/campaigns/actions.ts:27 | `const budget = Number(formData.get("budget") ?? 0) \|\| null;` |
| src/app/app/procurement/inventory/actions.ts:21 | `const unit_cost = Math.max(0, Number(formData.get("unit_cost") ?? 0) \|\| 0);` |
| src/app/app/procurement/inventory/page.tsx:25 | `const items: StockItem[] = rows.map((r) => ({ name: r.name, quantityOnHand: Number(r.quantity_on_han` |
| src/app/app/procurement/inventory/page.tsx:65 | `<td className="num">{r.currency} {Number(r.unit_cost).toLocaleString()}</td>` |
| src/app/app/procurement/purchase-orders/[id]/page.tsx:44 | `<p className="muted mt-1"><span className="badge">{(po.status ?? "").replace(/_/g, " ")}</span> · {p` |
| src/app/app/procurement/purchase-orders/[id]/page.tsx:65 | `<td className="num">{Number(l.unit_price).toLocaleString()}</td>` |
| src/app/app/procurement/purchase-orders/[id]/page.tsx:95 | `<p className="card-sub mt-1">PO qty {poQty} · received {receivedQty} · PO total {po.currency} {Numbe` |
| src/app/app/procurement/purchase-orders/actions.ts:44 | `const total = rows.reduce((s: number, l: any) => s + Number(l.quantity ?? 0) * Number(l.unit_price ?` |
| src/app/app/procurement/purchase-orders/actions.ts:58 | `const unit_price = Math.max(0, Number(formData.get("unit_price") ?? 0) \|\| 0);` |
| src/app/app/procurement/purchase-orders/page.tsx:55 | `<td className="num">{r.currency ?? "LKR"} {Number(r.total_amount ?? 0).toLocaleString()}</td>` |
| src/app/app/procurement/purchase-requests/actions.ts:21 | `const estimated_cost = Number(formData.get("estimated_cost") ?? 0) \|\| null;` |
| src/app/app/procurement/purchase-requests/page.tsx:66 | `<td className="dim small">{r.estimated_cost != null ? `${r.currency ?? "LKR"} ${Number(r.estimated_c` |
| src/app/app/procurement/rfqs/[id]/page.tsx:70 | `<td className="num">{currency} {Number(q.total).toLocaleString()}</td>` |
| src/app/app/procurement/rfqs/actions.ts:36 | `const total_amount = Math.max(0, Number(formData.get("total_amount") ?? 0) \|\| 0);` |
| src/app/app/sales/accounts/[id]/page.tsx:31 | `const aging = ageItems(open.map((i: any): AgingItem => ({ dueDate: i.due_date, outstanding: String(N` |
| src/app/app/sales/accounts/[id]/page.tsx:45 | `<div className="card stat"><div className="k">Outstanding</div><div className="v" style={{ fontSize:` |
| src/app/app/sales/accounts/[id]/page.tsx:58 | `const outstanding = Number(i.total_amount ?? 0) - Number(i.amount_settled ?? 0);` |
| src/app/app/sales/accounts/page.tsx:33 | `cur.outstanding += Number(inv.total_amount ?? 0) - Number(inv.amount_settled ?? 0);` |
| src/app/app/sales/opportunities/actions.ts:18 | `const amount = Math.max(0, Number(formData.get("amount") ?? 0) \|\| 0);` |
| src/app/app/sales/opportunities/page.tsx:29 | `const summary = summarizePipeline(rows.map((r): Opportunity => ({ amount: String(r.amount ?? "0"), p` |
| src/app/app/sales/quotations/page.tsx:53 | `<td>{q.currency} {Number(q.total).toLocaleString()}</td>` |
| src/app/q/[token]/page.tsx:140 | `{Number(quote.tax_amount) > 0 && (` |
| src/lib/money.ts:189 | `* `Number(v).toLocaleString()` — the latter both floats the amount and hides its currency scale.` |
| src/modules/finance/reconcile.ts:66 | `reason: `${best.c.kind} of equal amount, ${Math.round(best.days)}d apart`,` |
| src/modules/procurement/three-way-match.ts:30 | `const amtTol = Math.max(input.amountTolerancePct ?? 0, 0);` |
| src/schemas/common.ts:15 | `// Number("1e-400") would have collapsed such an amount to 0 and rejected a valid tiny value,` |

## 3. V3.1 flags — runtime consumers

| env | consumers |
|---|---|
| V3_1_TASK_DETECTION | **none (scaffolding only)** |
| V3_1_DECISION_PATHS | **none (scaffolding only)** |
| V3_1_TEAM_FORMATION | **none (scaffolding only)** |
| V3_1_AI_GUIDE | **none (scaffolding only)** |
| V3_1_IMPROVEMENT_LOOP | **none (scaffolding only)** |
| V3_1_MANAGER_CONTROL_TOWER | **none (scaffolding only)** |
| V3_1_MULTILINGUAL | **none (scaffolding only)** |
| V3_1_MODEL_ROUTING | **none (scaffolding only)** |

## 4. Cutover/async toggles — runtime consumers

| env | consumers |
|---|---|
| RLS_READS | src/lib/supabase/read.ts |
| RLS_WRITES | src/app/app/finance/customer-invoices/actions.ts<br>src/app/app/finance/supplier-bills/actions.ts<br>src/lib/auth.ts<br>src/lib/supabase/read.ts |
| WHATSAPP_ASYNC | src/app/api/webhooks/whatsapp/route.ts |

## 5. TODO/FIXME markers — 3

| file:line | kind | text |
|---|---|---|
| src/app/legal-config.ts:5 | TODO | `* and the page copy with a qualified legal adviser and replace the TODO placeholders` |
| src/app/legal-config.ts:10 | TODO | `// TODO: replace with your registered legal company name.` |
| src/app/legal-config.ts:12 | TODO | `// TODO: replace with a monitored business contact address.` |

## 6. Stub routes (501 / not-implemented) — 1

- src/app/api/webhooks/email/route.ts

## 7. Error-masking suspects (catch → empty return) — 72 (Phase-1C triage list)

| file:line | returns |
|---|---|
| src/ai/gateway.ts:157 | `null` |
| src/ai/manager-observation.ts:123 | `null` |
| src/ai/quotation.ts:104 | `null` |
| src/app/api/cron/daily-digest/route.ts:22 | `0` |
| src/app/api/exports/[kind]/route.ts:28 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:40 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:52 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:64 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:76 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:86 | `error-discarding destructure` |
| src/app/app/admin/catalog/page.tsx:13 | `error-discarding destructure` |
| src/app/app/admin/employees/actions.ts:26 | `error-discarding destructure` |
| src/app/app/admin/employees/page.tsx:22 | `error-discarding destructure` |
| src/app/app/admin/health/page.tsx:19 | `[]` |
| src/app/app/admin/outbox/page.tsx:16 | `[]` |
| src/app/app/command/cases/page.tsx:21 | `error-discarding destructure` |
| src/app/app/command/page.tsx:33 | `error-discarding destructure` |
| src/app/app/command/page.tsx:35 | `[]` |
| src/app/app/finance/accounts/page.tsx:16 | `[]` |
| src/app/app/finance/approvals/page.tsx:18 | `[]` |
| src/app/app/finance/cash-counts/page.tsx:16 | `[]` |
| src/app/app/finance/chart-of-accounts/page.tsx:19 | `error-discarding destructure` |
| src/app/app/finance/commitments/page.tsx:17 | `[]` |
| src/app/app/finance/customer-invoices/page.tsx:18 | `error-discarding destructure` |
| src/app/app/finance/expenses/actions.ts:19 | `error-discarding destructure` |
| src/app/app/finance/expenses/page.tsx:16 | `[]` |
| src/app/app/finance/forecast/page.tsx:19 | `[]` |
| src/app/app/finance/journals/new/page.tsx:18 | `error-discarding destructure` |
| src/app/app/finance/journals/page.tsx:17 | `error-discarding destructure` |
| src/app/app/finance/loans/page.tsx:15 | `[]` |
| src/app/app/finance/page.tsx:14 | `[]` |
| src/app/app/finance/periods/page.tsx:16 | `[]` |
| src/app/app/finance/receivables/page.tsx:27 | `[]` |
| src/app/app/finance/reconciliation/page.tsx:18 | `[]` |
| src/app/app/finance/supplier-bank-changes/page.tsx:16 | `[]` |
| src/app/app/finance/supplier-bills/page.tsx:18 | `error-discarding destructure` |
| src/app/app/finance/trial-balance/page.tsx:19 | `[]` |
| src/app/app/fleet/page.tsx:17 | `[]` |
| src/app/app/fleet/vehicles/actions.ts:36 | `error-discarding destructure` |
| src/app/app/fleet/vehicles/page.tsx:17 | `error-discarding destructure` |
| src/app/app/hr/capacity/page.tsx:19 | `[]` |
| src/app/app/hr/page.tsx:12 | `0` |
| src/app/app/hr/page.tsx:15 | `[]` |
| src/app/app/hr/staff/actions.ts:18 | `error-discarding destructure` |
| src/app/app/hr/staff/page.tsx:17 | `error-discarding destructure` |
| src/app/app/legal/contracts/actions.ts:36 | `error-discarding destructure` |
| src/app/app/legal/contracts/page.tsx:20 | `error-discarding destructure` |
| src/app/app/legal/page.tsx:17 | `[]` |
| src/app/app/marketing/audiences/page.tsx:15 | `0` |
| src/app/app/marketing/page.tsx:13 | `0` |
| src/app/app/me/page.tsx:19 | `[]` |
| src/app/app/operations/tasks/actions.ts:163 | `error-discarding destructure` |
| src/app/app/operations/tasks/page.tsx:31 | `error-discarding destructure` |
| src/app/app/procurement/page.tsx:14 | `0` |
| src/app/app/procurement/page.tsx:17 | `[]` |
| src/app/app/procurement/purchase-orders/actions.ts:36 | `error-discarding destructure` |
| src/app/app/procurement/purchase-orders/page.tsx:17 | `error-discarding destructure` |
| src/app/app/procurement/purchase-requests/page.tsx:26 | `error-discarding destructure` |
| src/app/app/procurement/rfqs/actions.ts:15 | `error-discarding destructure` |
| src/app/app/sales/accounts/page.tsx:16 | `[]` |
| src/app/app/sales/leads/page.tsx:23 | `error-discarding destructure` |
| src/db/consumer-store.ts:74 | `error-discarding destructure` |
| src/db/consumer-store.ts:94 | `error-discarding destructure` |
| src/lib/access.ts:81 | `error-discarding destructure` |
| src/lib/access.ts:112 | `error-discarding destructure` |
| src/lib/documents.ts:52 | `error-discarding destructure` |
| src/lib/documents.ts:54 | `null` |
| src/lib/ledger-report.ts:13 | `[]` |
| src/lib/money.ts:139 | `null` |
| src/lib/task-access.ts:27 | `error-discarding destructure` |
| src/lib/task-access.ts:38 | `error-discarding destructure` |
| src/lib/task-access.ts:48 | `error-discarding destructure` |
