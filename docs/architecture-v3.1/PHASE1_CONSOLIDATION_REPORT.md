# Phase 1 — 0048+ Security/Accounting Corrections — Consolidation Report

> Blocking prerequisite for the V3.1 program. This report is the verification evidence for the
> correction phase (work packages WP10–WP18) **as revised after five external reviews** — migrations
> **0048–0063**. Per-WP detail is in `docs/architecture-v3.1/PHASE1_CORRECTIONS_LEDGER.md`;
> authoritative applied-state is in `docs/architecture-v2/MIGRATION_STATE.md`.
>
> **Phase 1 verdict: CHANGES REQUESTED (five times) → corrected; awaiting the FINAL external review.**
> The first review found blocking defects in WP12/WP15/WP11 + a branch-integration problem (fixed:
> 0056–0058); the second asked for deeper WP12 outbox reconciliation, WP11 composite DB constraints +
> money fail-close, WP15 function-privilege, and doc/deployment accuracy (fixed: 0059–0060 + code +
> docs); the third asked for a concurrency-safe `refreshQuotationStatus`, a reconcile-or-fail-closed for
> a sent-outbox/quotation inconsistency, currency validation against a **catalogue** (not a regex), a
> concurrency test through the **production enqueue RPC** invoked by the real wrapper, and doc accuracy
> — including removing the incorrect "inert while flags OFF" claim (fixed: **0061** + code + docs); the
> fourth (security-boundary) asked to lock every service-only SECURITY DEFINER function to
> `service_role` with an allowlist test over ALL of them, an application re-read in `tryFinalizeAndSend`,
> and a prepared-but-unexecuted hosted privilege check + emergency REVOKE for the already-hosted
> 0038–0041 functions (fixed: **0062** + code + docs — see §10); the fifth (final) found the fourth's
> application re-read still left a time-of-check/time-of-use enqueue window, and asked for a
> **database-atomic** quotation enqueue (lock the row; couple the outbox insert with ready→queued in one
> transaction) with a DB-boundary quotation lifecycle, a **signature-exact** SECURITY DEFINER allowlist,
> and a self-verifying emergency hotfix (fixed: **0063** + code + docs — see §11). **WP11, WP12 and WP15
> are not "done" until a review approves them.**
>
> **STOP AFTER THIS REPORT.** Nothing here is merged, deployed, or flag-enabled, **and the hosted
> database has NOT been migrated** — that (not any flag) is what keeps these changes off the live
> system. Do not begin V3.1 Phase 2 until the owner supplies an explicit final-review approval.

## 1. Branch & commit

- **Integration branch:** `feature/v3-1-phase-1-external-review-fixes`, opened as **one new draft PR
  against `main`** — it integrates, preserving history: (1) PR #3 compatibility foundation
  (`3224d08`), (2) the Phase-1 stack PRs #4–#12 via tip `509685b`, (3) the external-review
  corrections A–D.
- **Content commit SHA (fourth/security-boundary review):** `146a0e38ee97062c6bbaf5efba0a1b1c2d857cea`
  — the commit carrying the security-boundary corrections (migration **0062** + WP12 code + prepared
  hosted artifacts + docs). (A commit cannot embed its own hash; this SHA is stamped by the immediately
  following commit on the branch tip, so the tip = the stamp commit and its parent is the content commit
  named here.)
- **Prior content commits:** third review `8d9ae35` (migration 0061 + WP11/WP12 code + docs); second
  review `0eeceae` (migrations 0059/0060 + WP12 code + docs); first review `fd25be1` (migrations
  0056–0058). **Reviewed baseline:** tip `509685b`, content `6603646` (the first-pass Phase-1 stack).
- **Working tree:** clean at stamp time (`git status --porcelain` empty).
- **Existing draft PRs #4–#12 remain open and unmerged** (not closed); this integration PR supersedes
  them for review.

## 2. Migrations & files added/changed

