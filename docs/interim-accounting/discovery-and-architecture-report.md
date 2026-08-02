# Discovery & architecture report — Interim AI Finance System

Mandated by `Claude_Interim_Accounting_Development_Guide.md` §3 Phase 0 / Master
Prompt. Written 2026-07-30. The build then proceeded to the webhook boundary under
the owner's explicit direction (see `docs/DECISIONS.md` D-011/D-012).

## 1. Current stack & repository structure (at discovery)

The repository was **documentation-only** — 33 Markdown specs in `docs/`, no code
(no `package.json`, `src/`, migrations, or tests). It was at "Phase 0 — assessment &
architecture." So **no feature of the guide was implemented**; this was a greenfield
build, not a modification of a running system.

The reusable "existing bot" (`Automation_Singha_Auctions`, the Sasiri auction sales
bot) is a **separate sibling repository**, treated as a pattern reference only and
explicitly not re-platformed or coupled (D-001, D-010).

## 2. Existing integrations / auth / tenant model / AI / queues

All **absent** in this repo at discovery (greenfield). The mandated target stack
(CLAUDE.md) is Next.js/Vercel, Supabase (Postgres+RLS+Auth+Storage), Inngest, OpenAI
via a self-built gateway, TypeScript, Zod — adopted as-is.

## 3. Key decision surfaced during discovery: remove QuickBooks

The prior docs made QuickBooks the accounting source of truth (D-002/D-009, Phase 11).
The owner's guide + follow-up ("QuickBooks is too pricey; we own the financial system;
generate invoices from our own templates; keep logs in Excel; make it free") reverses
that. Recorded as **D-011** (own double-entry Accounting Core is the truth) and
**D-012** (own-template HTML→PDF invoices + Excel/CSV export, no paid service).

## 4. Target architecture (implemented)

```
WhatsApp / email / upload  ─┐
                            ▼
             Webhook & ingestion  (persist-then-enqueue, idempotent, signed)
                            ▼
                 source_events  ──►  Inngest durable queue  ──► dead-letter
                            ▼
        Financial Event Intelligence Layer
        (AI gateway → schema-validated extraction; missing-field detection;
         clarification; duplicate scoring; confidence; draft creation)
                            ▼
        Deterministic policy & approval engine  (thresholds, SoD, self-approval block)
                            ▼
        Accounting Core v0  (double-entry, fixed-precision, immutable posting,
        reversals, period lock, company isolation)  ──►  trial balance / P&L / BS
                            ▼
        Reconciliation · Reporting · (Forecasting, screens — next phases)
                            ▼
                 Append-only audit service (every step)
```

Model providers are reached **only** through `src/ai/gateway.ts` (D-006). The core
domain logic is pure and DB-independent, so accounting invariants, policy and
isolation rules are unit-tested against a golden dataset without infrastructure.

## 5. Can the codebase safely contain these modules?

Yes — one Next.js app with a clean internal boundary: `src/domain`, `src/schemas`,
`src/accounting`, `src/policy`, `src/events`, `src/ai`, `src/documents` are pure
(no I/O); `src/db`, `src/inngest`, `src/app/api` are the only I/O edges. No separate
service is needed for the pilot. Company isolation is a single testable key
(`company_id`) enforced by Postgres RLS (D-003).

## 6. Files & tables

New tables: full guide §5 data model across five migrations
(`src/db/migrations/0001`–`0005`), every financial table carrying `company_id`,
`status`, timestamps, `correlation_id`, and `idempotency_key` where it writes
externally. See `BUILD_STATUS.md` for the feature→file map.

## 7. Testing strategy (implemented)

Vitest, 57 tests: money precision, lifecycle transitions, accounting golden dataset
(TB/P&L/BS reconcile), policy + separation-of-duties, AI schema rejection,
missing-info + duplicate detection, reconciliation over-match prevention,
ingestion idempotency, and template/CSV/signature. DB-level RLS + isolation tests and
the live webhook run **after** Supabase/Meta configuration.

## 8. Rollback strategy

Migrations are additive and ordered; each can be dropped in reverse. No live data
exists yet. The webhook and AI transport are inert until env + external config are in
place, so the build is safe to merge without side effects. Feature-flag the consumer
pipeline when it lands.

## 9. Unanswered accounting/business decisions

Deferred to the owner + finance adviser (guide §18) — pilot legal entity, base
currency (assumed LKR), fiscal year, full chart of accounts, opening balances date,
tax codes/treatment, approval limits + auto-approval rules, receipt/missing-receipt
policy, advance/reimbursement rules, who may approve/post/reconcile/reverse/close,
bank statement formats, retention, monthly-close procedure. Tracked in
`docs/OPEN_QUESTIONS.md`. Until confirmed, the system produces **drafts and reports
only** and is not the statutory ledger.
