# Verification evidence — Production Security & Reliability Gate

> **Superseded for the current phase (2026-08-15).** The latest verification evidence is the
> **Phase 1 — 0048+ Security/Accounting Corrections** run (migrations **0048–0055**, WP10–WP18),
> recorded in **`docs/architecture-v3.1/PHASE1_CONSOLIDATION_REPORT.md`** (stamped with the final
> commit SHA, PostgreSQL 16.13, fresh + upgrade counts) and detailed per-WP in
> **`docs/architecture-v3.1/PHASE1_CORRECTIONS_LEDGER.md`**. The section below remains the record
> for the earlier correction gate (migrations 0044–0047). No hosted migration was applied and no
> feature flag was enabled in either phase.

---

**Date:** 2026-08-08 · **Commit:** `3489bcf` (correction WP1–WP9, migrations 0044–0047) · **Node:** v24 (CI uses 20)
**Database:** disposable local **PostgreSQL 16.14 (Homebrew)** — a throwaway cluster, NOT
production — with the Supabase-compatibility shim (`tests/integration/helpers/supabase-shim.sql`)
and **all 47 migrations (0001–0047)** applied via `npm run migrate`.

## Correction phase (CLAUDE_CORRECTION_BRIEF_0044) — WP1–WP9

- **WP1** nanoid → 3.3.18; audit-check keys on root-cause advisories (inngest-via-next is not a finding).
- **WP2** financial RPCs use an authenticated client even with RLS_WRITES off; posting needs
  finance.invoice.post/finance.bill.post/finance.payment.record (strict, no dept fallback);
  p_by mismatch rejected; worker posts as actor_type=system.
- **WP3/WP4 (0044)** canonical SHA-256 idempotency (operation+company+source+date+currency+
  memo+ordered lines); safe legacy null-hash upgrade; reimbursement source binding;
  invoice/bill lifecycle (only draft posts; header=line total).
- **WP5** outbox completion is a fenced 1-row update (0-row/error → ok:false + cron 5xx;
  counters reflect durable DB state); order + quotation replies routed through the outbox.
- **WP6 (0045)** supplier bank-detail maker-checker RPCs (RPC-only rows; maker≠checker; no bank numbers in audit).
- **WP7 (0046)** deny-by-default within_authority (is_unlimited flag; currency-matched;
  delegation bounded); transactional decide_approval RPC; approval_actions RPC-only.
- **WP8 (0047)** capability-gated remaining sensitive tables; every company_id table classified
  (`security/rls-classification.json`) with a coverage test; `RLS_WRITE_POLICY_MATRIX.md`.
- **WP9** truthful docs + this evidence.

**Upgrade path (mandatory):** staged a DB at migration **0043** with legacy data (null-hash
journal, unposted invoice, pending approval/outbox/supplier-bank-change), then migrated
**0044→0047 cleanly** (4 applied, 0 pending). The legacy null-hash journal's identical retry
**returns the same journal and upgrades its fingerprint** (`RETRY_RETURNS_SAME_JOURNAL`,
`fingerprint_upgraded=true`). A fresh-DB pass alone was not relied upon.

**Still open (honest):** approval division/project scope needs schema support
(`financial_events` carry no division/project); server actions return void (errors are
logged, not yet surfaced as typed UI failures); `RLS_READS`/`RLS_WRITES`/`WHATSAPP_ASYNC`
remain off pending staging UAT.

This is the evidence for the "Database/RLS tests: Not run" gap: the suite is now **run and green**.

**Clean-checkout reproducible:** run from a clean working tree (`git status` clean) — fresh
DB → shim → `npm run migrate` (47 applied) → `npm run test:integration` →
**22 files / 89 tests passed**. All fixes are committed, so any clean checkout reproduces
this (no locally-modified working tree required). `npm run audit-check` passes with only the
documented `next`/`postcss` root-cause advisories — packages merely *affected through* next
(e.g. `inngest`) are covered, not separate findings.

**Review follow-up included (0042/0043 + fixes):** full-payload idempotency; transactional
invoice/bill/reimbursement RPCs; self-service claims tied to the authenticated employee;
capability-gating of the remaining financial subledger tables; outbox completion fenced by
lease owner with surfaced errors and a 5xx on drain failure; audit-check keyed on root-cause
advisories. Still open (not in this evidence): an approval RPC enforcing amount/currency/
scope/lifecycle, and routing order/quotation replies through the outbox.

## Offline gate

| Check | Command | Result |
|---|---|---|
| Type check | `npm run typecheck` | **PASS** |
| Lint | `npm run lint` | **PASS** (pre-existing `<img>` warnings only) |
| Secret scan | `npm run secret-scan` | **PASS** (no tracked secrets) |
| Migration lint | `npm run migration-lint` | **PASS** — 47 migrations, sequential 0001–0047, no gaps/dupes |
| Dependency audit gate | `npm run audit-check` | **PASS** — only `next`/`postcss` (documented, reviewed exceptions) |
| Unit tests | `npm test` | **374 passed** |
| Production build | `npm run build` | **PASS** (placeholder public env) |

## Migrations

`npm run migrate` → **Applied 47 migration(s)**; `npm run migrate:status` → **applied: 47  pending: 0**.
Includes 0038–0047 (capability RLS, RPC hardening, durable messaging, ledger integrity, transactional finance, canonical idempotency, bank maker-checker, deny-by-default approvals, and the RLS write-policy matrix).

## Integration / RLS / adversarial / concurrency suite

`DATABASE_URL=<local-disposable> npm run test:integration` → **Test Files 22 passed · Tests 89 passed.**

| Test file | Tests | Proves |
|---|---|---|
| `authority-adversarial` | 10 | worker can't post/reverse a journal; sales/ordinary can't edit bills or approvals; manager isn't auto-granted finance; maker can't approve own request (SoD); approver can't exceed amount ceiling; cross-company write blocked; **suspended member loses access despite a legacy row**; delegate bounded by domain/date/amount and by the delegator's own authority; service-only tables reject authenticated writes; legitimate actions succeed |
| `accounting-rpc-hardening` | 11 | same key+amount → one journal/payment applied once; key+different amount → **conflict**; failed RPC doesn't consume the key; partial settlements can't exceed outstanding; caller without capability rejected; **actor can't be spoofed** (posted_by = auth.uid()); anonymous rejected; closed period rejected; failed settle is atomic; reversal idempotent; supplier payment capability-gated |
| `transactional-finance` | 5 | full-payload idempotency (same key + different lines → conflict); `post_customer_invoice` one-transaction + capability-gated + idempotent; invoice posting atomic (bad account leaves invoice untouched); `reimburse_expense_claim` lifecycle + separation-of-duties + idempotent; self-service expense claim only for the authenticated employee |
| `idempotency-lifecycle` | 5 | legacy null-hash upgrade + conflict; canonical fp binds date/currency/lines; settlement key binds source; one reimbursement key can't attach a 2nd claim; only a draft invoice posts |
| `posting-authority` | 3 | finance_reviewer can create but not post; accountant posts; suspended accountant can't; bill posting gated |
| `bank-maker-checker` | 4 | maker can't approve/edit/delete own; different checker approves + supplier updated; unauthorized staff can't; cross-company rejected; re-decide rejected |
| `approval-authority` | 5 | no rule → denied; unlimited → approved; above ceiling/wrong currency denied; maker can't approve own; re-decide rejected |
| `rls-matrix-coverage` | 2 | every company_id table classified; curated sensitive tables not left company_member |
| `finance-concurrency` | 2 | two live connections: 2nd invoice post and 2nd bank-change approval **block on `FOR UPDATE`** |
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
