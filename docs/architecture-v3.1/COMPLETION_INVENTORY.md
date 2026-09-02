# Completion Inventory (machine-generated — do not hand-edit)

> Regenerate with `node scripts/completion-inventory.mjs`. Deterministic: changes only when code changes.
> Suspect lists are HEURISTIC work lists (each entry needs triage), not verdicts.

## 1. supabaseAdmin() usage — 26 file(s)

| file | refs |
|---|---|
| src/app/api/cron/ai-monitor/route.ts | 2 |
| src/app/api/cron/daily-digest/route.ts | 2 |
| src/app/api/cron/directive-escalation/route.ts | 2 |
| src/app/api/cron/dispatch-drain/route.ts | 2 |
| src/app/api/cron/follow-ups/route.ts | 2 |
| src/app/api/cron/inbound-sweeper/route.ts | 2 |
| src/app/api/cron/outbox/route.ts | 2 |
| src/app/api/health/route.ts | 2 |
| src/app/api/management/cycle/route.ts | 2 |
| src/app/api/management/feedback/route.ts | 2 |
| src/app/api/v1/mobile/push-subscription/route.ts | 2 |
| src/app/api/webhooks/whatsapp/route.ts | 2 |
| src/app/app/admin/employees/actions.ts | 4 |
| src/app/app/admin/health/page.tsx | 2 |
| src/app/app/admin/inbound-review/actions.ts | 2 |
| src/app/app/command/analyze/actions.ts | 3 |
| src/app/app/messages/[id]/actions.ts | 2 |
| src/components/spatial/panels/SystemHealthPanel.tsx | 3 |
| src/inngest/functions.ts | 4 |
| src/kernel/cycle-deps.ts | 2 |
| src/lib/audit.ts | 2 |
| src/lib/comms/preferences.ts | 5 |
| src/lib/documents.ts | 2 |
| src/lib/inbound/production-deps.ts | 4 |
| src/lib/outbox-enqueue.ts | 2 |
| src/lib/quotations.ts | 7 |

Allowlist: scripts/allowlists/supabase-admin-system.json (enforced via --check)

## 2. money-as-Number suspects — 20 line(s) (Phase-1A triage list)

| file:line | code |
|---|---|
| src/ai/anthropic-transport.ts:62 | `const maxTokens = Math.min(req.maxTokens, EVAL_LIMITS.maxOutputTokens);` |
| src/app/api/health/route.ts:120 | `imbalancedJournals: Number(row.imbalanced_journals ?? 0),` |
| src/app/app/ai/page.tsx:122 | `<div className="v">${Number(totalCost).toFixed(4)}</div>` |
| src/app/app/command/health/page.tsx:208 | `totalPeople: Math.max(1, caps.length),` |
| src/app/app/finance/tax-codes/page.tsx:30 | `{ key: "tax", header: "Tax on 1,000", align: "right", render: (r) => <span className="dim">{fmtMoney` |
| src/app/app/legal/insurances/actions.ts:31 | `cover_amount: cover_amount ? Number(cover_amount) : null,` |
| src/app/app/operations/projects/[id]/page.tsx:398 | `const varianceValue = Number(budgetForecast.budgetVsActual.totals.variance);` |
| src/app/app/operations/projects/actions.ts:257 | `if (Number.isNaN(Number(bestCaseTotal)) \|\| Number.isNaN(Number(expectedTotal)) \|\| Number.isNaN(Numbe` |
| src/app/app/procurement/inventory/page.tsx:39 | `const items: StockItem[] = rawRows.map((r) => ({ name: r.name, quantityOnHand: Number(r.quantity_on_` |
| src/app/app/procurement/purchase-orders/actions.ts:80 | `const total = decSum(rows.map((l: any) => dec(l.unit_price).times(Math.max(0, Math.trunc(Number(l.qu` |
| src/app/app/sales/opportunities/page.tsx:49 | `const summary = summarizePipeline(deals.map((r): Opportunity => ({ amount: String(r.amount ?? "0"), ` |
| src/components/os/ConditionInstrument.tsx:123 | `const gapBetween = total > 0 ? Math.min(4, usable / Math.max(segments.length, 1) / 6) : 0;` |
| src/kernel/pagination.ts:192 | `return Math.max(0, Math.min(pageSize, this.total - this.used));` |
| src/kernel/people/learning.ts:245 | `const weakerShare = Math.min(positive, negative) / totalWeight;` |
| src/kernel/people/learning.ts:257 | `weightedSuccessRate: Number((positive / totalWeight).toFixed(6)),` |
| src/lib/money.ts:236 | `* `Number(v).toLocaleString()` — the latter both floats the amount and hides its currency scale.` |
| src/modules/finance/reconcile.ts:66 | `reason: `${best.c.kind} of equal amount, ${Math.round(best.days)}d apart`,` |
| src/modules/management/health-score.ts:62 | `return clamp(60 + 40 * Math.min(1, amount.div(1_000_000).toNumber()));` |
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

