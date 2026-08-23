# Completion Inventory (machine-generated — do not hand-edit)

> Regenerate with `node scripts/completion-inventory.mjs`. Deterministic: changes only when code changes.
> Suspect lists are HEURISTIC work lists (each entry needs triage), not verdicts.

## 1. supabaseAdmin() usage — 19 file(s)

| file | refs |
|---|---|
| src/app/api/cron/ai-monitor/route.ts | 2 |
| src/app/api/cron/daily-digest/route.ts | 2 |
| src/app/api/cron/dispatch-drain/route.ts | 2 |
| src/app/api/cron/follow-ups/route.ts | 2 |
| src/app/api/cron/inbound-sweeper/route.ts | 2 |
| src/app/api/cron/outbox/route.ts | 2 |
| src/app/api/health/route.ts | 2 |
| src/app/api/webhooks/whatsapp/route.ts | 2 |
| src/app/app/admin/employees/actions.ts | 4 |
| src/app/app/admin/health/page.tsx | 2 |
| src/app/app/admin/inbound-review/actions.ts | 2 |
| src/app/app/command/analyze/actions.ts | 3 |
| src/app/app/messages/[id]/actions.ts | 2 |
| src/inngest/functions.ts | 4 |
| src/lib/audit.ts | 2 |
| src/lib/documents.ts | 2 |
| src/lib/inbound/production-deps.ts | 4 |
| src/lib/outbox-enqueue.ts | 2 |
| src/lib/quotations.ts | 7 |

Allowlist: scripts/allowlists/supabase-admin-system.json (enforced via --check)

## 2. money-as-Number suspects — 14 line(s) (Phase-1A triage list)

| file:line | code |
|---|---|
| src/ai/anthropic-transport.ts:62 | `const maxTokens = Math.min(req.maxTokens, EVAL_LIMITS.maxOutputTokens);` |
| src/app/api/health/route.ts:120 | `imbalancedJournals: Number(row.imbalanced_journals ?? 0),` |
| src/app/app/finance/customer-invoices/[id]/page.tsx:55 | `<tr key={i}><td>{l.description}</td><td className="num">{Number(l.quantity)}</td><td className="num"` |
| src/app/app/finance/supplier-bills/[id]/page.tsx:56 | `<tr key={i}><td>{l.description}</td><td className="num">{Number(l.quantity)}</td><td className="num"` |
| src/app/app/finance/tax-codes/page.tsx:50 | `<td className="num dim">{fmtMoney(taxAmount("1000", Number(r.rate), "LKR"))}</td>` |
| src/app/app/fleet/vehicles/[id]/page.tsx:83 | `<span>{Number(f.litres ?? 0)} L @ {Number(f.odometer ?? 0)} km</span><span className="dim">{fmtMoney` |
| src/app/app/legal/insurances/actions.ts:31 | `cover_amount: cover_amount ? Number(cover_amount) : null,` |
| src/app/app/procurement/inventory/page.tsx:26 | `const items: StockItem[] = rows.map((r) => ({ name: r.name, quantityOnHand: Number(r.quantity_on_han` |
| src/app/app/procurement/purchase-orders/actions.ts:46 | `const total = decSum(rows.map((l: any) => dec(l.unit_price).times(Math.max(0, Math.trunc(Number(l.qu` |
| src/app/app/sales/opportunities/page.tsx:30 | `const summary = summarizePipeline(rows.map((r): Opportunity => ({ amount: String(r.amount ?? "0"), p` |
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
| V3_1_AI_GUIDE | src/app/app/operations/tasks/[id]/page.tsx<br>src/app/app/operations/tasks/actions.ts |
| V3_1_IMPROVEMENT_LOOP | **none (scaffolding only)** |
| V3_1_MANAGER_CONTROL_TOWER | **none (scaffolding only)** |
| V3_1_MULTILINGUAL | **none (scaffolding only)** |
| V3_1_MODEL_ROUTING | **none (scaffolding only)** |

## 4. Cutover/async toggles — runtime consumers

| env | consumers |
|---|---|
| RLS_READS | src/lib/auth.ts<br>src/lib/supabase/read.ts |
| RLS_WRITES | src/app/app/finance/customer-invoices/actions.ts<br>src/app/app/finance/supplier-bills/actions.ts<br>src/lib/auth.ts<br>src/lib/supabase/read.ts |
| WHATSAPP_ASYNC | src/app/api/webhooks/whatsapp/route.ts<br>src/inngest/functions.ts<br>src/lib/inbound/production-deps.ts |

## 5. TODO/FIXME markers — 3

| file:line | kind | text |
|---|---|---|
| src/app/legal-config.ts:5 | TODO | `* and the page copy with a qualified legal adviser and replace the TODO placeholders` |
| src/app/legal-config.ts:10 | TODO | `// TODO: replace with your registered legal company name.` |
| src/app/legal-config.ts:12 | TODO | `// TODO: replace with a monitored business contact address.` |

