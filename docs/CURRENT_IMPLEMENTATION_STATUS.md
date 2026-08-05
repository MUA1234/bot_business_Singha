# Current Implementation Status

_Generated from verified code and tests. Update this after every completed phase or
material feature (Constitution §14). This file — not the old Phase-0 warnings —
describes reality._

**Target architecture:** `docs/architecture-v2/CHANGE_PLAN.md` +
`docs/architecture-v2/Singha_AI_Management_Architecture_V2.puml`.

## What actually exists today

| Area | Status | Location |
|---|---|---|
| Next.js app shell, auth (Supabase), middleware session gate | ✅ working | `src/app`, `src/middleware.ts` |
| Department dashboards + admin panel (employees, catalog, departments) | ✅ working | `src/app/app/*` |
| Company-wide customer Messages inbox (all employees) | ✅ working | `src/app/app/messages/*` |
| WhatsApp Cloud API quotation flow (live, official API) | ✅ working | `src/app/api/webhooks/whatsapp`, `src/lib/order-intake.ts`, `src/lib/quotations.ts` |
| Internal double-entry Accounting Core (journal, trial balance, P&L, balance sheet, reconciliation) | ✅ tested | `src/accounting/*` |
| Event ingestion, dedup, source-event store, Inngest processing | ✅ present | `src/events/*`, `src/db/source-event-store.ts`, `src/inngest/*` |
| AI gateway + Zod-validated extraction/quotation | ✅ present | `src/ai/*`, `src/schemas/*` |
| Authority / approval policy logic | ✅ tested | `src/policy/authority.ts` |
| Security headers, CSP, CSPRNG quote tokens | ✅ done | `next.config.mjs`, `src/lib/quotations.ts` |
| Unit tests | ✅ 66 passing | `tests/*` |

## Accounting source of truth

The internally-owned **Accounting Core** (`src/accounting/*`) is authoritative.
**QuickBooks is NOT used** (DECISIONS D-011). `docs/QUICKBOOKS_INTEGRATION_MODEL.md`
is superseded/archived. Any instruction naming QuickBooks as the source of truth is void.

## Phase 0 (Stabilise & Secure) — progress

Per change plan §5 and Constitution §5/§12:

- [x] **§5.1** Correct authoritative documents (CLAUDE.md status + QuickBooks;
      embed V2 docs; add this file; add superseded-document rule).
- [x] **§5.4** Fix cross-company administrative mutations — employee
      activate/deactivate and password reset, and product activation, now confirm the
      target belongs to the caller's company before mutating (`targetInAdminCompany`,
      `.eq("company_id", …)`).
- [x] **§5.4/§12** Audit privileged operations via append-only `audit_events`
      (`src/lib/audit.ts`).
- [x] **§5.5** Repair RLS: remove `company_id IS NULL` user-readable leak; restrict
      dead-letter events to workers (`migrations/0008_phase0_rls_hardening.sql`).
- [ ] **§5.3** Unify the dual identity model (`users`/`user_company_access` vs
      `profiles`) into one membership/role/authority model. **Large, risky —
      forward-only migration with backfill; not started.**
- [ ] **§5.4** Move user-facing reads/writes off the service-role client onto
      session-bound RLS clients. **Not started (broad).**
- [x] **§5.5** Company-scoped composite foreign keys (child.company = parent.company)
      for quotation_items/price_confirmations/wa_messages/quotations — added `NOT VALID`
      so no legacy row breaks (`migrations/0009_composite_company_fks.sql`).
- [x] **§13.1** CI foundation: `.github/workflows/ci.yml` (typecheck/lint/test/build/
      migration-order) + `.eslintrc.json`. (eslint installed on CI runner; local
      install blocked by a broken npm cache — run `sudo chown -R 501:20 ~/.npm`.)
- [~] **§5.3** Identity unification — **step 1 done (additive)**:
      `migrations/0010_identity_foundation.sql` creates memberships / org units /
      roles / authority rules / assignments / employee_profiles / delegations
      ALONGSIDE profiles and backfills them. No cutover yet — app still reads/writes
      profiles. Steps 4–6 (read cutover, write cutover, freeze legacy) are gated on
      owner approval + staging tests. Plan: `IDENTITY_UNIFICATION_PLAN.md`.
- [ ] **§5.6/§5.7** Persist-first async WhatsApp + transactional outbox. Webhook
      currently replies synchronously (owner instruction 2026-08-04).
