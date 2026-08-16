# Current Implementation Status

_Rewritten 2026-08-07 directly from the codebase and observed test/build results — not by
appending to prior text. This file describes **reality**; where it disagrees with older
narrative docs, this file and the code win._

**Current phase:** **Phase 1 — 0048+ Security/Accounting Corrections** (WP10–WP18), migrations
**0048–0060**. Status: **implemented and verified on a disposable PostgreSQL 16 (fresh + upgrade);
CHANGES REQUESTED by two external reviews, corrected, and AWAITING THE FINAL REVIEW.** Not merged,
not deployed, hosted DB not migrated, all feature flags OFF. The corrections (first review: migrations
0056–0058; second review: WP12 outbox reconciliation + WP11 composite FKs/money fail-close + WP15
function-privilege, migrations 0059–0060) live on the integration branch
`feature/v3-1-phase-1-external-review-fixes` (PR #3 foundation + stack PRs #4–#12 + both correction
rounds, one draft PR against `main`). Verified counts: **unit 410 (78 files); integration 34 files /
180 tests.** See `docs/architecture-v3.1/PHASE1_CONSOLIDATION_REPORT.md` and
`PHASE1_CORRECTIONS_LEDGER.md`; authoritative applied-state: `docs/architecture-v2/MIGRATION_STATE.md`.
**Do not begin V3.1 Phase 2 until the owner approves the final review.**

Prior phases: Production Security & Reliability Gate
(`SINGHA_CLAUDE_PRODUCTION_SECURITY_RELIABILITY_BRIEF.md`, WP A–F, migrations 0038–0047) and the
Production Control Foundation (WP0–WP6, migrations 0023–0037) are the baseline this phase corrects.

## How to read status (evidence-based — no percentages)

- **not started** — no code.
- **foundation** — code/migrations exist but additive only; not cut over, not enforced end-to-end.
- **implemented** — code complete, passing unit tests, and safe to deploy behind its flag.
- **verified in staging** — proven against a real non-production database (integration/RLS/
  concurrency tests) in a staging environment.
- **production approved** — owner has approved it for production.

> **Nothing here is "verified in staging" or "production approved" yet.** There is no
> confirmed non-production staging database, and `RLS_READS` / `RLS_WRITES` /
> `WHATSAPP_ASYNC` are **OFF** in every environment. The DB-layer work is proven by
> automated integration tests **in CI against a disposable Postgres** (see below), which is
> the evidence gate before a staging flip.

## Accounting source of truth

The internally-owned double-entry **Accounting Core** (`src/accounting/*`) + the SECURITY
DEFINER posting RPCs are the sole accounting source of truth. **QuickBooks is NOT used**
(DECISIONS D-011).

## Feature-flag state (authoritative)

| Flag | Local | CI | Staging | Production |
|---|---|---|---|---|
| `RLS_READS` | off | off | off | off |
| `RLS_WRITES` | off | off | off | off |
| `WHATSAPP_ASYNC` | off | off | off | off |

Default OFF = **zero behaviour change**: reads/writes use the service-role client and the
legacy department/admin checks. See `docs/architecture-v2/RLS_CUTOVER_PLAN.md`.

## Correction phase — migrations 0044–0047 (CLAUDE_CORRECTION_BRIEF_0044)

Implemented + verified on a disposable Postgres 16 (incl. an upgrade path from a 0043 DB with legacy data): posting via authenticated RPC + strict capabilities; canonical SHA-256 idempotency with safe legacy upgrade; invoice/bill lifecycle; supplier bank-detail maker-checker RPCs; deny-by-default authority + transactional approval RPC; complete RLS write-policy matrix with a coverage test; nanoid patched. Migrations 0044–0047 are NOT yet applied to any hosted DB (owner action). See `VERIFICATION_EVIDENCE.md` + `RLS_WRITE_POLICY_MATRIX.md`.

## Production Security & Reliability Gate — status by work package

- **WP A — DB authority & capability RLS** — implemented (not verified in staging).
  Migration `0038`: domain-qualified capability vocabulary, least-privilege role map,
  suspension-safe `has_company_access`, delegation-aware `has_capability` + authority
  ceilings, capability-gated write policies on sensitive tables, service-only table
  lockdown, approval separation-of-duties in RLS. Adversarial proofs:
  `tests/integration/authority-adversarial.test.ts`. **Not done:** applied to staging;
  the per-page service-role→RLS flip (inventoried in `SERVICE_ROLE_INVENTORY.md`).

- **WP B — Accounting RPC hardening** — implemented (not verified in staging).
  Migration `0039`: reject anonymous callers; actor derived from `auth.uid()` (no
  spoofing via `p_by`); per-operation capability required; a shared internal poster so
  settlement/reversal need their own capability (not `finance.journal.post`);
  transactional idempotency (same key+amount → same journal, applied once; key+different
  amount → conflict; failure never consumes the key); narrowed `unique_violation`; in-RPC
  fail-closed audit; `FOR UPDATE` locks. Tests: `accounting-rpc-hardening.test.ts`,
  `rpc-concurrency.test.ts`. App actions pass idempotency keys and dropped the fragile
  pre-claim (`idempotency-store.ts` is now dead — flagged for removal).