## 6. Stub routes (501 / not-implemented) — 1

- src/app/api/webhooks/email/route.ts

## 7. Error-masking suspects (catch → empty return) — 71 (Phase-1C triage list)

| file:line | returns |
|---|---|
| src/ai/gateway.ts:189 | `null` |
| src/ai/manager-observation.ts:129 | `null` |
| src/ai/quotation.ts:153 | `null` |
| src/app/api/cron/daily-digest/route.ts:22 | `0` |
| src/app/api/exports/[kind]/route.ts:28 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:40 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:52 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:64 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:76 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:86 | `error-discarding destructure` |
| src/app/app/admin/catalog/page.tsx:14 | `error-discarding destructure` |
| src/app/app/admin/employees/actions.ts:27 | `error-discarding destructure` |
| src/app/app/admin/employees/page.tsx:22 | `error-discarding destructure` |
| src/app/app/admin/health/page.tsx:21 | `[]` |
| src/app/app/admin/outbox/page.tsx:16 | `[]` |
| src/app/app/command/cases/page.tsx:21 | `error-discarding destructure` |
| src/app/app/command/memory/page.tsx:51 | `[]` |
| src/app/app/finance/accounts/page.tsx:17 | `[]` |
| src/app/app/finance/approvals/page.tsx:22 | `[]` |
| src/app/app/finance/cash-counts/page.tsx:17 | `[]` |
| src/app/app/finance/chart-of-accounts/page.tsx:19 | `error-discarding destructure` |
| src/app/app/finance/commitments/page.tsx:18 | `[]` |
| src/app/app/finance/customer-invoices/page.tsx:19 | `error-discarding destructure` |
| src/app/app/finance/expenses/actions.ts:19 | `error-discarding destructure` |
| src/app/app/finance/expenses/page.tsx:17 | `[]` |
| src/app/app/finance/forecast/page.tsx:21 | `[]` |
| src/app/app/finance/journals/new/page.tsx:18 | `error-discarding destructure` |
| src/app/app/finance/journals/page.tsx:18 | `error-discarding destructure` |
| src/app/app/finance/loans/page.tsx:16 | `[]` |
| src/app/app/finance/page.tsx:16 | `[]` |
| src/app/app/finance/periods/page.tsx:16 | `[]` |
| src/app/app/finance/receivables/page.tsx:28 | `[]` |
| src/app/app/finance/reconciliation/page.tsx:19 | `[]` |
| src/app/app/finance/supplier-bank-changes/page.tsx:16 | `[]` |
| src/app/app/finance/supplier-bills/page.tsx:19 | `error-discarding destructure` |
| src/app/app/finance/trial-balance/page.tsx:20 | `[]` |
| src/app/app/fleet/page.tsx:17 | `[]` |
| src/app/app/fleet/vehicles/actions.ts:37 | `error-discarding destructure` |
| src/app/app/fleet/vehicles/page.tsx:17 | `error-discarding destructure` |
| src/app/app/hr/capacity/page.tsx:20 | `[]` |
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
| src/app/app/operations/tasks/actions.ts:164 | `error-discarding destructure` |
| src/app/app/operations/tasks/page.tsx:31 | `error-discarding destructure` |
| src/app/app/procurement/page.tsx:14 | `0` |
| src/app/app/procurement/page.tsx:17 | `[]` |
| src/app/app/procurement/purchase-orders/actions.ts:37 | `error-discarding destructure` |
| src/app/app/procurement/purchase-orders/page.tsx:18 | `error-discarding destructure` |
| src/app/app/procurement/purchase-requests/page.tsx:27 | `error-discarding destructure` |
| src/app/app/procurement/rfqs/actions.ts:16 | `error-discarding destructure` |
| src/app/app/sales/accounts/page.tsx:18 | `[]` |
| src/app/app/sales/leads/page.tsx:24 | `error-discarding destructure` |
| src/db/consumer-store.ts:124 | `error-discarding destructure` |
| src/lib/access.ts:83 | `error-discarding destructure` |
| src/lib/access.ts:141 | `error-discarding destructure` |
| src/lib/documents.ts:56 | `error-discarding destructure` |
| src/lib/documents.ts:58 | `null` |
| src/lib/finance/intent-gate.ts:85 | `null` |
| src/lib/ledger-report.ts:13 | `[]` |
| src/lib/money.ts:139 | `null` |
| src/lib/task-access.ts:27 | `error-discarding destructure` |
| src/lib/task-access.ts:38 | `error-discarding destructure` |
| src/lib/task-access.ts:48 | `error-discarding destructure` |