- [ ] **§13** Automated cross-company isolation tests (need a test/staging DB).

## Phase 1/2 foundations started (additive, not cut over)

- **§5.7 Outbox** — `message_outbox` table (migration 0011) + pure idempotent send
  logic (`src/events/outbox.ts`, 5 tests). Delivery worker + wiring: later step
  (live WhatsApp reply stays synchronous per owner instruction 2026-08-04).
- **§7.3 Task lifecycle** — pure state machine `src/modules/work/task-lifecycle.ts`
  (6 tests; encodes the "no verify without human evidence" rule, Constitution §10) +
  tables projects/tasks/dependencies/assignments/check-ins/evidence (migration 0012).
  Operations/tasks UI wiring: later step.

- **§7.2 Capacity engine** — pure `src/modules/work/capacity.ts` (4 tests) + table
  `capacity_snapshots` (migration 0013). Command-centre wiring: later step.
- **§6.1/§6.3 AI governance schemas** — `src/schemas/management.ts`: Zod
  `ManagementObservation` + `DecisionProposal` + `AuthorityLevel` (5 tests). These are
  the mandatory schema gate before any AI-proposed action reaches the policy engine
  (Constitution §6). No executor wired — proposals only.
- **§6.3 Decision router** — pure `src/management/policy/route-decision.ts` (7 tests):
  maps a validated proposal → auto / execute_routine / require_approval, with a
  never-autonomous list (payments, bank details, contracts, dismissal, ledger, GPS,
  CCTV) that can never auto-run. Complements the financial engine in
  `src/policy/authority.ts`. No executor wired.
- **§6.2 Exception detector** — pure `src/management/ai-manager/exceptions.ts`
  (5 tests): from task + capacity state → ranked overdue / blocked / escalated /
  stale / missing-estimate / overloaded list. This is the engine for the exception-led
  command centre (§10). Read-only; no UI wired yet.
- **§6.2 Priority scorer** — pure `src/management/ai-manager/priority.ts` (4 tests):
  urgency from state + deadline + base priority; terminal sorts last. Wired into the
  tasks list ordering (most urgent first).

## Wired UI (first pages using the brain)

- **§10.1 Command Centre** — `/app/command` (admin): runs the exception detector over
  live tasks + capacity, ranked critical-first. Read-only, company-scoped, graceful
  before migrations.
- **§7.3 Tasks UI** — `/app/operations/tasks` (ops/admin): create tasks and move them
  through **legal transitions only** (pure lifecycle guard); "completed" hidden
  (needs evidence flow). Writes are company-scoped + audited; graceful pre-migration.
- **§7.3/§10 Task detail** — `/app/operations/tasks/[id]`: log check-ins, add evidence
  (7 kinds), and **evidence-gated completion** — "Verify & complete" is blocked (UI +
  server) when a task requires evidence and none exists. Company-scoped + audited.
- **§8.3 AR/AP ageing** — pure `src/modules/finance/aging.ts` (4 tests, decimal money):
  buckets outstanding balances by days overdue. Wired into `/app/finance` + a
  `/app/finance/receivables` drill-down (aged invoice/bill list, 90+ flagged).
- **§8.5 Cash position** — pure `src/modules/finance/cash-position.ts` (3 tests):
  per-account balance = opening + in − out. Wired as the Command Centre "Cash on hand"
  tile (reads `bank_accounts`/`cash_accounts`/`payments`). The command centre now shows
  work exceptions + cash + receivables + payables in one exception-led view (§10.1).

## Phase 4 — Department modules (additive, migration 0014)

Pure engines (all tested) + company-scoped, audited, graceful UI:
- **§9.1 CRM/Sales** — `leads`/`opportunities` tables; `lead-scoring.ts` (hot/warm/cold,
  4 tests); `/app/sales/leads` (capture, stage flow, ranked pipeline).
- **§9.2 Procurement** — `purchase_requests`/`purchase_orders`/`po_lines`/
  `goods_receipts`; `three-way-match.ts` (PO↔receipt↔bill, 5 tests);
  `/app/procurement/purchase-requests` (create + approval flow).
- **§9.3 Legal & Compliance** — new department; `legal_matters`/`contracts`/
  `obligations`/`licences`; shared `renewals.ts` (expiry detector, 3 tests);
  `/app/legal` (renewals dashboard) + `/app/legal/contracts`.
