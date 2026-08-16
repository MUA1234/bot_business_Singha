# Phase 1 — 0048+ Security/Accounting Corrections — Consolidation Report

> Blocking prerequisite for the V3.1 program. This report is the verification evidence for the
> correction phase (work packages WP10–WP18) **as revised after the first external review** —
> migrations **0048–0060**. Per-WP detail is in `docs/architecture-v3.1/PHASE1_CORRECTIONS_LEDGER.md`;
> authoritative applied-state is in `docs/architecture-v2/MIGRATION_STATE.md`.
>
> **Phase 1 verdict: CHANGES REQUESTED → corrected; awaiting the SECOND external review.** The first
> review found blocking defects in WP12, WP15 and WP11 plus a branch-integration problem; all are
> fixed in this increment. **WP11, WP12 and WP15 are not "done" until the second review approves.**
>
> **STOP AFTER THIS REPORT.** Nothing here is merged, deployed, or flag-enabled. Do not begin V3.1
> Phase 2 until the owner supplies an explicit second-review approval.

## 1. Branch & commit

- **Integration branch:** `feature/v3-1-phase-1-external-review-fixes`, opened as **one new draft PR
  against `main`** — it integrates, preserving history: (1) PR #3 compatibility foundation
  (`3224d08`), (2) the Phase-1 stack PRs #4–#12 via tip `509685b`, (3) the external-review
  corrections A–D.
- **Content commit SHA:** `__FINAL_SHA__` — the commit carrying the second-review corrections
  (migrations 0059/0060 + WP12 code + docs). (A commit cannot embed its own hash; this SHA is stamped
  by the immediately following commit on the branch tip, so the tip = the stamp commit and its parent
  is the content commit named here.)
- **First-review corrections content commit:** `fd25be1` (migrations 0056–0058). **Reviewed
  baseline:** tip `509685b`, content `6603646` (the first-pass Phase-1 stack).
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
| WP15 | Invoice/bill document invariants + **source binding** | **corrected** (0052 + **0056**) — awaiting re-review |
| WP16 | Reimbursement/payment reuse validation | **complete** (0053) |
| WP11 | Approval scope/currency/delegation + **fail-closed + domain caps** | **corrected** (0054 + **0057**) — awaiting re-review |
| WP12 | Truthful quotation/order delivery state (**end-to-end**) | **corrected** (0055 + **0058** + code) — awaiting re-review |
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
| `npm run migration-lint` | pass — **60 migrations, sequential 0001–0060** |
| `npm run typecheck` | pass |
| `npm run lint` | pass (0 errors; pre-existing `<img>` warnings only) |
| `npm test` (unit) | pass — **410** |
| `npm run audit-check` | pass — 2 approved exceptions (next, postcss) |
| `npm run build` | pass |

Database gates (disposable PostgreSQL 16 + Supabase-compat shim):

| Path | Result |
|---|---|
| Fresh DB — `npm run migrate` `0001→0060` then `npm run test:integration` | pass — **34 files / 180 tests** |
| Upgrade path — staged at `0058` + representative legacy data (approval request+event, an invoice), then `0059→0060` applied | pass — **34 files / 180 tests**; the composite FKs apply to new rows over legacy data |

Each external-review adversarial test was confirmed to **fail against the reviewed tip `509685b`**
and pass after the correction. Second-review additions: WP15 function-privilege (authenticated →
SQLSTATE 42501), WP11 composite-FK + money/approvals fail-closed (direct DB), WP12 outbox-state
reconciliation + refreshQuotationStatus hard guard + finaliser-enqueue concurrency.

Adversarial & concurrency coverage is included in the 173 integration tests: RLS write-gating
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
2. **Hosted application (staging first):** apply `0048–0060` via `npm run migrate` against a staging
   database, run the integration suite there, then production — **owner-gated**. Until then,
   `MIGRATION_STATE.md` records hosted state for `0042–0060` as **owner confirmation required**.
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
- **No feature flag was enabled.** `RLS_READS`, `RLS_WRITES`, `WHATSAPP_ASYNC` remain **OFF**; the
  0048–0060 migrations are inert at runtime while they are off.
- **No accounting history was edited or deleted;** posting functions were replaced only.
- **The permission catalogue gained domain-specific approval capabilities** (WP11 review C #5) —
  **code only, owner-authorised for this increment, not enabled in any hosted environment.**
- Nothing is **merged**; the corrections land as **one draft integration PR** against `main`; the
  existing draft PRs #4–#12 remain open and unmerged.
- **GitHub Actions did not run** (the account's runner fails to start on every run); all evidence is
  from a disposable local PostgreSQL 16. No CI-pass is claimed.

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
  against `PRODUCTION_DB_HOST`. With `RLS_*`/`WHATSAPP_ASYNC` OFF a preview exercises no
  behaviour-changed path from these migrations.

_Phase status: **verified on disposable PostgreSQL 16; not fully verified on hosted infrastructure**
(no staging/production application, no CI run). Second review returned CHANGES REQUESTED; corrected.
**Awaiting the final external review — STOP.**_
