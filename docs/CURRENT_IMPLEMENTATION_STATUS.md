# Current Implementation Status

_Rewritten 2026-08-06 (WP0) directly from the codebase and observed test/build results,
not by appending to prior text. This file describes **reality**; where it disagrees with
older narrative docs, this file and the code win._

**Current approved phase:** Production Control Foundation —
`docs/architecture-v2/NEXT_PHASE_DEVELOPER_BRIEF.md` (WP0–WP6, in order).
**Target architecture:** `docs/architecture-v2/CHANGE_PLAN.md` +
`docs/architecture-v2/Singha_AI_Management_Architecture_V2.puml`.

## How to read status (evidence-based — no percentages)

- **not started** — no code.
- **foundation** — code/tables exist but additive only; not cut over, not enforced, or
  not wired end-to-end.
- **implemented** — code complete and passing unit tests; runs in the app.
- **verified in staging** — proven against a real database/staging environment
  (integration/RLS/concurrency tests), not just mocked unit tests.
- **production approved** — owner has approved it for production.

> Nothing in this repository is **verified in staging** or **production approved** under
> the definitions above yet: there is currently no staging database and no live
> integration/RLS test suite. Establishing those is the point of this phase (WP1/WP6).

## Accounting source of truth

The internally-owned double-entry **Accounting Core** (`src/accounting/*`) is the sole
accounting source of truth. **QuickBooks is NOT used** (DECISIONS D-011);
`docs/QUICKBOOKS_INTEGRATION_MODEL.md` is archived. Any instruction naming QuickBooks as
a source of truth or a posting target is void.

## What exists today

| Area | Status | Location |
|---|---|---|
| Next.js app shell, Supabase auth, middleware session gate | implemented | `src/app`, `src/middleware.ts` |
| Department areas (admin, sales, finance, ops, hr, legal, fleet, procurement, marketing, command, me, messages, notifications) | implemented | `src/app/app/*` |
| Company-wide customer Messages inbox | implemented | `src/app/app/messages/*` |
| WhatsApp Cloud API quotation flow (live, official API, **synchronous** reply) | implemented | `src/app/api/webhooks/whatsapp`, `src/lib/order-intake.ts`, `src/lib/quotations.ts` |
| Double-entry Accounting Core (journal, trial balance, P&L, balance sheet, reconciliation) | implemented (unit-tested) | `src/accounting/*` |
| Atomic journal / settlement / reversal RPCs | implemented (migrations 0015/0016) | `src/db/migrations/0015*`, `0016*` |
| Finance modules (invoices, bills, payments, ageing, forecast, loans, periods, tax, petty cash, expenses) | implemented | `src/app/app/finance/*`, `src/modules/finance/*` |
| Department modules (CRM/sales, procurement/RFQ/inventory, legal, fleet, HR, marketing, objectives) | implemented | `src/app/app/*`, `src/modules/*` |
| Event ingestion, dedup, source-event store, Inngest processing pipeline | foundation | `src/events/*`, `src/db/source-event-store.ts`, `src/inngest/*` |
| Message outbox (table + pure send logic) | foundation (not wired to live WhatsApp) | `src/events/outbox.ts`, migration 0011 |
| AI gateway + Zod-validated extraction/quotation/observation | implemented | `src/ai/*`, `src/schemas/*` |
| AI manager: observation → plan pipeline (captures low-risk tasks; never executes) | implemented | `src/ai/manager-observation.ts`, `src/management/*` |
| Authority / approval policy + decision router (never-autonomous list) | implemented (unit-tested) | `src/policy/authority.ts`, `src/management/policy/route-decision.ts` |
| Audit trail (append-only) + audit log UI + exports | foundation (best-effort writes) | `src/lib/audit.ts`, `src/app/app/admin/audit` |
| Security headers, CSP, CSPRNG quote tokens | implemented | `next.config.mjs`, `src/lib/quotations.ts` |
| Identity/membership model (memberships, org units, roles, authority rules, delegations) | foundation (additive; **app still reads legacy `profiles`/`department`/`is_admin`**) | migration 0010, `IDENTITY_UNIFICATION_PLAN.md` |
| CI workflow (typecheck/lint/test/build/migration-order) | foundation (see CI notes below) | `.github/workflows/ci.yml` |
| Scheduled daily digest (Vercel Cron) | implemented (see CRON gap below) | `src/app/api/cron/daily-digest/route.ts` |

## Observed test / build / CI status (2026-08-06, after Production Control Foundation work)

- `npm run typecheck` → **passes** (exit 0).
- `npm test` → **362 passing, 4 skipped** (73 files; the 4 skipped are the live
  two-company isolation tests, gated on a non-prod `DATABASE_URL`). Everything else is
  pure/unit — no live DB, RLS, or concurrency tests run yet (that needs a staging DB).
- `npm run build` → passes with placeholder public env.
- `npm run lint` → **fails locally**: ESLint is **not declared** in `package.json` /
  lockfile. CI installs it ad-hoc with `npm i --no-save eslint@^8 eslint-config-next@^14`.
  (WP6 fixes this — declare ESLint and run from the lockfile.)