- **§9.4 Fleet & Transport** — new department; `vehicles`/`drivers`/`trips`/
  `fuel_logs`/`maintenance_records`/`vehicle_documents`; renewals engine;
  `/app/fleet` (doc/service/licence alerts) + `/app/fleet/vehicles`.
- **§6.2/§8.5 Cash forecast** — `forecast.ts` (dated inflow/outflow projection,
  trough + goes-negative, 3 tests). Wired: `/app/finance/forecast` + Command Centre
  briefing.
- **§8.3 Bank reconciliation** — pure `reconcile.ts` matcher (3 tests); read-only
  suggestions at `/app/finance/reconciliation` (bank txns ↔ payments/receipts).
- **§6.2 Executive briefing** — pure `briefing.ts` (3 tests); rendered as the Command
  Centre "Today's briefing" card (critical count, cash risk, overdue AR/AP).

## Workflow depth (wired, no new migration)

- **§7/§6.3 Approvals workspace** — pure `approval-progress.ts` (SoD + progress, 4
  tests); `/app/finance/approvals` lets an eligible approver (finance/admin, not the
  submitter, one action each) approve/reject; status recomputed; audited. Approval is
  never payment.
- **§10.2 Employee "My Work"** — `/app/me` (nav for every employee): my open tasks +
  price confirmations for my department, priority-ranked.
- **§9.2 Purchase Orders + three-way match** — `/app/procurement/purchase-orders`
  (create, lines, goods receipt) + a **live in-browser three-way-match** check
  (`ThreeWayCheck`, pure engine) of a supplier bill vs the PO and receipts. Company-
  scoped + audited.

## Production ledger (§8.1/§8.2 — Phase 3)

- **Atomic journal posting** — `post_manual_journal` RPC (migration **0015**): posts
  header + lines in one transaction; enforces ≥2 lines, accounts exist/active,
  period open, no negative/two-sided lines, and **debit == credit**. Human-initiated
  only (permission-checked server action); the LLM never calls it. Posted journals are
  immutable (corrections = reversals).
- **Chart of Accounts** — `/app/finance/chart-of-accounts` (create + list).
- **Manual journal entry** — `/app/finance/journals/new` with a live in-browser
  balance check (`checkDraftJournal`, 4 tests) → atomic post; list + immutable detail.
- **Trial balance / P&L / balance sheet** — `/app/finance/trial-balance`, derived
  purely from posted lines via the existing accounting core (reconciles to the ledger).

## Settlement & corrections (§8.1/§8.3 — migration 0016)

- **Receipts / payments** — `settle_customer_invoice` / `settle_supplier_bill` RPCs
  (reuse `post_manual_journal`): record a receipt (Dr Cash, Cr AR) or payment (Dr AP,
  Cr Cash), advance `amount_settled` + status, all atomic. **Recording only — never a
  bank transfer** (Constitution). Wired into invoice/bill detail pages.
- **Journal reversal** — `reverse_journal` RPC posts a mirror entry and marks the
  original `reversed` (corrections never edit posted journals). "Reverse" button on
  journal detail.
- Pure `settlement.ts` (remaining/status/guard, 3 tests).

## Finance ops + observability (no new migration)

- **Bank & Cash accounts** — `/app/finance/accounts` (create/list); feed cash position
  + forecast.
- **Bank import + reconciliation confirm** — `/app/finance/reconciliation`: paste
  statement lines (pure `bank-import.ts` parser, 3 tests) → `bank_transactions`;
  **confirm** a suggested match → `reconciliation_matches` + marks the txn matched.
- **System Health** (§13) — `/app/admin/health`: pure `health.ts` summariser (3 tests)
  over failed/unprocessed events, dead letters, outbox failures, AI runs & cost.

## HR & Workforce (§7.1 — migration 0017)

- Profile HR fields (phone, job_title, start_date, skills[], annual_leave_days) +
  `leave_requests` table.
- Pure `workforce/leave.ts` (inclusive days, overlap, remaining, 3 tests).
- `/app/hr/staff` directory + `/app/hr/staff/[id]` record: edit contact/title/skills,
  leave request + **approve/reject**, remaining entitlement.
- Self-service leave request on `/app/me`.

## Marketing + Objectives (§9/§10.1 — migration 0018)