| Migration | WP | Summary |
|---|---|---|
| 0048 | WP10 | Remove broad company-member writes; capability-gate 18 sensitive tables; WhatsApp/notifications service-only |
| 0049 | WP17 | `_resolve_actor`: system path only via `service_role` JWT; reject missing/malformed/anon/unknown; EXECUTE revoked from PUBLIC |
| 0050 | WP13 | Allowlist whole-row posted-journal immutability; posted lines immutable to INSERT too |
| 0051 | WP14 | Versioned canonical-JSON SHA-256 fingerprint (`v3:`); v2/legacy-NULL compatibility |
| 0052 | WP15 | Invoice/bill invariants: require source lines, positive header, header = line total; verify existing journal binding |
| 0053 | WP16 | Reimbursement/payment reuse: full source-bound payload validation |
| 0054 | WP11 | Approval authority: scope columns + `is_company_wide`; `within_authority_for_event`; strict currency; delegation ⊆ delegator |
| 0055 | WP12 | Truthful delivery: outbox source metadata; quotation `queued` state; fenced `complete_outbox_and_advance` RPC; at-least-once |
| 0056 | WP15 (review B) | Existing-journal path recomputes the canonical fingerprint (source binding); a matching key alone is not proof |
| 0057 | WP11 (review C) | Fail-closed approvals incl. reject; deterministic domain→capability whitelist; duplicate-action conflict; delegation company-consistency |
| 0058 | WP12 (review A) | Outbound message history written atomically on durable send only (provider id); no pre-completion history |
| 0059 | WP15 (review 2) | REVOKE `_journal_fp_matches` EXECUTE from PUBLIC/anon/authenticated (internal helper) |
| 0060 | WP11 (review 2) | Composite company-consistency FKs (request→event, action→request; NOT VALID + preflight); decide_approval fails closed on non-positive/non-finite amount, invalid currency, invalid approvals_required |
| 0061 | WP11+WP12 (review 3, final) | Currencies **catalogue** (`is_active` on the existing 0002 table + 16 seeded ISO codes); `decide_approval` validates currency against it (fail-closed on unseeded codes e.g. `ZZZ`); atomic service-only `enqueue_outbox_row` (the real `enqueueOutbox` wrapper's RPC) + idempotent service-only `reconcile_quotation_from_outbox`; service-only grants (revoked from authenticated/anon) |
| 0062 | security-boundary (review 4) | Lock EVERY service-only SECURITY DEFINER function to `service_role`: `_journal_post_internal` (incl. its legacy 7-arg signature), `claim_outbox_batch`, `complete_outbox_and_advance`, `ledger_integrity_report`, `_journal_fp_matches`, `enqueue_outbox_row`, `reconcile_quotation_from_outbox` — name-based + `to_regprocedure`-guarded, idempotent, upgrade-safe (revoke from PUBLIC/anon/authenticated) |
| 0063 | atomic enqueue + lifecycle (review 5, final) | Atomic service-only `enqueue_quotation_outbox` RPC (locks the quotation row; only if still legally `ready` and the body total/currency still match, inserts the outbox row AND advances ready→queued in ONE transaction; result `enqueued`/`duplicate`/`terminal`/`not_ready`/`stale`/`inconsistent`) + a BEFORE UPDATE trigger enforcing the legal quotation lifecycle (`queued` can never jump to a terminal state). Service-only. |

Application code changed (WP12): `src/lib/quotations.ts` (`tryFinalizeAndSend` → `queued`, propagate
`DrainResult`; **final review:** concurrency-safe `refreshQuotationStatus` with the allowed-status
condition **on the UPDATE** so a queued/terminal quotation gets zero mutations; sent-outbox/quotation
inconsistency **reconciles via the service-only RPC or fails closed** with `outbox_source_inconsistent`
+ operator-visible logging — never `already_sent` with `sent=false`), `src/lib/outbox-enqueue.ts`
(**final review:** enqueue via the atomic `enqueue_outbox_row` RPC, not a raw insert),
`src/events/outbox-drain.ts` (complete `sent` via the fenced RPC), `src/events/outbox.ts`
(source metadata). Documentation: this report + `PHASE1_CORRECTIONS_LEDGER.md` +
`docs/architecture-v2/MIGRATION_STATE.md` + `VERIFICATION_EVIDENCE.md` pointer. Adversarial/concurrency
tests added under `tests/integration/wp1*.test.ts` + `tests/wp12-finalize-truthful.test.ts` +
`tests/outbox-enqueue.test.ts`; `outbox-drain` unit test updated.

## 3. Work-package status

| WP | Correction | Status |
|---|---|---|
| WP10 | Sensitive-write RLS (capability-gated) | **complete** (0048) |
| WP17 | Explicit system-actor trust boundary | **complete** (0049) |
| WP13 | Posted-journal immutability allowlist | **complete** (0050) |
| WP14 | Canonical-JSON idempotency fingerprints | **complete** (0051) |
| WP15 | Invoice/bill document invariants + **source binding** | **corrected** (0052 + **0056** + **0059** fn-privilege) — awaiting re-review |
| WP16 | Reimbursement/payment reuse validation | **complete** (0053) |
| WP11 | Approval scope/currency/delegation + **fail-closed + domain caps + composite FKs + currency catalogue** | **corrected** (0054 + **0057** + **0060** + **0061**) — awaiting re-review |
| WP12 | Truthful quotation/order delivery state (**end-to-end**, concurrency-safe, atomic enqueue RPC) | **corrected** (0055 + **0058** + **0061** + code) — awaiting re-review |
| WP18 | Migration-state / verification reconciliation | **complete** (docs) |

**WP11 domain-capability (review C #5, now IMPLEMENTED).** The generic `approve` capability is
replaced by a deterministic, fail-closed domain→capability whitelist (`finance.approve.payment/
expense/sales/purchase`) — catalogue + role map + a pure mapping function; no AI/free-text chooses
the capability. This permission-catalogue change was **explicitly authorised by the owner for this
correction increment** (code only; not enabled in any hosted environment).

## 4. Verification commands & results (this session)

Static & application gates:

| Command | Result |
|---|---|
| `npm run secret-scan` | pass — no tracked secrets |
| `npm run migration-lint` | pass — **63 migrations, sequential 0001–0063** |
| `npm run typecheck` | pass |
| `npm run lint` | pass (0 errors; pre-existing `<img>` warnings only) |
| `npm test` (unit) | pass — **419 (79 files)** |
| `npm run audit-check` | pass — 2 approved exceptions (next, postcss) |
| `npm run build` | pass |

Database gates (disposable PostgreSQL 16 + Supabase-compat shim):

| Path | Result |
|---|---|
| Fresh DB — `npm run migrate` `0001→0063` then `npm run test:integration` | pass — **36 files / 207 tests** (incl. the 0063 atomic-enqueue suite — single-connection results + real two-connection terminal-vs-enqueue & duplicate-finaliser races + the lifecycle trigger — and the 0062 signature-exact SECURITY DEFINER allowlist + 42501 adversarial suite) |
| Upgrade path — staged at `0058` + representative legacy data (a company-consistent approval request+event in a **catalogue** currency `LKR` **and** one in a **non-catalogue** currency `XYZ`, a queued quotation with a **sent** outbox row, and a `ready` quotation), then `0059→0063` applied | pass — **36 files / 207 tests**; the composite FKs (0060) VALIDATE over the legacy data, the `LKR` event **approves**, the `XYZ` event **fails closed**, the legacy sent-outbox **reconciles** to `sent`, the 0062 lockdown holds, and the legacy `ready` quotation is **atomically enqueued** (ready→queued) on the upgraded DB |

Each external-review adversarial test was confirmed to **fail against the reviewed tip `509685b`**
and pass after the correction. Second-review additions: WP15 function-privilege (authenticated →
SQLSTATE 42501), WP11 composite-FK + money/approvals fail-closed (direct DB), WP12 outbox-state
reconciliation + refreshQuotationStatus hard guard + finaliser-enqueue concurrency. Final-review
additions: `refreshQuotationStatus` terminal-total + read/update-race guards; sent-outbox consistent
vs inconsistent reconciliation (never `already_sent` with `sent=false`); currency-catalogue validation
(`ZZZ`/`1XA` rejected, `LKR` passes); and a **two-connection concurrency test through the production
`enqueue_outbox_row` RPC** (one `enqueued`, one `duplicate`, exactly one row) — the same RPC the real
`enqueueOutbox` wrapper invokes (`tests/outbox-enqueue.test.ts`).

Adversarial & concurrency coverage is included in the 207 integration tests: the atomic quotation
enqueue race (two real connections: terminal-vs-enqueue and duplicate-finaliser) + the DB-boundary
quotation lifecycle trigger (WP12, 0063); SECURITY DEFINER
service-only lockdown + `42501` direct-call proofs + an allowlist over ALL such functions (WP-sec, 0062);
RLS write-gating
(WP10), system-actor boundary (WP17), posted-journal immutability (WP13), fingerprint collision
(WP14), invoice/bill invariants + source binding (WP15), reimbursement chain (WP16), approval
scope/currency/delegation + fail-closed/domain-caps + a two-connection approval race (WP11), and the
outbox completion fence + a two-connection completion race + cross-company isolation (WP12). Every
forced-failure case asserts **no partial financial state** (journal/payment/reimbursement/quotation
left unchanged).

## 5. Toolchain & database version

- **Node** v22.22.2 · **npm** 10.9.7 · **PostgreSQL** 16.13 (disposable, Supabase-compat shim).
- The hosted Supabase project was **not** contacted; no hosted migration ledger was queried
  (owner authorisation not given).

## 6. Owner action required

1. **External review** of this correction phase (the mandatory STOP) before V3.1 phases 2–10.
2. **Hosted application (staging first):** apply `0048–0063` via `npm run migrate` against a staging
   database, run the integration suite there, then production — **owner-gated**. Until then,
   `MIGRATION_STATE.md` records hosted state for `0042–0063` as **owner confirmation required**.
   **Before that**, because 0038–0041 are owner-reported-hosted and their service-only SECURITY DEFINER
   functions may be `authenticated`-executable, run the read-only privilege check and (if exposed) the
   owner-approved emergency REVOKE from `docs/architecture-v2/HOSTED_SECDEF_PRIVILEGE_HOTFIX.md`.
   Note (0061): after applying, seed any additional in-use currencies into `currencies` (`insert … on
   conflict do nothing`) — an event whose currency is not an active catalogue row can no longer be
   approved (fail-closed by design).
3. **Composite-FK VALIDATE (WP11):** after running the documented preflight (0060) against staging and
   remediating any rows it reports, VALIDATE `approval_requests_fe_company_fk` and
   `approval_actions_request_company_fk` (they are `NOT VALID` today — enforcing new rows only).
4. **Flag flips** (`RLS_READS` / `RLS_WRITES` / `WHATSAPP_ASYNC`) remain owner-gated behind staging UAT.

## 7. Remaining risks (stated honestly)

- **CI not run.** The account's GitHub Actions runner provisioning fails at startup on **all** runs
  (systemic, pre-existing, unrelated to these changes). Verification was performed on a disposable
  local PostgreSQL 16 as the CI substitute. GitHub-visible CI is therefore red on every PR head.
- **Hosted parity unverified.** Disposable-PostgreSQL success does not prove hosted Supabase parity;
  the Supabase-compat shim approximates (not reproduces) the managed platform. Staging application +
  re-run is required before any production step.
- **Composite FKs are `NOT VALID`** (WP11) — they enforce new/updated rows immediately but do not
  retroactively validate legacy rows until the owner runs the preflight + `VALIDATE` on staging. The
  RPC fails closed on cross-company/invalid data regardless, so there is no exploit window.
- **At-least-once delivery** (WP12) — a provider-success / DB-failure window can still cause a retry;
  a lease does not make duplicate external delivery impossible. `delivered` is not modelled (a future
  verified-callback state).

## 8. Confirmations

- **No hosted migration was applied** by this development process, in this phase or any prior one.
  **This — not any feature flag — is what keeps these changes off the live system:** the hosted
  Supabase database does not contain migrations `0042–0063`, so none of their objects or behaviour
  exist there.
- **No feature flag was enabled.** `RLS_READS`, `RLS_WRITES`, `WHATSAPP_ASYNC` remain **OFF**.
  **Correction (removing an earlier inaccurate claim):** these migrations are **NOT** uniformly
  "inert while the flags are OFF". Only the **RLS read/write cutover** is flag-inert — the app still
  uses the service-role client, which bypasses RLS, so the capability write-policies are not yet the
  enforcement path. Everything else is **active whenever its code path runs**, independent of any flag:
  the WP12 delivery-state machine + `enqueue_outbox_row`/`reconcile_quotation_from_outbox` run on the
  **default synchronous WhatsApp path (`WHATSAPP_ASYNC` OFF)**; `decide_approval`'s authority + money +
  **currency-catalogue** fail-close applies to **every caller of that RPC** (integration tests today —
  the live finance UI action does not yet call it, but no flag renders it inert); and the composite
  FKs, function-privilege REVOKEs, and `currencies` catalogue enforce at the schema level for **any**
  writer. The safety guarantee is therefore "**hosted DB not migrated / not merged / not deployed**",
  not "inert because flags OFF".
- **No accounting history was edited or deleted;** posting functions were replaced only.
- **The permission catalogue gained domain-specific approval capabilities** (WP11 review C #5) —
  **code only, owner-authorised for this increment, not enabled in any hosted environment.**
- Nothing is **merged**; the corrections land as **one draft integration PR** against `main`; the
  existing draft PRs #4–#12 remain open and unmerged.
- **GitHub Actions obtained no runner** (the account's runner provisioning fails at startup on every
  run — systemic, pre-existing); all evidence is from a disposable local PostgreSQL 16. No CI-pass is
  claimed.
- **Service-only SECURITY DEFINER functions are locked to `service_role`** (0062), proven by an
  allowlist test over ALL such functions + `42501` adversarial direct-call tests. The already-hosted
  0038–0041 functions may be exposed on the hosted DB; a read-only check + owner-approved emergency
  REVOKE are **prepared but NOT executed** (`docs/architecture-v2/HOSTED_SECDEF_PRIVILEGE_HOTFIX.md`).

## 9. Deployment note — automatic Vercel preview (accurate record)

- The repository is connected to Vercel, so opening/updating this PR triggers an **automatic Vercel
  *Preview* deployment** (Vercel's default Git integration) at a preview URL. **This is a preview,
  not production** — no production deploy is triggered by this PR, and no `vercel --prod` / promotion
  was performed by this development process.
- **No credentials are committed to the repo:** `.env.example` holds placeholders only (empty values
  + comments), `npm run secret-scan` is clean, and `vercel.json` contains only a cron schedule (no
  env values). Real values live in Vercel's environment-variable store, **outside the repo**.
- **Preview environment variables — owner confirmation required.** This development process **cannot
  access the Vercel dashboard**, so it **cannot independently confirm** what the *Preview* scope
  contains. The owner must verify the Vercel **Preview** scope holds **no production credentials**
  (no production `SUPABASE_SERVICE_ROLE_KEY`, `WHATSAPP_ACCESS_TOKEN`/`APP_SECRET`, `OPENAI_API_KEY`,
  `INNGEST_*`, `CRON_SECRET`, or a production `DATABASE_URL`). Defence already in the code: production
  config fails fast (`src/config/env.ts`) and the write/commit integration tests **refuse to run**
  against `PRODUCTION_DB_HOST`. The real containment is that **a preview points at whatever database
  its `DATABASE_URL` names, and no hosted database has these migrations applied** — so the new objects
  (`enqueue_outbox_row`, `reconcile_quotation_from_outbox`, the `currencies` catalogue, the composite
  FKs) simply do not exist for a preview to reach. It is **not** correct to say "flags OFF ⇒ no
  behaviour-changed path": the WP12 delivery path runs with `WHATSAPP_ASYNC` OFF, so once a database is
  migrated these behaviours are live regardless of flags. Preview safety rests on the un-migrated
  database + no production credentials, not on the flags.

## 10. Security-boundary review (fourth) — what changed

1. **Migration 0062 — SECURITY DEFINER lockdown.** Every service-only / internal function is revoked
   from PUBLIC, `anon` and `authenticated` and granted only `service_role`: `_journal_post_internal`
   (incl. its legacy 7-arg signature), `claim_outbox_batch`, `complete_outbox_and_advance`,
   `ledger_integrity_report`, `_journal_fp_matches`, `enqueue_outbox_row`,
   `reconcile_quotation_from_outbox`. Name-based (locks every present signature) + `to_regprocedure`
   guards → safe on fresh and upgrade. Left executable, and asserted so by the allowlist test: the RLS
   predicate helpers (RLS policies evaluate them in the caller's role) and the authenticated write-path
   RPCs (`post_*`/`settle_*`/`reverse_journal`/`reimburse_expense_claim`/`*_supplier_bank_change`/
   `decide_approval`), which fail-closed internally.
2. **Tests** (`tests/integration/secure-definer-grants.test.ts`): an ALLOWLIST test over **all**
   SECURITY DEFINER functions (fails if any is unclassified); the grant matrix (service-only →
   authenticated/anon false, service_role true); and `42501` proofs that an authenticated caller
   cannot create a journal, claim/read an outbox batch, read the cross-company integrity report, or
   complete an outbox row — while `service_role` still executes them.
3. **`tryFinalizeAndSend` end-to-end concurrency-safe** (`src/lib/quotations.ts`): it no longer assumes
   `ready` after `refreshQuotationStatus` returns `awaiting=false` — it **re-reads** the authoritative
   status+total after the guarded update; a race to `sent`/`accepted`/`rejected` stops with **zero
   enqueue/send**, a race to `queued` reconciles **only the existing** outbox row, and a new enqueue
   happens only while still `ready`. The message is built from the **freshly-persisted total** (not the
   pre-refresh read) and formatted **without a JavaScript `Number`** (Decimal + string separators).
   Unit tests cover each race and the stale/zero-total case.
4. **Hosted 0038–0041 exposure — prepared, not executed.** `docs/architecture-v2/`:
   `hosted_secdef_privilege_check.sql` (read-only), `hosted_secdef_emergency_revoke.sql`
   (owner-approved break-glass), and `HOSTED_SECDEF_PRIVILEGE_HOTFIX.md` (evidence: on a 0041-staged
   disposable DB the legacy `_journal_post_internal`, `claim_outbox_batch` and `ledger_integrity_report`
   are `authenticated`-executable before the hotfix and locked after). **Not run against hosted.**
5. **Docs reconciled:** one authoritative 0038–0041 hosted statement (owner-reported applied 2026-08-07,
   unverified by this process); 0042–0062 = owner confirmation required; GitHub Actions obtained no
   runner (local disposable-Postgres evidence); automatic Vercel Preview, no production deployment;
   stale 195-test/current-state wording removed.

## 11. Atomic-enqueue + lifecycle review (fifth, final) — what changed

The fourth review's fix added an application re-read to `tryFinalizeAndSend`, but a time-of-check/
time-of-use window remained: the app could re-read `ready`, a concurrent transaction could move the
quotation terminal, `enqueueOutbox` could insert a pending row, and the guarded `ready→queued` update
could then match zero rows — leaving a live pending row for a terminal quotation. This round closes that
at the database.

1. **Migration 0063 — atomic `enqueue_quotation_outbox`.** A single service-only RPC LOCKS the
   company-scoped quotation row (the linearization point), inspects the authoritative status UNDER that
   lock, verifies the caller's message total/currency still match the locked row, and — only if still
   legally `ready` — inserts the outbox row AND advances `ready→queued` in ONE transaction. Any failure
   rolls back both. Results: `enqueued` / `duplicate` (reconcile the exact existing row) / `terminal` /
   `not_ready` / `stale` / `inconsistent` (cross-company/source key → fail closed). `tryFinalizeAndSend`
   now branches on the result and NEVER drains on terminal/not_ready/stale/inconsistent. The generic
   `enqueue_outbox_row` path is unchanged for non-quotation messages.
2. **DB-boundary quotation lifecycle.** A BEFORE UPDATE trigger enforces
   `draft/awaiting_price/ready → queued → sent → accepted/rejected` (plus the documented `ready→sent`
   recovery). A `queued` quotation can NEVER be directly moved to `accepted`/`rejected` while its outbox
   message is live — proven both directly and in the two-connection "enqueue wins" race.
3. **Signature-exact SECURITY DEFINER allowlist.** `secure-definer-grants.test.ts` now classifies each
   function by its exact `regprocedure` identity (name + argument types), so a new OVERLOAD of an
   approved name is a different signature and fails the allowlist. `enqueue_quotation_outbox` is in the
   service-only set (and has its own 42501 adversarial test).
4. **Self-verifying emergency hotfix.** `hosted_secdef_emergency_revoke.sql` now ASSERTS, in the same
   transaction, that no residual `anon`/`authenticated` EXECUTE remains after the REVOKEs and RAISES
   (aborting the transaction) if any does — so a partial lockdown can never be committed from a
   SQL-editor batch. Proven on a 0041-staged disposable DB: exposure before, locked after, and a
   simulated residual aborts (`ROLLBACK`). Wording corrected: "owner approval REQUIRED before execution"
   (not "OWNER-APPROVED"); the script is described as **catalog-driven** (it uses catalog discovery, not
   `to_regprocedure`).
5. **Real two-connection races.** `tests/integration/wp12-atomic-enqueue.test.ts` proves, with two live
   PostgreSQL connections: terminal-wins (zero rows), enqueue-wins (one row + queued; a concurrent
   `queued→accepted` then fails), and two finalisers (exactly one logical row) — plus single-connection
   stale/inconsistent/duplicate/atomicity-rollback and the lifecycle trigger.

_Phase status: **verified on disposable PostgreSQL 16 (fresh 0001→0063 + upgrade 0058→0063 with legacy
data); not fully verified on hosted infrastructure** (no staging/production application; GitHub Actions
obtained no runner). Five external reviews returned CHANGES REQUESTED; all corrected. **Awaiting the
final external review — STOP.**_