- `npm run build` → not run in this pass; CI runs it with placeholder public env
  (`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
- Dependency audit → not yet triaged (WP6).

## Known limitations (code-cited; these are exactly what WP1–WP6 address)

**Identity & company isolation (WP1)**
- ~120 files construct the Supabase **service-role** client, which bypasses RLS;
  company isolation depends on every query remembering a manual `company_id` filter.
- The membership/role/authority model (migration 0010) is additive only; access is still
  decided by legacy `profiles.is_admin` / `department` string checks.
- No live database tests prove one company cannot read/mutate another company's data.

**Accounting, approvals, idempotency, audit (WP2)**
- Settlement/reversal RPCs lack caller-supplied idempotency keys and strong concurrency
  locking; reconciliation trusts browser-submitted target IDs/amounts.
- Several finance server actions use JavaScript `Number` for money (should be
  `decimal.js` / Postgres numeric).
- Audit writes are best-effort and not consistently in the same transaction as the
  sensitive mutation (can be silently ignored).
- Finance permissions collapse to admin/finance-department checks; authority limits and
  approval thresholds are not consistently enforced.

**Staff progress & capacity (WP3)**
- Task detail/update actions are restricted to Operations/admin; an assignee in another
  department can see but not fully action their task. No worker accept/estimate/blocker/
  extension/actual-hours/verification-request flow. Capacity is estimate-hours based, not
  schedule/leave/actuals based.

**Messaging & integrations (WP4)**
- The live WhatsApp webhook does AI/order processing and outbound replies **synchronously
  inside the request** (owner instruction 2026-08-04). Inngest + outbox exist but are not
  on the live path. Email route is a `501` stub (`src/app/api/webhooks/email/route.ts`).

**AI manager & cost (WP5)**
- Model route `gpt-5.6-sol` has **no price in the cost table** (`src/ai/openai-transport.ts`
  has a `TODO(pricing)`), so recorded AI cost can be zero. All routes use the same model.
  No durable per-analysis observation/decision record yet.

**Reliability, health, CI (WP6)**
- `daily-digest` **fails open** when `CRON_SECRET` is absent (auth check is skipped —
  `route.ts:27`). Health screens can render DB errors as zero counts. ESLint not in the
  lockfile. Dependency audit untriaged.

## Production Control Foundation — progress (WP0–WP6)

Evidence-based status. **"foundation"** = code + unit tests exist and it is deploy-safe,
but the enforcing/execution half needs the staging DB / Inngest / CI. Nothing below is
**verified in staging** yet (no staging DB). Migrations 0023–0029 are additive and **not
yet applied anywhere** (see `MIGRATION_STATE.md`).

- **WP0 documentation reset** — implemented. Brief in-repo, single precedence, QuickBooks
  superseded, this file + `MIGRATION_STATE.md`.
- **WP1 identity/RLS** — foundation. Migration `0023` (membership-based
  `has_company_access`/`has_capability`, write RLS, seeded role→permission), `0024`
  (composite company FKs), central helpers `src/lib/access.ts`, pure `canActOnTask` +
  delegation authority engine, gated live isolation tests. **Not done:** the
  service-role→RLS cutover of ~120 files + running the live isolation tests (staging DB).
- **WP2 accounting controls** — foundation. Decimal-money everywhere (no JS floats),
  audit fail-closed (`writeAuditStrict`), server-side reconciliation validation, caller
  idempotency for settlements (`0026`), expense self-approval SoD + dup-prevention,
  supplier bank-detail maker/checker (`0029`). **Not done:** posting+audit+key atomic in
  one DB transaction, `REVOKE/GRANT`, concurrency tests.
- **WP3 staff progress** — implemented (pending `0025`). Worker workflow engine + rich
  capacity (planned/actual/remaining/free/blocked/overdue), worker/manager actions, task
  Progress UI, capacity view, follow-up/escalation engine.
- **WP4 durable WhatsApp** — foundation. Webhook is now **persist-first** (raw event
  stored before processing) + signature-verified + deduped; approved template registry,
  retry/backoff/dead-letter + replay logic, admin outbox/replay view. **Not done:** async
  Inngest enqueue + the running sender/dead-letter worker.
- **WP5 AI manager loop** — implemented (pending `0027`/`0028`). Cost recorded for all
  manager analysis, `gpt-5.6-sol` price env-configurable, logical model routes, durable
  management cases persisted + admin view, correlation trail, prompt-injection +
  extraction/uncertainty/authority-routing eval datasets.
- **WP6 reliability** — foundation. `CRON_SECRET` fail-closed + no info leak, structured
  logging + redaction adopted, metric unavailable-vs-zero, health §6.3, ranked alerts +
  ledger-integrity check. **Not done:** ESLint in the lockfile (blocked by a root-owned
  `~/.npm` cache), migration/RLS/integration CI gates, dependency-audit triage.

## Migrations

Canonical migrations are `src/db/migrations/0001*`…`0029*` (one source of truth;
0023–0029 added during the Production Control Foundation work, all additive/idempotent).
**Applied state per environment is tracked separately in
`docs/architecture-v2/MIGRATION_STATE.md`** — do not infer "applied" from file existence.
Summary: 0001–0013 confirmed applied to production (owner, 2026-08-05); 0014–0022 are
**reported applied but unverified**; no staging DB is confirmed to exist.

## Gated / not built (owner + legal/privacy approval required)

Live GPS tracking, CCTV ingestion, facial recognition, automated attendance discipline,
bank-transfer execution, autonomous legal/HR decisions, unrestricted customer-facing
autonomous agents, multi-country tax/payroll, and any bot that trains/deploys other bots.
See `docs/SECURITY_AND_PRIVACY_MODEL.md` and NEXT_PHASE_DEVELOPER_BRIEF §4.

## Open conflict on record

Change plan §5.6 wants an asynchronous, persist-first WhatsApp webhook; the owner
instruction (2026-08-04) required a synchronous reply. WP4 resolves this to persist-first
async — it needs an explicit owner go-ahead to override the 2026-08-04 instruction.