- **Marketing** — `audiences` (sized live from customers/leads) + `campaigns` (lifecycle
  draft→scheduled→running→done). Wired `/app/marketing/audiences` + `/campaigns`.
  Actual sending stays gated (approved templates + outbox worker).
- **Objectives/KPIs** — `objectives` table; pure `objective-status.ts` (progress vs
  time → on_track/at_risk/off_track/done, 4 tests); `/app/admin/objectives`.

## Senior AI Manager loop (§6.1/§6.2 — the core intent) — no new migration

- **Observation runner** — `src/ai/manager-observation.ts`: gateway route +
  `wrapUntrusted` fence + Zod `ManagementObservation` validation; company scope is
  injected from trusted input, never the model.
- **Pure planner** — `src/management/ai-manager/pipeline.ts` (`planFromObservation`,
  4 tests): observation → captured tasks + approval flag + clarifications. Only ever
  proposes low-risk `captured` tasks; sensitive matters flag for human approval.
- **UI** — `/app/command/analyze` (admin): paste a business update → observe → capture
  tasks + surface proposals. **The AI never executes** — no money, no ledger, no
  commitments (Constitution §6). Requires `OPENAI_API_KEY`; degrades gracefully.

## Fleet operations depth (§9.4 — no new migration)

- **Vehicle detail** — `/app/fleet/vehicles/[id]`: documents (feed renewal alerts),
  maintenance, fuel logs with computed **km/L** (pure `fuel-efficiency.ts`, 3 tests),
  and trips. **Drivers** — `/app/fleet/drivers` with licence-expiry flags. Company-
  scoped + audited; the fleet dashboard's renewal alerts now have real data behind them.

## Legal depth (§9.3 — no new migration)

- **Matters** (`/app/legal/matters`), **Licences** (`/app/legal/licences`), and
  **contract obligations** (`/app/legal/contracts/[id]`: add + mark done/waived).
  Licences/obligations now have real data behind the Legal renewals dashboard.
  Company-scoped + audited.

## Financial statements (§8.1 — no new migration)

- **Profit & Loss** (`/app/finance/pnl`) and **Balance Sheet** (`/app/finance/balance-sheet`),
  per-account, derived purely from posted journals via the accounting core (shared
  `lib/ledger-report.ts`). Always reconcile to the ledger; balance-sheet flags if
  A ≠ L + E. Read-only, company-scoped.

## Task assignment + Capacity (§7.2/§7.3 — migration 0019)

- `tasks.assigned_to`; assign + set estimate on the task detail page; "Assigned to me"
  on `/app/me`.
- **Capacity** — `/app/hr/capacity`: per-employee workload from assigned/estimated
  tasks via the pure `computeCapacity` engine; "Recompute" writes weekly
  `capacity_snapshots` → Command Centre over/under-allocation exceptions.

## Sales — Opportunities (§9.1 — no new migration)

- `/app/sales/opportunities`: deals with amount + probability, mark won/lost (won/lost
  reflects onto the source lead). Pure `pipeline-value.ts` (open/weighted/won, 3 tests)
  drives the forecast tiles. Company-scoped + audited.

## Procurement RFQ (§9.2 — migration 0020)

- `rfqs` + `supplier_quotations`; `/app/procurement/rfqs` create, `/[id]` collect
  quotes → **ranked cheapest-first** (pure `quote-comparison.ts`, 3 tests, decimal
  money) → **award**. Completes RFQ → PO. Company-scoped + audited.

## Inventory (§9.2 — migration 0021)

- `inventory_items` + `stock_movements`; `/app/procurement/inventory`: create items,
  move stock (in/out/set), **reorder flags** + **stock valuation** via pure
  `inventory.ts` (3 tests, decimal). Company-scoped + audited.

## Notifications (§10 UX — migration 0022)

- `notifications` table (own-row RLS); `/app/notifications` (mark read/all) + shared
  nav for every employee. Emitted on **leave decisions**, **approval outcomes**, and
  **task assignments**. Pure `unreadCount` (1 test).

## Expense claims + reimbursement (§8.3 — no new migration)

- Staff submit expenses from `/app/me` (bridges the legacy `employees` table on demand);
  finance reviews at `/app/finance/expenses` (approve/reject) and **reimburses** approved
  claims → posts Dr Expense / Cr Cash via the atomic RPC + records a reimbursement.
  Employee is notified at each step. Recording only, not a bank transfer.