## 7. Error-masking suspects (catch → empty return) — 102 (Phase-1C triage list)

| file:line | returns |
|---|---|
| src/ai/gateway.ts:189 | `null` |
| src/ai/manager-observation.ts:129 | `null` |
| src/ai/quotation.ts:209 | `null` |
| src/app/api/cron/daily-digest/route.ts:22 | `0` |
| src/app/api/exports/[kind]/route.ts:28 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:40 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:52 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:64 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:76 | `error-discarding destructure` |
| src/app/api/exports/[kind]/route.ts:86 | `error-discarding destructure` |
| src/app/app/admin/catalog/page.tsx:28 | `error-discarding destructure` |
| src/app/app/admin/employees/actions.ts:27 | `error-discarding destructure` |
| src/app/app/admin/employees/page.tsx:29 | `error-discarding destructure` |
| src/app/app/admin/health/page.tsx:25 | `[]` |
| src/app/app/admin/outbox/page.tsx:34 | `[]` |
| src/app/app/calendar/page.tsx:35 | `[]` |
| src/app/app/command/cases/page.tsx:39 | `error-discarding destructure` |
| src/app/app/command/memory/page.tsx:55 | `[]` |
| src/app/app/documents/page.tsx:32 | `[]` |
| src/app/app/finance/accounts/page.tsx:18 | `[]` |
| src/app/app/finance/budgets/[id]/page.tsx:31 | `[]` |
| src/app/app/finance/budgets/page.tsx:24 | `[]` |
| src/app/app/finance/cash-counts/page.tsx:19 | `[]` |
| src/app/app/finance/chart-of-accounts/page.tsx:20 | `error-discarding destructure` |
| src/app/app/finance/commitments/page.tsx:20 | `[]` |
| src/app/app/finance/customer-invoices/page.tsx:29 | `error-discarding destructure` |
| src/app/app/finance/expenses/actions.ts:19 | `error-discarding destructure` |
| src/app/app/finance/expenses/page.tsx:26 | `[]` |
| src/app/app/finance/forecast/page.tsx:23 | `[]` |
| src/app/app/finance/funding/page.tsx:24 | `[]` |
| src/app/app/finance/journals/new/page.tsx:19 | `error-discarding destructure` |
| src/app/app/finance/journals/page.tsx:20 | `error-discarding destructure` |
| src/app/app/finance/loans/page.tsx:18 | `[]` |
| src/app/app/finance/page.tsx:26 | `[]` |
| src/app/app/finance/periods/page.tsx:17 | `[]` |
| src/app/app/finance/receivables/page.tsx:37 | `[]` |
| src/app/app/finance/reconciliation/page.tsx:22 | `[]` |
| src/app/app/finance/supplier-bank-changes/page.tsx:26 | `[]` |
| src/app/app/finance/supplier-bills/page.tsx:29 | `error-discarding destructure` |
| src/app/app/finance/trial-balance/page.tsx:23 | `[]` |
| src/app/app/fleet/page.tsx:31 | `[]` |
| src/app/app/fleet/vehicles/actions.ts:37 | `error-discarding destructure` |
| src/app/app/fleet/vehicles/page.tsx:29 | `error-discarding destructure` |
| src/app/app/hr/capacity/page.tsx:23 | `[]` |
| src/app/app/hr/page.tsx:41 | `0` |
| src/app/app/hr/page.tsx:44 | `[]` |
| src/app/app/hr/staff/actions.ts:18 | `error-discarding destructure` |
| src/app/app/hr/staff/page.tsx:28 | `error-discarding destructure` |
| src/app/app/legal/contracts/actions.ts:36 | `error-discarding destructure` |
| src/app/app/legal/contracts/page.tsx:21 | `error-discarding destructure` |
| src/app/app/legal/incidents/page.tsx:16 | `[]` |
| src/app/app/legal/obligations/page.tsx:17 | `[]` |
| src/app/app/legal/page.tsx:20 | `[]` |
| src/app/app/marketing/audiences/page.tsx:16 | `0` |
| src/app/app/marketing/page.tsx:16 | `0` |
| src/app/app/me/page.tsx:32 | `[]` |
| src/app/app/operations/projects/[id]/page.tsx:34 | `[]` |
| src/app/app/operations/tasks/actions.ts:190 | `error-discarding destructure` |
| src/app/app/procurement/page.tsx:17 | `0` |
| src/app/app/procurement/page.tsx:20 | `[]` |
| src/app/app/procurement/purchase-orders/actions.ts:71 | `error-discarding destructure` |
| src/app/app/procurement/purchase-orders/page.tsx:31 | `error-discarding destructure` |
| src/app/app/procurement/purchase-orders/page.tsx:44 | `error-discarding destructure` |
| src/app/app/procurement/purchase-requests/page.tsx:38 | `error-discarding destructure` |
| src/app/app/procurement/rfqs/actions.ts:16 | `error-discarding destructure` |
| src/app/app/procurement/service-providers/actions.ts:44 | `error-discarding destructure` |
| src/app/app/procurement/service-providers/page.tsx:36 | `error-discarding destructure` |
| src/app/app/sales/accounts/page.tsx:33 | `[]` |
| src/app/app/sales/leads/page.tsx:38 | `error-discarding destructure` |
| src/components/spatial/WorkspaceProvider.tsx:76 | `null` |
| src/components/spatial/panels/AIRecommendationsPanel.tsx:31 | `error-discarding destructure` |
| src/components/spatial/panels/AIRecommendationsPanel.tsx:50 | `error-discarding destructure` |
| src/components/spatial/panels/AIRecommendationsPanel.tsx:69 | `error-discarding destructure` |
| src/components/spatial/panels/AIRecommendationsPanel.tsx:84 | `error-discarding destructure` |
| src/components/spatial/panels/ApprovalsPanel.tsx:51 | `[]` |
| src/components/spatial/panels/FinancePanel.tsx:19 | `[]` |
| src/components/spatial/panels/PurchaseOrdersPanel.tsx:28 | `error-discarding destructure` |
| src/components/spatial/panels/PurchaseOrdersPanel.tsx:41 | `error-discarding destructure` |
| src/components/spatial/panels/StaffPanel.tsx:14 | `error-discarding destructure` |
| src/components/spatial/panels/SystemHealthPanel.tsx:22 | `[]` |
| src/components/spatial/panels/TasksPanel.tsx:65 | `error-discarding destructure` |
| src/components/spatial/panels/VehiclesPanel.tsx:15 | `error-discarding destructure` |
| src/db/consumer-store.ts:124 | `error-discarding destructure` |
| src/kernel/cycle-deps.ts:511 | `error-discarding destructure` |
| src/kernel/cycle.ts:234 | `0` |
| src/kernel/people/delegation-scope.ts:64 | `null` |
| src/lib/access.ts:54 | `error-discarding destructure` |
| src/lib/access.ts:108 | `error-discarding destructure` |
| src/lib/access.ts:168 | `error-discarding destructure` |
| src/lib/comms/preferences.ts:23 | `error-discarding destructure` |
| src/lib/documents.ts:56 | `error-discarding destructure` |
| src/lib/documents.ts:58 | `null` |
| src/lib/finance/intent-gate.ts:85 | `null` |
| src/lib/ledger-report.ts:13 | `[]` |
| src/lib/money.ts:139 | `null` |
| src/lib/os-shell-data.ts:33 | `null` |
| src/lib/os-shell-data.ts:48 | `error-discarding destructure` |
| src/lib/os-shell-data.ts:54 | `null` |
| src/lib/task-access.ts:27 | `error-discarding destructure` |
| src/lib/task-access.ts:38 | `error-discarding destructure` |
| src/lib/task-access.ts:48 | `error-discarding destructure` |
| src/modules/identity/delegation-authority.ts:130 | `null` |
