# Current Implementation Status

_Rewritten 2026-08-07 directly from the codebase and observed test/build results — not by
appending to prior text. This file describes **reality**; where it disagrees with older
narrative docs, this file and the code win._

**Current phase:** Production Security & Reliability Gate —
`SINGHA_CLAUDE_PRODUCTION_SECURITY_RELIABILITY_BRIEF.md` (work packages A–F).
Prior phase (Production Control Foundation, WP0–WP6, migrations 0023–0037) is the baseline
this phase hardens.

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
- `npm run migration-lint` → **pass** (41 migrations, sequential 0001–0041).
- `npm run typecheck` → **pass**.
- `npm run lint` → **pass** (pre-existing `<img>` warnings only).
- `npm test` → **371 passing** (74 files).
- `npm run build` → **pass** (placeholder public env).
- `npm run audit-check` → **pass** (2 high findings, both approved exceptions: next, postcss).

**Not run locally (reported honestly):**
- `DATABASE_URL=… npm run test:integration` — **not run**: no non-production Postgres is
  available locally and production must not be used. These tests (existing suite + the new
  `authority-adversarial`, `accounting-rpc-hardening`, `rpc-concurrency`, `outbox-claim`)
  run in CI's `db-tests` job against a disposable Postgres. Status there: **not yet
  observed** (CI must run on push).
- Migrations 0038–0041 have **not** been applied to any hosted DB (see `MIGRATION_STATE.md`).

## Reconciliation with MIGRATION_STATE.md

`MIGRATION_STATE.md` is the authority on applied-state. 0001–0013 confirmed applied to
production (owner, 2026-08-05); 0014–0022 reported-applied-unverified; 0023–0037 applied to
the DB `gazjughejdzebathpscb`; **0038–0041 not applied to any environment**. No statement
here asserts a migration is applied merely because its file exists.

## Gated / not built (owner + legal/privacy approval required)

Live GPS tracking, CCTV ingestion, facial recognition, automated attendance discipline,
bank-transfer execution, autonomous legal/HR decisions, unrestricted customer-facing
autonomous agents, multi-country tax/payroll. See `docs/SECURITY_AND_PRIVACY_MODEL.md`.