## Audit log + exports (§13 — no new migration)

- **Audit Log** — `/app/admin/audit` (admin): append-only trail of privileged + AI
  actions, entity-filterable, readable labels (pure `audit-format.ts`, 2 tests).
- **Exports** extended: `/api/exports/journals` and `/api/exports/audit` (audit is
  admin-only) alongside quotations/orders/price-confirmations/catalog.

## Commitments + recurring → forecast (§8.5 — no new migration)

- `/app/finance/commitments`: one-off commitments + recurring obligations (rent,
  salaries). Pure `recurring.ts` expands cadences into dated outflows (4 tests). The
  **cash forecast now includes** bills + commitments + recurring — not just bills.

## Accounting periods & close (§8.1/§8.3 — no new migration)

- `/app/finance/periods`: create a fiscal year + 12 monthly periods (pure
  `periods.ts`, 2 tests), **close/lock/reopen** periods. Closing locks the ledger
  against that period — enforced by `post_manual_journal`. Reopening is audited.

## File evidence / documents (storage — no new migration)

- `src/lib/documents.ts`: upload to a PRIVATE Supabase Storage bucket "evidence" +
  `documents` row (content-hash dedup, pure path helper, 3 tests); short-lived signed
  download URLs. Wired into task detail: **upload a file as document evidence** →
  appears with a signed download link. Degrades gracefully if the bucket is absent.
  **Requires a private storage bucket named `evidence`.**

## Loans (§8.3 — no new migration)

- `/app/finance/loans`: register a loan → generates a reducing-balance **amortization
  schedule** (pure `amortization.ts`, 4 tests, decimal — principals sum exactly to the
  loan, balance clears to zero). Uses `loans`/`loan_schedules` (migration 0005).

## AI Manager over real conversations (§6.2 — no new migration)

- Conversation thread (`/app/messages/[id]`) has an admin **"Analyse with AI"** action:
  runs the observation→plan pipeline over the actual WhatsApp thread (untrusted text
  fenced) and **captures follow-up tasks**. Observe/propose only — never replies to the
  customer, never executes. Connects the AI manager to real business data.

## Tax codes + petty cash (§8.3 — no new migration)

- **Tax codes** — `/app/finance/tax-codes`: rate register; pure `tax.ts`
  (tax/gross/net, part of 3 tests).
- **Cash counts** — `/app/finance/cash-counts`: record a physical count; system
  computes the book balance (cash-position engine) and stores the **variance** (pure
  `petty-cash.ts`).

## Customer 360 (§9.1 — no new migration)

- `/app/sales/accounts` (customers with outstanding) + `/app/sales/accounts/[id]`
  (profile, invoices aged, receipts, outstanding/overdue/90+). Reuses the aging engine.
  (Sales nav: WhatsApp threads renamed "Conversations"; new "Customer Accounts".)

## Department dashboards (§10 — no new migration)

- Replaced the last placeholder overviews with real dashboards: **Operations**
  (task counts + live exceptions), **Procurement** (open PRs/POs/RFQs + reorder count),
  **HR** (staff, pending leave, overloaded), **Marketing** (campaigns, audiences, leads).
  Every tile links to the underlying records.

## Database

Migrations 0008–0013 applied to the Singha Supabase project (confirmed by owner,
2026-08-05). Migration **0014** (departments expansion) is pending — run
`docs/architecture-v2/RUN_0014_DEPARTMENTS.sql`.

**Conflict on record:** change plan §5.6 wants asynchronous WhatsApp; owner instruction
(2026-08-04) requires synchronous reply. Not resolved — sync retained until owner decides.

## Known limitations / honest gaps

- Company isolation currently depends on **application-layer** `company_id` filtering
  for pages that use the service-role client. RLS is enabled on tables but the app
  bypasses it via service role. §5.3/§5.4 close this properly.
- The dual identity model (§5.3) is the biggest outstanding P0 foundation item.
- No CI yet (§13.1): lint config, secret/dependency scanning, migration validation in
  CI are not configured.

## Not built (later phases / gated)

Senior AI Manager loop, capacity/scheduling, full task lifecycle, production posting
workflow, CRM/procurement/legal/fleet modules, command centre — see change plan
Phases 2–5. GPS/attendance/CCTV and autonomous money/legal execution are **gated**
behind written owner + legal/privacy approval (Constitution §11, §15).