- **WP C — Durable WhatsApp & outbox** — implemented (not verified in staging; flag off).
  Migration `0040`: outbox lease columns + `claim_outbox_batch` (`FOR UPDATE SKIP LOCKED`)
  with expired-lease recovery and dead-letter; `wa_messages.handled_at` resume-safety.
  Fail-safe webhook (persist-first; retryable 503 on persist/enqueue failure; 200 only
  after durable acceptance). Shared `drainOutbox` worker used by the cron route and the
  Inngest sweep. Order-intake dedups on **completion**, not on the inbound row. Inngest
  schedules (outbox sweep ~2m, follow-ups 15m, AI monitor 10m, digest daily, health 30m)
  replace the once-daily heartbeat for time-sensitive work. Tests: `outbox-claim.test.ts`.
  **Not done:** flip `WHATSAPP_ASYNC` after staging validation.

- **WP D — Identity & service-role cutover** — foundation.
  Central `requireFinanceAccess()` capability gate (grants on capability; denies suspended;
  legacy finance-dept fallback during rollout); finance money-path actions migrated off raw
  department strings. Full inventory + plan: `SERVICE_ROLE_INVENTORY.md`,
  `RLS_CUTOVER_PLAN.md` (role UAT matrix). **Not done:** the staged per-page flip and
  staging role UAT (gated on `RLS_READS`/`RLS_WRITES`).

- **WP E — Audit, observability & health** — implemented.
  Financial mutations now write transaction-bound audit **inside** the RPC (with
  `idempotency_key`); audit stays append-only (trigger + `authenticated` DML revoked).
  `/api/health` aggregates outbox pending/oldest/failed/dead, source-event failed/
  unprocessed, dead-letters, unanalysed conversations, ledger integrity (migration `0041`)
  and missing config, distinguishing **zero from unavailable**. Alerts carry
  severity/owner/runbook/first-seen/last-seen (`RUNBOOKS.md`). Tests: `health-signals.test.ts`.

- **WP F — CI, dependency security & deployment controls** — implemented.
  CI has two required jobs: `verify` (secret-scan, migration-lint, typecheck, lint, unit,
  build, dependency-audit gate) and `db-tests` (disposable Postgres + Supabase-compat shim
  + migrations + all integration/RLS/concurrency tests) that **fails loud, never skips**.
  `audit-check` fails on any un-approved/expired high/critical (`DEPENDENCY_SECURITY.md`);
  `brace-expansion` fixed; `next`/`postcss` reviewed exceptions. Production config
  fail-fast via `src/instrumentation.ts`. Gates: `DEPLOYMENT_GATES.md`.

## Verification evidence (2026-08-07, local, this machine)

Commands run and results:
- `npm run secret-scan` → **pass** (no tracked secrets).
- `npm run migration-lint` → **pass** (47 migrations, sequential 0001–0047).
- `npm run typecheck` → **pass**.
- `npm run lint` → **pass** (pre-existing `<img>` warnings only).
- `npm test` → **374 passing** (74 files) + 22 integration files / 89 tests on disposable Postgres 16.
- `npm run build` → **pass** (placeholder public env).
- `npm run audit-check` → **pass** (2 high findings, both approved exceptions: next, postcss).

**Database tests (now run):**
- `DATABASE_URL=<disposable Postgres 16> npm run test:integration` → **22 files / 89 tests pass**,
  including adversarial RLS, accounting-RPC hardening, canonical idempotency + lifecycle,
  bank maker-checker, approval authority, RLS-matrix coverage, and two-connection concurrency
  (settlement, reversal, invoice post, bank approval). Verified from a clean checkout AND via
  the 0043→0047 upgrade path with legacy data. The same suite runs in CI's `db-tests` job.
- Migrations **0038–0043** were applied by the owner to the live DB; **0044–0047** are NOT yet
  applied to any hosted DB (owner action — see `MIGRATION_STATE.md`).

## Reconciliation with MIGRATION_STATE.md

`MIGRATION_STATE.md` is the authority on applied-state. 0001–0013 confirmed applied to
production (owner, 2026-08-05); 0014–0022 reported-applied-unverified; 0023–0043 applied by owner to
the DB `gazjughejdzebathpscb`; **0038–0041 not applied to any environment**. No statement
here asserts a migration is applied merely because its file exists.

## Gated / not built (owner + legal/privacy approval required)

Live GPS tracking, CCTV ingestion, facial recognition, automated attendance discipline,
bank-transfer execution, autonomous legal/HR decisions, unrestricted customer-facing
autonomous agents, multi-country tax/payroll. See `docs/SECURITY_AND_PRIVACY_MODEL.md`.
