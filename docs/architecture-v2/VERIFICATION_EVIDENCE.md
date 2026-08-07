# Verification evidence — Production Security & Reliability Gate

**Date:** 2026-08-07 · **Commit:** `bf8a7c6` (+ shim `auth.users` fix) · **Node:** v24 (CI uses 20)
**Database:** disposable local **PostgreSQL 16.14 (Homebrew)** — a throwaway cluster, NOT
production — with the Supabase-compatibility shim (`tests/integration/helpers/supabase-shim.sql`)
and **all 41 migrations (0001–0041)** applied via `npm run migrate`.

This is the evidence for the "Database/RLS tests: Not run" gap: the suite is now **run and green**.

## Offline gate

| Check | Command | Result |
|---|---|---|
| Type check | `npm run typecheck` | **PASS** |
| Lint | `npm run lint` | **PASS** (pre-existing `<img>` warnings only) |
| Secret scan | `npm run secret-scan` | **PASS** (no tracked secrets) |
| Migration lint | `npm run migration-lint` | **PASS** — 41 migrations, sequential 0001–0041, no gaps/dupes |
| Dependency audit gate | `npm run audit-check` | **PASS** — only `next`/`postcss` (documented, reviewed exceptions) |
| Unit tests | `npm test` | **371 passed** |
| Production build | `npm run build` | **PASS** (placeholder public env) |

## Migrations

`npm run migrate` → **Applied 41 migration(s)**; `npm run migrate:status` → **applied: 41  pending: 0**.
Includes the new 0038–0041 (capability RLS, RPC hardening, durable messaging, ledger integrity).

## Integration / RLS / adversarial / concurrency suite

`DATABASE_URL=<local-disposable> npm run test:integration` → **Test Files 15 passed · Tests 63 passed.**

| Test file | Tests | Proves |
|---|---|---|
| `authority-adversarial` | 10 | worker can't post/reverse a journal; sales/ordinary can't edit bills or approvals; manager isn't auto-granted finance; maker can't approve own request (SoD); approver can't exceed amount ceiling; cross-company write blocked; **suspended member loses access despite a legacy row**; delegate bounded by domain/date/amount and by the delegator's own authority; service-only tables reject authenticated writes; legitimate actions succeed |
| `accounting-rpc-hardening` | 11 | same key+amount → one journal/payment applied once; key+different amount → **conflict**; failed RPC doesn't consume the key; partial settlements can't exceed outstanding; caller without capability rejected; **actor can't be spoofed** (posted_by = auth.uid()); anonymous rejected; closed period rejected; failed settle is atomic; reversal idempotent; supplier payment capability-gated |
| `concurrency` | 1 | two live connections: 2nd settlement **blocks on `FOR UPDATE`** |
| `rpc-concurrency` | 1 | two live connections: 2nd reversal **blocks on `FOR UPDATE`** |
| `outbox-claim` | 4 | atomic leased claim is disjoint across workers; lease recovery; dead-letter never re-claimed |
| `company-isolation` | 5 | A can't read/update B; can't insert membership into B; suspended loses access |
| `capability-rls` | 3 | `has_capability` reflects role grants; identity + task writes are capability-gated |
| `posting-hardening` | 3 | idempotent posting + in-transaction `journal.posted` audit |
| `settlement` | 6 | settle-within-outstanding, overpayment/negative rejected, idempotent reversal |
| `write-cutover-broad` | 3 | sensitive writes capability-gated (own vs cross-company vs no-capability); approvals append-only |
| `write-isolation` | 3 | own-company write allowed, cross-company blocked |
| `rls-coverage` | 3 | every company-scoped table has RLS + a read policy |
| `accounting-posting` | 5 | balanced posts; unbalanced/unknown-account/single-line/closed-period rejected |
| `db-controls` | 3 | idempotency-key uniqueness; composite company FK; management case schema |
| `outbox` | 2 | outbox delivery/enqueue behaviour |

## How to reproduce (any non-production Postgres)

```bash
# 1. a throwaway Postgres (Docker example)
docker run -d --name singha-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=singha_test -p 5433:5432 postgres:16
export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/singha_test" PGSSL=disable
# 2. Supabase-compat shim, then migrations, then the suite
node scripts/apply-sql.mjs tests/integration/helpers/supabase-shim.sql
npm run migrate
npm run test:integration
```

The same suite runs in CI's `db-tests` job (GitHub Actions) against a disposable Postgres
service once Actions is unblocked; the shim fix here makes it pass there too.
