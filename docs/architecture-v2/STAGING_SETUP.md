# Staging Setup Runbook

> Purpose: make the two blockers **one-and-done** so the DB/Inngest/CI-gated half of the
> Production Control Foundation (RLS cutover + live isolation, transactional posting,
> async webhook + workers, CI gates) can be built **and honestly verified**. Nothing
> here touches production. Do these in order.

## 0. Unblock local lint (§WP6.6)

The maintainer's npm cache is root-owned, so `npm install` fails (`EACCES`). Fix once:

```
sudo chown -R 501:20 ~/.npm
npm install -D eslint@^8 eslint-config-next@^14   # declares ESLint in the lockfile
npm run lint
```

After this, CI can run lint from the lockfile instead of the `--no-save` hack.

## 1. Provision a throwaway (non-prod) Postgres/Supabase

Use a **separate** Supabase project (or any Postgres) — **never** the live Singha
project. This is where isolation/RLS/concurrency tests create + drop test companies.

- Copy its connection string. Export it as `DATABASE_URL` for the test run.
- The isolation tests **refuse to run** against the known prod ref
  (`juwpzzkuyqygcjrubqpt`) as a safety guard.

## 2. Apply migrations 0001 → 0029 (in order)

Canonical source: `src/db/migrations/0001_*.sql` … `0029_*.sql`. Apply them in
numeric order to the staging DB (Supabase SQL editor, `psql`, or your migration tool).
All of 0023–0029 are additive/idempotent (safe to re-run). Record what you applied in
`MIGRATION_STATE.md`.

> Do **not** use the aggregate `RUN_*` copies under `docs/architecture-v2/` — they can
> drift; the numbered files in `src/db/migrations/` are the one source of truth.

## 3. Run the live isolation tests (§WP1)

```
DATABASE_URL="postgres://…non-prod…" npm run test:integration
```

These are skipped without `DATABASE_URL`. They seed two companies + memberships and
assert cross-company reads/updates/inserts are blocked and a suspended membership loses
access. Green here is the prerequisite for the service-role → RLS cutover.

## 4. Environment variables (staging)

| Var | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | live isolation tests | **non-prod only** |
| `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | app | staging project |
| `OPENAI_PRICE_GPT56_INPUT_PER_MTOK`, `OPENAI_PRICE_GPT56_OUTPUT_PER_MTOK` | real AI cost (§WP5.4) | confirmed OpenAI rates; else cost records 0 |
| `CRON_SECRET` | daily digest auth (§WP6.1) | mandatory — endpoint fails closed without it |
| `WHATSAPP_*` | webhook + sender | staging number, not the prod one |
| `WHATSAPP_ASYNC` + `INNGEST_*` | §WP4 async webhook (persist→enqueue→200; durable worker sends) | set `WHATSAPP_ASYNC=on` only after Inngest keys are configured; default off = synchronous reply |

## 4b. Validate the RLS read cutover (§WP1)

61 department **read** pages now use `supabaseReadClient()`, which is service-role by
default and the authenticated **RLS** client when `RLS_READS=on`. To validate the
cutover on staging:

1. Set `RLS_READS=on` in the staging environment.
2. Log in as a **non-admin** user and as an **admin**; confirm each department page
   shows the same company-scoped data it did before (RLS returns the same rows).
3. Confirm a user from another company cannot see this company's data (the live
   isolation tests already prove this at the DB; this is the app-level confirmation).
4. When green, make `RLS_READS=on` the default in production.
5. **Write cutover:** 25 action groups (domain CRUD + finance) use `supabaseWriteClient()` (flag `RLS_WRITES=on`). Migration 0034 added company-scoped write policies so a user can only write their own company's rows (live-verified in `tests/integration/write-isolation.test.ts`). Validate with `RLS_WRITES=on` on staging, then default it on. Ledger posting uses SECURITY DEFINER RPCs (migration 0035). Identity, admin, hr, task, worker and the `approvals` action (writes approval_* tables, which need write policies before flag-on) stay service-role.

Not yet cut over (kept on service role deliberately): `admin/*` (cross-cutting admin
tools) and `hr/*` (profile-listing pages, which behave differently under the
`profiles_self` policy). Those are later, separately-validated slices. Writes (server
actions) remain on the explicit service-role client for now.

## 5. Then the DB-gated work can proceed (owner-approved, per WP order)

1. **WP1** service-role→RLS cutover, page-group by page-group, each re-running §3.
2. **WP2** transactional document-posting functions (posting + source-doc link + audit +
   idempotency key in ONE transaction), `REVOKE/GRANT`, concurrency/idempotency tests.
3. **WP4** async webhook enqueue + the running outbox/dead-letter sender worker (Inngest).
4. **WP6** CI gates: lint from lockfile, migration-up test on a temp DB, the integration
   suite, secret scanning, dependency-audit with an approved exception process.

Each remains a separate, reviewed step; none deploys to prod or touches prod data
without explicit owner approval (Constitution §15).
