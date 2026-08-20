# Current Implementation Status

_Rewritten 2026-08-07 directly from the codebase and observed test/build results — not by
appending to prior text. This file describes **reality**; where it disagrees with older
narrative docs, this file and the code win._

**Current phase (updated 2026-08-17):** the **owner-authorized COMPLETION PROGRAM** — finishing the
application + V3.1 implementation as small stacked draft PRs on top of PR #13's reviewed head
`48407bd` (PR #13 itself is frozen). Live program state, verification-state taxonomy
(implemented+locally-verified / preview-deployed / staging-verified / production-verified /
deliberately-deferred), and outstanding owner gates: `docs/architecture-v3.1/COMPLETION_LEDGER.md`.
Machine-checkable inventory (service-role usage, money-as-Number suspects, flags without consumers,
TODOs/stubs, error-masking suspects): `docs/architecture-v3.1/COMPLETION_INVENTORY.md`
(`npm run inventory`). The completed prior phase remains as described below:

**Prior phase:** **Phase 1 — 0048+ Security/Accounting Corrections** (WP10–WP18), migrations
**0048–0067**. Status: **implemented and verified on a disposable PostgreSQL 16 (fresh + upgrade);
CHANGES REQUESTED by ten external reviews, corrected within the two permitted bounded loops, and
AWAITING THE FINAL OWNER/EXTERNAL APPROVAL.** Not merged,
not deployed, **hosted DB not migrated** (this — not any flag — is what keeps the changes off the live
system), all feature flags OFF. The corrections (first review: migrations 0056–0058; second review:
WP12 outbox reconciliation + WP11 composite FKs/money fail-close + WP15 function-privilege, migrations
0059–0060; third review: concurrency-safe `refreshQuotationStatus`, sent-outbox reconcile-or-
fail-closed, currency **catalogue** validation, a concurrency test through the **production enqueue
RPC**, and doc-accuracy incl. removing the "inert because flags OFF" claim — migration 0061; fourth
(security-boundary) review: **migration 0062** locks every service-only SECURITY DEFINER function
(`_journal_post_internal` incl. its legacy signature, `claim_outbox_batch`, `complete_outbox_and_advance`,
`ledger_integrity_report`, and the outbox/fingerprint helpers) to `service_role`, with an allowlist
test over ALL such functions, plus a prepared-but-unexecuted hosted privilege check + emergency REVOKE
hotfix for the already-hosted 0038–0041 functions; fifth (final) review: the fourth review's
application re-read still left a time-of-check/time-of-use window, so **migration 0063** adds an
**atomic** service-only `enqueue_quotation_outbox` RPC that LOCKS the quotation row and — only if still
legally `ready` and the body's total/currency still match — inserts the outbox row AND advances
ready→queued in ONE transaction (the enqueue race is closed at the database, not by an app re-read),
with a DB-boundary quotation-lifecycle trigger, a **signature-exact** SECURITY DEFINER allowlist, and a
self-verifying (abort-on-residual) emergency hotfix; sixth review: **migration 0064** makes the
privileged delivery transitions (`ready→queued`/`queued→sent`/`ready→sent`) **RPC-only** — the
SECURITY INVOKER lifecycle trigger refuses them when `current_user` is a PostgREST API role, so a
direct table UPDATE by an authenticated user (with `sales.quotation.manage`) or `service_role` cannot
bypass the atomic/fenced delivery RPCs — and hardens `enqueue_quotation_outbox`'s ready+existing-row
recovery to require an EXACT delivery-identity+payload match (else `inconsistent`, so a stale row is
never queued/drained); seventh review: **migration 0065** closes two residual boundary gaps — the
scheduled drain `claim_outbox_batch` is now **quotation-aware** (a quotation-delivery outbox row is
claimable ONLY when its linked quotation is committed `queued`, so a stale `ready` row left after an
`inconsistent` enqueue can never be leased or `ready→sent`-advanced; generic non-quotation rows keep
their retry/lease/SKIP-LOCKED eligibility), and a direct-**INSERT** lifecycle boundary lets a
non-trusted writer create a quotation only in the initial state (`draft`, `sent_at` null) — enforced by
a **positive owner allowlist** derived from the delivery functions' OWNER, NOT a role-name denylist, so
a bespoke custom role is refused both the fabricating INSERT and the privileged UPDATE; eighth review:
**migration 0066** closes the residual WP12 boundary gaps — (a) `_is_quotation_delivery_owner()` is
**signature-exact** (resolves the owner from the exact 9-arg `enqueue_quotation_outbox` identity, with a
migration-time fail-closed assertion that the three delivery functions exist, are all SECURITY DEFINER,
share ONE owner, and are unreachable by anon/authenticated/service_role — a like-named overload cannot
flip it); (b) a BEFORE DELETE trigger refuses a non-trusted delete of a quotation that is queued/terminal
OR has any outbox delivery history (closing the claim-then-delete race); (c) once queued, the quotation
and its `quotation_items` are a **frozen snapshot** for non-trusted writers (only a `sent→accepted`/
`sent→rejected` decision is permitted; pre-queue editing/repricing stays functional); and (d) a doc
correction that the `message_outbox` service-only DML boundary originated in migration **0038**, not 0048);
ninth review: **migration 0067** performs the systemic follow-up the eighth review flagged plus a
concurrency fix — (a) a **catalog-driven search_path audit** re-pins EVERY application-owned SECURITY
DEFINER function and every trigger function in `public` (excluding extension-owned) to
`pg_catalog, extensions, public, pg_temp` (pg_temp LAST; `extensions` for digest/pgcrypto), closing the
`pg_temp` relation-shadowing class across all domains (identity/RLS, approvals, journals, settlement,
reimbursement, bank-change, fingerprint, integrity) — bodies unchanged, only `search_path`; it **fails
closed** if anon/authenticated/service_role has CREATE — direct or SET-ROLE-reachable — on
`public`/`extensions`, SELF-VERIFIES owner-agnostically (any function left unsafe, e.g. under a foreign
owner, ABORTS the migration naming it), and a permanent owner-agnostic integration gate
(`search-path-safety.test.ts`) fails on any future unsafe function (unsafe includes a duplicated `pg_temp`
whose first occurrence is not the final element); and (b) closes a quotation-item vs atomic-enqueue race
at a SINGLE linearization lock — the item-freeze guard reads the parent quotation **FOR UPDATE**
(serializing with `enqueue_quotation_outbox`, which takes NO item-row locks: one lock object cannot form
a deadlock cycle), enqueue requires UNCONDITIONALLY that the expected total equal the live
`SUM(line_total)` (no item-count exemption — deleting ALL items leaves sum 0 ≠ a non-zero total →
`stale`) and refuses any unpriced item, and the freeze guard FAILS CLOSED on an unclassifiable caller
(raw `service_role` with no JWT claims — BYPASSRLS, so RLS is no backstop), so a queued outbox snapshot
can never disagree with committed items; owner-approved hosted search_path check + self-verifying
hardening scripts are prepared, not executed
— see `docs/architecture-v2/HOSTED_SECDEF_PRIVILEGE_HOTFIX.md`. The tenth review (the SECOND AND FINAL
bounded correction loop, still migration 0067 — reconfirmed never applied outside disposable databases):
(a) the safe-path predicate at all four sites (migration self-verify, permanent gate, hosted check,
hosted hardening) is STRICT CANONICAL EQUALITY — only the exact parsed path
`pg_catalog, extensions, public, pg_temp` passes, because a pg_temp-last path can still LEAD with an
attacker-writable schema that wins relation resolution; (b) the enqueue item guard requires a COMPLETE
snapshot line — `status='priced'`, non-NULL `unit_price`, non-NULL `line_total` (SUM skips NULL), and an
item currency equal to the LOCKED quotation currency — mirrored 1:1 by `refreshQuotationStatus`, with
`priceQuotation` auto-pricing only from a same-currency catalogue entry (else a human price confirmation
posed in the quotation currency) and `resolvePriceConfirmation` stamping the item to the quotation
currency (no float, no conversion); (c) the predicted draft-deletion cascade regression was shown NOT to
occur on a disposable local PostgreSQL 16 — RI cascade queries run as the `quotation_items` TABLE OWNER (= the trusted
delivery owner), so authorised pre-queue deletes of itemised quotations cascade cleanly; that ownership
invariant is now ASSERTED fail-closed by the migration and pinned by regression tests) live on the
integration branch `feature/v3-1-phase-1-external-review-fixes` (PR #3 foundation + stack PRs #4–#12 +
all ten correction rounds, one draft PR against `main`). Verified counts: **unit 419 (79 files);
integration 41 files / 321 tests.** See `docs/architecture-v3.1/PHASE1_CONSOLIDATION_REPORT.md`
and `PHASE1_CORRECTIONS_LEDGER.md`; authoritative applied-state: `docs/architecture-v2/MIGRATION_STATE.md`.
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

