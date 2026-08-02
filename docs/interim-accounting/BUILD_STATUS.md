# Build status — Interim AI Finance System & Accounting Core v0

**As of 2026-07-30.** This tracks the guide (`Claude_Interim_Accounting_Development_Guide.md`)
feature-by-feature against what is actually in the repository. It answers the
question "is every feature in the guide implemented?" honestly.

**Legend:** ✅ built + unit-tested · 🟨 built as skeleton / needs config to activate ·
⏳ not yet built (next phases) · 🔒 gated (needs owner/legal decision).

Stop line requested by owner: **build up to the webhook integration point.** Everything
past that line is either config (yours) or the explicitly deferred next phase.

## Core engines (the "two permanent components" — guide §1)

| Guide ref | Feature | Status | Where |
|---|---|---|---|
| §11 money | Fixed-precision decimal money (no floats) | ✅ | `src/lib/money.ts` · `tests/money.test.ts` |
| §6 | Financial-event lifecycle state machine | ✅ | `src/domain/lifecycle.ts` · `tests/lifecycle.test.ts` |
| §7 | AI extraction contract (Zod, versioned) | ✅ | `src/schemas/ai-extraction.ts` · `tests/schema.test.ts` |
| §9 | Double-entry posting engine (balance, immutability, reversals, period lock, company isolation) | ✅ | `src/accounting/journal.ts` · `tests/accounting.test.ts` |
| §15 | Trial balance / P&L / balance sheet that reconcile (golden dataset) | ✅ | `src/accounting/trial-balance.ts` · `tests/accounting.test.ts` |
| §10, §18 | Deterministic policy + approval engine, thresholds, separation of duties, self-approval block | ✅ | `src/policy/authority.ts` · `tests/policy.test.ts` |
| §8 | Missing-field detection + clarification questions | ✅ | `src/events/intelligence.ts` · `tests/intelligence.test.ts` |
| §14 | Duplicate detection (idempotency + heuristic) | ✅ | `src/events/duplicate.ts`, `src/lib/ids.ts` · `tests/intelligence.test.ts`, `tests/ingest.test.ts` |
| §4 Phase 4 | Bank reconciliation matching + over-match prevention + re-import dedup | ✅ | `src/accounting/reconciliation.ts` · `tests/reconciliation.test.ts` |
| §9 #9 | Source-event ingestion: persist-then-enqueue, idempotent | ✅ | `src/events/source-event.ts` · `tests/ingest.test.ts` |
| §4 | AI model gateway (single module, schema-validated, cost ledger, injection fence) | 🟨 | `src/ai/gateway.ts`, `src/ai/prompts.ts` — logic done; **live OpenAI transport needs your key** |
| D-012 | Own-template invoice (HTML→free PDF) + Excel/CSV export | ✅ | `src/documents/templates.ts` · `tests/documents.test.ts` |

## Data model (guide §5)

| Group | Status | Where |
|---|---|---|
| Organization & access (companies, hierarchy, users, roles, permissions, access) + RLS | ✅ | `src/db/migrations/0001_org_and_access.sql` |
| Accounting foundation (fiscal years, periods, CoA, journals+lines, currencies, tax) + immutability triggers | ✅ | `0002_accounting_core.sql` |
| Parties & subledgers (customers, suppliers, invoices, bills, payments, advances, reimbursements, loans) | ✅ | `0003_subledgers.sql` |
| Intelligence & evidence (source_events, financial_events + versions, documents, ai_runs, approvals, **append-only audit**) | ✅ | `0004_intelligence_and_evidence.sql` |
| Banking & planning (bank/cash accounts, imports, reconciliation, budgets, commitments, forecasts) | ✅ | `0005_banking_and_planning.sql` |

Every financial table carries `company_id`, `status`, timestamps, `correlation_id`
and (for external writes) `idempotency_key`, per guide §5. Migrations are **written
but not yet run** — running them is a config step (needs your Supabase project).

## The webhook boundary (the agreed stop line — guide §4 "webhook & event-ingestion")

| Feature | Status | Where |
|---|---|---|
| WhatsApp webhook: challenge verify + **signature hard-reject** (D-007) + persist-then-enqueue | 🟨 | `src/app/api/webhooks/whatsapp/route.ts` — code complete; **activates after you configure Meta + env** |
| Email ingestion webhook | 🟨 stub | `src/app/api/webhooks/email/route.ts` — provider + secret is your choice |
| Inngest durable queue + serve endpoint | 🟨 | `src/inngest/*`, `src/app/api/inngest/route.ts` — needs Inngest keys |
| Inngest consumer (AI extract → draft → policy → approval queue) | ⏳ next phase | `src/inngest/functions.ts` — documented skeleton; the pure logic it calls is already built + tested |

## Not yet built — the next phases (guide §3 Phases 5–6, §11)

⏳ Finance dashboard & 18 screens (§11) · ⏳ the 22 reports UI (§12; the underlying
math for TB/P&L/BS/reconciliation exists) · ⏳ forecasting scenarios engine (§6) ·
⏳ full approval→posting Inngest wiring (§17 Prompt D) · ⏳ OCR pipeline for uploaded
receipts.

## Gated — do not build without owner/legal sign-off (CLAUDE.md)

🔒 GPS · 🔒 CCTV · 🔒 customer-facing AI agents · 🔒 Agent Builder · 🔒 multi-country.
None are touched.

## Verification run 2026-07-30

- `npm test` → **57 passed** (9 files): money, lifecycle, accounting golden dataset,
  policy + SoD, AI schema, intelligence, reconciliation, ingest/idempotency, documents.
- `npx tsc --noEmit` → **clean (exit 0)**.
- DB/RLS/isolation tests and the live webhook end-to-end are **not run** — they need a
  provisioned Supabase project + Meta app (your configuration steps). See
  `CONFIGURATION_GUIDE.md`.
