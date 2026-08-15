# Phase 1 — 0048+ Security/Accounting Corrections — Consolidation Report

> Blocking prerequisite for the V3.1 program. This report is the **final verification evidence** for
> the correction phase (work packages WP10–WP18, migrations **0048–0055**). It is stamped with the
> final commit SHA and the exact database version. Per-WP detail is in
> `docs/architecture-v3.1/PHASE1_CORRECTIONS_LEDGER.md`; authoritative applied-state is in
> `docs/architecture-v2/MIGRATION_STATE.md`.
>
> **STOP AFTER THIS REPORT.** The correction phase requires external review before the V3.1 runtime
> phases (2–10) begin. Nothing here is merged, deployed, or flag-enabled.

## 1. Final commit & branch

- **Branch:** `feature/v3-1-phase-1-wp18-migration-state-docs` (tip of the stacked correction chain).
- **Phase content commit SHA:** `6603646c3b89dff5d46240be7ca69211cb9804c7` — the commit carrying all
  WP10–WP18 code, migrations and docs. This SHA-stamp itself lands as the immediately following
  commit on the branch tip (a commit cannot embed its own hash), so the branch tip = this stamp
  commit, and its parent is the content commit named here.
- **Working tree:** clean at stamp time (`git status --porcelain` empty).
- **Stack (each a controlled draft PR, review/merge in order):**
  PR #4 WP10 → #5 WP17 → #6 WP13 → #7 WP14 → #8 WP15 → #9 WP16 → #10 WP11 → #11 WP12 → (WP18 docs) → `main`.

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

Application code changed (WP12): `src/lib/quotations.ts` (`tryFinalizeAndSend` → `queued`, propagate
`DrainResult`), `src/events/outbox-drain.ts` (complete `sent` via the fenced RPC), `src/events/outbox.ts`
(source metadata). Documentation: this report + `PHASE1_CORRECTIONS_LEDGER.md` +
`docs/architecture-v2/MIGRATION_STATE.md` + `VERIFICATION_EVIDENCE.md` pointer. Adversarial/concurrency
tests added under `tests/integration/wp1*.test.ts`; `outbox-drain` unit test updated.

## 3. Work-package status

| WP | Correction | Status |
|---|---|---|
| WP10 | Sensitive-write RLS (capability-gated) | **complete** (0048) |
| WP17 | Explicit system-actor trust boundary | **complete** (0049) |
| WP13 | Posted-journal immutability allowlist | **complete** (0050) |
| WP14 | Canonical-JSON idempotency fingerprints | **complete** (0051) |
| WP15 | Invoice/bill document invariants | **complete** (0052) |
| WP16 | Reimbursement/payment reuse validation | **complete** (0053) |
| WP11 | Approval scope + currency + delegation bounds | **complete** (0054) — see partial note |
| WP12 | Truthful quotation/order delivery state | **complete** (0055) |
| WP18 | Migration-state / verification reconciliation | **complete** (docs) |

**WP11 partial note (honest).** The substantive authority controls (organisational scope, strict
currency, whole-event ceiling, delegation-⊆-delegator) are implemented and tested. Requirement #8 —
replacing the generic `approve` capability with a domain-specific approval capability — is
**deliberately deferred**: it is an owner-gated change to the permission catalogue/role map, which
CLAUDE.md forbids doing autonomously. Tracked as a follow-up.

## 4. Verification commands & results (this session)

Static & application gates:

| Command | Result |
|---|---|
| `npm run secret-scan` | pass — no tracked secrets |
| `npm run migration-lint` | pass — 55 migrations, sequential 0001–0055 |
| `npm run typecheck` | pass |
| `npm run lint` | pass (pre-existing `<img>` warnings only) |
| `npm test` (unit) | pass — **374** |
| `npm run audit-check` | pass — 2 approved exceptions (next, postcss) |
| `npm run build` | pass |

Database gates (disposable PostgreSQL 16 + Supabase-compat shim):

| Path | Result |
|---|---|
| Fresh DB — `npm run migrate` `0001→0055` then `npm run test:integration` | pass — **31 files / 161 tests** |
| Upgrade path — staged at prior migration + representative legacy data, then `0055` applied | pass — **31 files / 161 tests** |

Adversarial & concurrency coverage is included in the 161 integration tests: RLS write-gating
(WP10), system-actor boundary (WP17), posted-journal immutability (WP13), fingerprint collision
(WP14), invoice/bill invariants (WP15), reimbursement chain (WP16), approval scope/currency/
delegation + a two-connection approval race (WP11), and the outbox completion fence + a two-connection
completion race + cross-company isolation (WP12). Every forced-failure case asserts **no partial
financial state** (journal/payment/reimbursement/quotation left unchanged).

Each new migration's adversarial test was also confirmed to **fail against the immediately prior
schema** (failing-before / passing-after), except where the change is purely additive (WP11/WP12 add
new columns/functions, so the pre-migration schema cannot run the test at all — recorded as such).

## 5. Toolchain & database version

- **Node** v22.22.2 · **npm** 10.9.7 · **PostgreSQL** 16.13 (disposable, Supabase-compat shim).
- The hosted Supabase project was **not** contacted; no hosted migration ledger was queried
  (owner authorisation not given).

## 6. Owner action required

1. **External review** of this correction phase (the mandatory STOP) before V3.1 phases 2–10.
2. **Hosted application (staging first):** apply `0048–0055` via `npm run migrate` against a staging
   database, run the integration suite there, then production — **owner-gated**. Until then,
   `MIGRATION_STATE.md` records hosted state for `0042–0055` as **owner confirmation required**.
3. **WP11 #8 decision:** approve (or not) the domain-specific approval-capability split (a permission
   catalogue change) as a follow-up.
4. **Flag flips** (`RLS_READS` / `RLS_WRITES` / `WHATSAPP_ASYNC`) remain owner-gated behind staging UAT.

## 7. Remaining risks (stated honestly)

- **CI not run.** The account's GitHub Actions runner provisioning fails at startup on **all** runs
  (systemic, pre-existing, unrelated to these changes). Verification was performed on a disposable
  local PostgreSQL 16 as the CI substitute. GitHub-visible CI is therefore red on every PR head.
- **Hosted parity unverified.** Disposable-PostgreSQL success does not prove hosted Supabase parity;
  the Supabase-compat shim approximates (not reproduces) the managed platform. Staging application +
  re-run is required before any production step.
- **WP11 #8 deferred** (above) — the generic `approve` capability still gates approvals; the
  substantive amount/currency/scope/delegation authority is enforced.
- **At-least-once delivery** (WP12) — a provider-success / DB-failure window can still cause a retry;
  a lease does not make duplicate external delivery impossible. `delivered` is not modelled (a future
  verified-callback state).

## 8. Confirmations

- **No hosted migration was applied** by this development process, in this phase or any prior one.
- **No feature flag was enabled.** `RLS_READS`, `RLS_WRITES`, `WHATSAPP_ASYNC` remain **OFF**; the
  0048–0055 migrations are inert at runtime while they are off.
- **No accounting history was edited or deleted;** posting functions were replaced only.
- **No permissions/approval capabilities were changed** (WP11 #8 deferred).
- Nothing is **merged** or **deployed**; every work package lands as a **draft** PR for review.

_Phase status: **verified on disposable PostgreSQL 16; not fully verified on hosted infrastructure**
(no staging/production application, no CI run). Awaiting external review — STOP._