What "OFF" actually means (do **not** over-read it as "all migrations are inert"):
- `RLS_READS` / `RLS_WRITES` **OFF** → the **RLS read/write cutover** is inert: reads/writes use the
  service-role client (which bypasses RLS) and the legacy department/admin checks, so the capability
  write-policies are not yet the enforcement path. See `docs/architecture-v2/RLS_CUTOVER_PLAN.md`.
- `WHATSAPP_ASYNC` **OFF** → the **synchronous** WhatsApp reply path is used (default). That path
  **still runs the WP12 truthful-delivery state machine** (`tryFinalizeAndSend` → `enqueueOutbox` →
  `enqueue_outbox_row`, quotation `queued`→`sent` only on durable completion). It is **not** inert.
- **Independent of every flag:** `decide_approval`'s authority + money + **currency-catalogue**
  fail-close applies to any caller of that RPC; the composite FKs, function-privilege REVOKEs and the
  `currencies` catalogue enforce at the schema level for any writer — **once the database is migrated**.
  Because the **hosted database is not migrated**, none of this runs on the live system today; that,
  not the flags, is the containment.

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

## Verification evidence (2026-08-16, local disposable PostgreSQL 16)

> Supersedes the earlier 2026-08-07 snapshot (migrations 0044–0047; unit 374) — that wording is stale;
> the header above carries the current authoritative counts. **GitHub Actions obtained no runner** on
> any run (the account's runner provisioning fails at startup — systemic, pre-existing), so there is
> **no CI-pass**; the disposable local PostgreSQL 16 is the CI substitute for all database evidence.

Commands run and results (integration branch, migrations 0001–0067):
- `npm run secret-scan` → **pass** (no tracked secrets).
- `npm run migration-lint` → **pass** (67 migrations, sequential 0001–0067).
- `npm run typecheck` → **pass**.
- `npm run lint` → **pass** (pre-existing `<img>` warnings only).
- `npm test` (unit) → **419 passing (79 files)**.
- `npm run build` → **pass** (placeholder public env).
- `npm run audit-check` → **pass** (2 high findings, both approved exceptions: next, postcss).

**Database tests (disposable PostgreSQL 16 + Supabase-compat shim — run locally, NOT in CI):**
- Fresh `0001→0067` then `npm run test:integration` → **41 files / 321 tests pass**, including the
  0067 search-path gate + adversarial suite (STRICT-canonical owner-agnostic gate that provably catches a
  foreign-owned unsafe function, a duplicated-`pg_temp` path, AND an attacker-writable schema leading a
  pg_temp-last path) and the 0067 enqueue-vs-item race suite (both commit orders, a
  deterministic AB-BA-window no-deadlock proof, delete-to-zero → `stale`, an unpriced late item → `stale`,
  a priced item with NULL `line_total` → `stale`, a currency-mismatched priced item → `stale`,
  raw no-claims `service_role` refused 42501 fail-closed for UPDATE and DELETE, and the
  draft/awaiting_price-with-items cascade-delete regression pin), plus the
  0066 snapshot-boundary suite (signature-exact owner check resists a fake `enqueue_quotation_outbox(int)`
  overload owned by another role; authenticated/service_role/custom cannot delete a queued/terminal
  quotation or one with outbox history; a draft with no outbox stays deletable; a queued quotation and its
  `quotation_items` are frozen — notes/total/public_token/quote_number/currency changes refused, items
  can't be inserted/updated/deleted; `sent→accepted` status-only allowed; a GENUINE two-connection
  claim-then-delete/mutate race), the 0065 claim-boundary suite (a stale `ready` outbox row is unclaimable
  by the service-role drain, claimable only after exact recovery advances `ready→queued`), the 0065
  INSERT-boundary + custom-role suite, the 0064 delivery-boundary suite (authenticated AND service-role
  direct `ready→queued`/`ready→sent` refused 42501 RPC-only; exact-payload recovery vs stale `inconsistent`),
  the 0063 atomic-quotation-enqueue two-connection races, the 0062 SECURITY DEFINER **signature-exact**
  allowlist + `42501` adversarial privilege tests, and the WP11/WP12 adversarial + concurrency + currency suites.
- Upgrade path (staged at `0058` + company-consistent legacy data → `0059→0067`) → **41 files / 321
  tests pass**; the 0062 lockdown holds, a stale `ready` quotation row is unclaimable, a direct
  service-role/custom-role `ready→queued` is refused, a queued quotation is frozen and undeletable, and a
  legacy `ready` quotation is atomically enqueued
  (ready→queued) on the upgraded DB. These suites are wired into CI's `db-tests` job, but **GitHub
  Actions obtained no runner**, so they were executed locally, not in CI.
- Hosted applied-state: the single authoritative statement is in "Reconciliation with MIGRATION_STATE.md"
  below and `MIGRATION_STATE.md` (0038–0041 owner-reported applied 2026-08-07, unverified by this
  process; 0042–0067 owner confirmation required).

## Reconciliation with MIGRATION_STATE.md

`MIGRATION_STATE.md` is the authority on applied-state. 0001–0013 confirmed applied to
production (owner, 2026-08-05); 0014–0022 reported-applied-unverified; 0023–0037 applied by owner to
the hosted DB `gazjughejdzebathpscb`. **0038–0041: owner-reported applied to the hosted DB on
2026-08-07** (SQL editor, `RUN_0038-0041_security_reliability_gate.sql`), **unverified by this
process** (no hosted access) — this is the single authoritative statement; earlier text that also said
"not applied to any environment" is void. Because 0039/0040/0041 revoked service-only function EXECUTE
only from PUBLIC, their SECURITY DEFINER functions (`claim_outbox_batch`, `ledger_integrity_report`,
legacy `_journal_post_internal`) may be `authenticated`-executable on the hosted DB — mitigation
prepared but **not executed** (`docs/architecture-v2/HOSTED_SECDEF_PRIVILEGE_HOTFIX.md`); migration
0062 fixes it once applied. **0042–0067: owner confirmation required** (dev-verified on disposable
PostgreSQL 16 only; not applied to any hosted environment). No statement here asserts a migration is
applied merely because its file exists.

## Gated / not built (owner + legal/privacy approval required)

Live GPS tracking, CCTV ingestion, facial recognition, automated attendance discipline,
bank-transfer execution, autonomous legal/HR decisions, unrestricted customer-facing
autonomous agents, multi-country tax/payroll. See `docs/SECURITY_AND_PRIVACY_MODEL.md`.
