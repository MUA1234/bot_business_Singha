# Phase 1 — 0048+ Security/Accounting Corrections — Consolidation Report

> Blocking prerequisite for the V3.1 program. This report is the verification evidence for the
> correction phase (work packages WP10–WP18) **as revised after nine external reviews** — migrations
> **0048–0067**. Per-WP detail is in `docs/architecture-v3.1/PHASE1_CORRECTIONS_LEDGER.md`;
> authoritative applied-state is in `docs/architecture-v2/MIGRATION_STATE.md`.
>
> **Phase 1 verdict: CHANGES REQUESTED (nine times) → corrected; awaiting the FINAL external review.**
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
> 0038–0041 functions (fixed: **0062** + code + docs — see §10); the fifth found the fourth's
> application re-read still left a time-of-check/time-of-use enqueue window, and asked for a
> **database-atomic** quotation enqueue (lock the row; couple the outbox insert with ready→queued in one
> transaction) with a DB-boundary quotation lifecycle, a **signature-exact** SECURITY DEFINER allowlist,
> and a self-verifying emergency hotfix (fixed: **0063** + code + docs — see §11); the sixth found two
> WP12 integrity gaps — the lifecycle trigger still permitted a DIRECT table `ready→queued`/`ready→sent`
> (bypassing the atomic/fenced RPCs), and the ready+existing-row recovery compared only company/source,
> not the payload — and asked for RPC-only privileged transitions (a non-spoofable `current_user` gate)
> and an EXACT-payload recovery guard (fixed: **0064** + docs — see §12); the seventh found two residual
> WP12 boundary gaps — the scheduled drain `claim_outbox_batch` could still lease + send a STALE `ready`
> quotation's outbox row (bypassing the exact-payload guard), and the BEFORE-UPDATE-only trigger let a
> direct INSERT fabricate a `queued`/`sent` quotation — and asked for a **quotation-aware** claim (a
> quotation row is claimable only when its quotation is committed `queued`) and a direct-INSERT boundary
> enforced by a **positive owner allowlist** (not a role-name denylist, so a custom role cannot bypass
> it) (fixed: **0065** + docs — see §13); the eighth found the residual boundary gaps — the owner check
> was not signature-exact (a like-named overload could bind a different owner), a claimed outbox row's
> quotation could still be DELETED before the worker sent it, and a queued quotation's body/items were not
> frozen — and asked for a signature-exact owner check with a migration-time fail-closed assertion, a
> DELETE boundary, and a frozen queued snapshot for quotations + quotation_items (fixed: **0066** + tests
> + docs — see §14); the ninth generalized the eighth's own finding into a systemic follow-up (the
> `pg_temp` search_path class was not WP12-specific — accounting/approval/identity-RLS/journal/settlement/
> fingerprint functions carried unsafe paths) and asked for a catalog-driven audit + a permanent gate, plus
> a fix for a quotation-item vs atomic-enqueue race (fixed: **0067** + tests + hosted-prep + docs — see §15).
> **WP11, WP12 and WP15 are not
> "done" until a review approves them.**
>
> **STOP AFTER THIS REPORT.** Nothing here is merged, deployed, or flag-enabled, **and the hosted
> database has NOT been migrated** — that (not any flag) is what keeps these changes off the live
> system. Do not begin V3.1 Phase 2 until the owner supplies an explicit final-review approval.

## 1. Branch & commit

- **Integration branch:** `feature/v3-1-phase-1-external-review-fixes`, opened as **one new draft PR
  against `main`** — it integrates, preserving history: (1) PR #3 compatibility foundation
  (`3224d08`), (2) the Phase-1 stack PRs #4–#12 via tip `509685b`, (3) the external-review
  corrections A–D.
- **Content commit SHA (ninth review):** `87528d5d80f4e6cbbdf287898577dfe5d6a8d9ab` — the commit carrying migration **0067** (the
  catalog-driven systemic search_path hardening + the enqueue-vs-item-mutation race fix), the two new
  integration suites (`search-path-safety.test.ts`, `wp12-enqueue-item-race.test.ts`), the hosted search_path
  check + hardening scripts, and docs. (A commit cannot embed its own hash; this SHA is stamped by the
  immediately following commit on the branch tip.)
- **Prior content commits:** eighth review `9c51b2c` (migration 0066 + snapshot/delete-boundary +
  search_path/pg_temp hardening + message_outbox freeze + tests + docs);
  seventh review `5e5f42a` (migration 0065 + claim/INSERT-boundary tests + docs);
  sixth review `6af1bae` (migration 0064 + real-role adversarial test + docs);
  fifth review `e8d6cac` (migration 0063 + WP12 code + signature-exact
  allowlist + self-gating hotfix + docs); fourth review `146a0e3` (migration 0062 + code + hosted artifacts + docs);
  third review `8d9ae35` (migration 0061 + WP11/WP12 code + docs); second review `0eeceae` (migrations
  0059/0060 + WP12 code + docs); first review `fd25be1` (migrations 0056–0058). **Reviewed baseline:**
  tip `509685b`, content `6603646` (the first-pass Phase-1 stack).
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
| 0064 | delivery-transition boundary (review 6) | Privileged delivery transitions (`ready→queued`/`queued→sent`/`ready→sent`) made RPC-ONLY — the SECURITY INVOKER lifecycle trigger refuses them when `current_user` is a PostgREST API role (anon/authenticated/service_role), so a direct table UPDATE cannot bypass the atomic/fenced delivery RPCs (whose internal UPDATE runs as the function owner). `enqueue_quotation_outbox`'s ready+existing-row recovery now requires an EXACT delivery-identity+payload match (company/source/key/channel/recipient/body/message_purpose) or returns `inconsistent`. |
| 0065 | claim + INSERT boundary (review 7) | `claim_outbox_batch` is **quotation-aware** — a quotation-delivery row is claimable only when `source_type='quotation'` AND `message_purpose='quotation'` AND `source_id` identifies a quotation in the SAME company whose status is exactly `queued` (either-field-`quotation`-with-mismatch fails closed); generic rows keep retry/lease/SKIP-LOCKED eligibility; service-role-only. A BEFORE INSERT trigger restricts non-trusted writers to the initial state (`draft`, `sent_at` null); the UPDATE trigger's privileged-transition + `sent_at` guards use a **positive owner allowlist** (`_is_quotation_delivery_owner()`, derived from `pg_proc.proowner`), not a role-name denylist, so a bespoke custom role is refused the fabricating INSERT AND the privileged UPDATE. |
| 0066 | snapshot + delete boundary (review 8) | `_is_quotation_delivery_owner()` is **signature-exact** (resolves the owner from the EXACT 9-arg `enqueue_quotation_outbox` identity; a migration-time DO block fails closed unless enqueue/complete/reconcile all exist, are SECURITY DEFINER, share ONE owner, and are unreachable by anon/authenticated/service_role). A BEFORE DELETE trigger refuses a non-trusted delete of a quotation that is queued/terminal OR has any outbox delivery history (closing the claim-then-delete race; trusted owner keeps a maintenance override). A whole-row BEFORE UPDATE freeze + `quotation_items` INSERT/UPDATE/DELETE triggers make a queued/terminal quotation and its items immutable to non-trusted writers except a pure `sent→accepted`/`sent→rejected` decision; the item triggers read the parent status via a self-gating SECURITY DEFINER helper (no cross-company oracle). Doc correction: `message_outbox` service-only DML originated in 0038, not 0048. |
| 0067 | systemic search_path + enqueue-item race (review 9) | Catalog-driven `ALTER FUNCTION` re-pins EVERY application-owned SECURITY DEFINER + trigger function in `public` (excl. extension-owned) to `pg_catalog, extensions, public, pg_temp` (pg_temp LAST) — closing the `pg_temp` shadowing class across identity-RLS / accounting / approvals / bank-change / journal / settlement / reimbursement / fingerprint / integrity; bodies unchanged. Fails closed if an API role has CREATE on public/extensions; permanent gate `search-path-safety.test.ts`. Closes the quotation-item vs atomic-enqueue race: the item-freeze guard reads the parent `FOR UPDATE` and `enqueue_quotation_outbox` locks the item rows + returns `stale` when an itemised quotation's expected total ≠ the live item sum. |

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
| `npm run migration-lint` | pass — **67 migrations, sequential 0001–0067** |
| `npm run typecheck` | pass |
| `npm run lint` | pass (0 errors; pre-existing `<img>` warnings only) |
| `npm test` (unit) | pass — **419 (79 files)** |
| `npm run audit-check` | pass — 2 approved exceptions (next, postcss) |
| `npm run build` | pass |

Database gates (disposable PostgreSQL 16 + Supabase-compat shim):

| Path | Result |
|---|---|
| Fresh DB — `npm run migrate` `0001→0067` then `npm run test:integration` | pass — **41 files / 311 tests** (incl. the new 0066 snapshot-boundary suite — signature-exact owner check vs a fake `enqueue_quotation_outbox(int)` overload, DELETE boundary across authenticated/service_role/custom, frozen quotation + `quotation_items`, and a GENUINE two-connection claim-vs-delete/mutate race — the 0065 claim + INSERT-boundary suites, the 0064 delivery-boundary suite, the 0063 atomic-enqueue two-connection races, and the 0062 signature-exact allowlist + 42501 suite) |
| Upgrade path — staged at `0058` + representative legacy data (a company-consistent approval request+event in a **catalogue** currency `LKR` **and** one in a **non-catalogue** currency `XYZ`, a queued quotation with a **sent** outbox row, and a `ready` quotation), then `0059→0067` applied | pass — **41 files / 311 tests**; the composite FKs (0060) VALIDATE over the legacy data, the `LKR` event **approves**, the `XYZ` event **fails closed**, the legacy sent-outbox **reconciles**, the 0062 lockdown holds, a stale `ready` quotation row is unclaimable, a direct service-role/custom-role `ready→queued` is refused, a queued quotation is frozen and undeletable, and the legacy `ready` quotation is **atomically enqueued** on the upgraded DB |

Each external-review adversarial test was confirmed to **fail against the reviewed tip `509685b`**
and pass after the correction. Second-review additions: WP15 function-privilege (authenticated →
SQLSTATE 42501), WP11 composite-FK + money/approvals fail-closed (direct DB), WP12 outbox-state
reconciliation + refreshQuotationStatus hard guard + finaliser-enqueue concurrency. Final-review
additions: `refreshQuotationStatus` terminal-total + read/update-race guards; sent-outbox consistent
vs inconsistent reconciliation (never `already_sent` with `sent=false`); currency-catalogue validation
(`ZZZ`/`1XA` rejected, `LKR` passes); and a **two-connection concurrency test through the production
`enqueue_outbox_row` RPC** (one `enqueued`, one `duplicate`, exactly one row) — the same RPC the real
`enqueueOutbox` wrapper invokes (`tests/outbox-enqueue.test.ts`).

Adversarial & concurrency coverage is included in the 311 integration tests: the permanent search_path gate + cross-domain pg_temp adversarial suite (capability/company identity cannot be forged via temp memberships/profiles; an approval cannot be forced via a temp approval_requests; journal internals stay service-only + unshadowable) and the genuine two-connection enqueue-vs-item-mutation race — both orderings, no deadlock (0067); the signature-exact owner check (a fake `enqueue_quotation_outbox(int)` overload owned by another role cannot flip it), the DELETE boundary (queued/terminal/outbox-history quotations undeletable by non-owners), the frozen queued snapshot (quotation + `quotation_items` immutable to non-owners), and a GENUINE two-connection claim-vs-delete/mutate race (0066); the quotation-aware claim boundary (a stale `ready` row is unclaimable by the service-role drain) and the direct-INSERT boundary + positive-owner allowlist (authenticated, service-role AND a bespoke custom role refused a fabricating INSERT and a privileged UPDATE) (0065); the RPC-only delivery-transition boundary (authenticated + service-role direct writes refused) and exact-payload recovery (0064); the atomic quotation
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
2. **Hosted application (staging first):** apply `0048–0067` via `npm run migrate` against a staging
   database, run the integration suite there, then production — **owner-gated**. Until then,
   `MIGRATION_STATE.md` records hosted state for `0042–0067` as **owner confirmation required**.
   **Before that**, because 0038–0041 are owner-reported-hosted and their service-only SECURITY DEFINER
   functions may be `authenticated`-executable, run the read-only privilege check and (if exposed) the
   owner-approval-REQUIRED emergency REVOKE from `docs/architecture-v2/HOSTED_SECDEF_PRIVILEGE_HOTFIX.md`.
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
  Supabase database does not contain migrations `0042–0067`, so none of their objects or behaviour
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
  0038–0041 functions may be exposed on the hosted DB; a read-only check + an owner-approval-REQUIRED emergency
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
   (owner-approval-REQUIRED break-glass), and `HOSTED_SECDEF_PRIVILEGE_HOTFIX.md` (evidence: on a 0041-staged
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

## 12. Delivery-transition boundary review (sixth) — what changed

Two WP12 database-integrity gaps remained after §11: (a) the lifecycle trigger from 0063 still permitted
a DIRECT table `ready→queued` / `ready→sent`, so a permitted table writer (an authenticated user with
`sales.quotation.manage`, or `service_role`) could create a queued quotation with no outbox row, or mark
one `sent` without provider completion — bypassing the atomic/fenced machinery; (b) the `ready` +
existing-outbox-row recovery inside `enqueue_quotation_outbox` compared only company/source/id, so it
could queue and drain a STALE row (e.g. an old total 100 after repricing to 120). Migration **0064**:

1. **RPC-only privileged transitions (non-spoofable).** The SECURITY INVOKER lifecycle trigger observes
   the real `current_user`. The privileged delivery transitions (`ready→queued`, `queued→sent`,
   `ready→sent`) are allowed only when `current_user` is NOT a PostgREST API role — i.e. inside a
   SECURITY DEFINER delivery RPC (owned by `postgres`, so `current_user` = owner) or a trusted DB admin.
   A direct table UPDATE by `anon`/`authenticated`/`service_role` (which cannot `SET ROLE` to the owner)
   is refused with SQLSTATE 42501. The trigger is deliberately **not** SECURITY DEFINER (that would make
   every caller appear as the owner). `current_user` is not a JWT field, header, application boolean or
   GUC, so it cannot be forged. `complete_outbox_and_advance` / `reconcile_quotation_from_outbox` were
   confirmed to still perform their `queued→sent` / `ready→sent` recovery (their internal UPDATE runs as
   the owner) and remain service-role-only — no replacement was required.
2. **Exact-payload recovery guard.** The `ready` + existing-row path now returns `inconsistent` (leaving
   the quotation `ready`, creating/queuing/draining nothing) unless the existing row matches the request
   on company, source type, source id, idempotency key, channel, recipient, body and message purpose. An
   already-`queued` quotation's original snapshot stays authoritative (no payload rebuild).
3. **Role-based adversarial tests** (`tests/integration/wp12-delivery-boundary.test.ts`, REAL roles): a
   control proves the capability user's legal non-privileged transition succeeds (RLS permits, rowCount
   1), then authenticated AND service-role direct `ready→queued`/`ready→sent` are refused 42501 (proven
   to be the trigger, not an RLS zero-match); the RPC + `complete_outbox_and_advance` succeed; reconcile
   advances only with a matching sent row; `queued→accepted/rejected` stays blocked; `sent→accepted`
   stays allowed; re-pricing works; and the exact-payload recovery (stale body/recipient/channel/purpose
   → `inconsistent`; exact → `duplicate`) is proven through the production RPC.

## 13. Claim boundary + INSERT boundary review (seventh) — what changed

Two residual WP12 boundary gaps remained after §12, both letting a stale/fabricated delivery state reach
"sent" despite §11–§12. Migration **0065** closes them; no other migration behaviour changed.

1. **Quotation-aware claim (`claim_outbox_batch`).** The scheduled drain claimed ANY due outbox row
   without checking the linked quotation, so a `ready` quotation's outbox row left `pending` after §12
   returned `inconsistent` was still claimable + sendable, and `complete_outbox_and_advance` could then do
   `ready→sent` — bypassing the exact-payload guard entirely. A quotation-delivery row is now claimable
   ONLY when `source_type='quotation'` AND `message_purpose='quotation'` AND `source_id` identifies a
   quotation in the SAME company whose status is exactly `queued` (the proof that the atomic enqueue /
   exact recovery actually succeeded). A row that looks like a quotation on EITHER field but has
   mismatched/missing quotation metadata falls through both branches → **fail-closed unclaimable**. Generic
   (non-quotation) rows keep the original retry / lease / `FOR UPDATE SKIP LOCKED` eligibility; the RPC
   stays service-role-only.
2. **Direct-INSERT boundary with a positive owner allowlist.** The §12 trigger was BEFORE UPDATE only, so a
   permitted direct INSERT (authenticated with `sales.quotation.manage`, or `service_role`) could fabricate
   a `queued`/`sent`/`accepted`/`rejected` quotation. A BEFORE INSERT trigger now restricts a non-trusted
   writer to the valid initial state (`status=draft`, `sent_at` null). The trusted-writer signal —
   `_is_quotation_delivery_owner()` — is a **positive** check that `current_user` is the OWNER of the
   delivery functions (from `pg_proc.proowner` of `enqueue_quotation_outbox`), NOT a role-name denylist, so
   a **future custom role** (whose name is not anon/authenticated/service_role) is refused both the
   fabricating INSERT and the privileged `ready→queued`/`ready→sent`/`queued→sent` UPDATE — the exact case a
   denylist would have missed. The UPDATE trigger now also fires on `sent_at`, which is mutable only in the
   owner context.
3. **Bounded DML audit.** `message_outbox` is service-only for writes since **0038** (the 0065 AUDIT NOTE's
   "0048" is corrected by 0066 — see §14), so the queued snapshot cannot be altered by an authenticated
   user; a DELETE that orphans a quotation's outbox row leaves it unclaimable by (1) (no committed `queued`
   quotation → fail closed), so it can never be sent; `sent_at` fabrication is blocked by (2). Documented in
   the migration's closing AUDIT NOTE.
4. **Adversarial tests.** `tests/integration/wp12-claim-boundary.test.ts` (16, REAL service-role drain):
   the stale/`ready` row is not claimed and stays `pending`; it becomes claimable only after exact recovery
   advances `ready→queued`; malformed / cross-company / missing-source / non-existent-source quotation rows
   are unclaimable; ordinary non-quotation rows and failed-retry / lease-expired eligibility are preserved;
   the happy path enqueue→claim→complete still advances `queued→sent`; `authenticated` cannot call the drain
   (42501). `tests/integration/wp12-delivery-boundary.test.ts` (extended): authenticated, service_role AND a
   bespoke custom role are all refused a direct INSERT of any non-`draft` status or a non-null `sent_at`, and
   the custom role is refused the privileged UPDATE and the `sent_at` mutation, while legal transitions still
   work.

## 14. Signature-exact owner + delete boundary + frozen snapshot review (eighth) — what changed

The residual WP12 boundary gaps after §13. Migration **0066**:

1. **Signature-exact trusted-owner check.** `_is_quotation_delivery_owner()` matched
   `enqueue_quotation_outbox` by `proname` + `LIMIT 1` — not signature-exact, so a future overload with a
   different owner could bind. It now resolves the owner from the EXACT 9-arg regprocedure identity, and a
   migration-time DO block **fails closed** unless the three delivery functions (`enqueue_quotation_outbox`
   / `complete_outbox_and_advance` / `reconcile_quotation_from_outbox`) all exist, are all SECURITY DEFINER,
   share ONE owner, and that owner is neither an API role nor `SET ROLE`-reachable by anon/authenticated/
   service_role (`pg_has_role(..., 'MEMBER')`). A fake `enqueue_quotation_outbox(int)` overload owned by
   another role provably cannot flip the decision or open any INSERT/UPDATE/DELETE guard.
2. **Claim-then-DELETE race.** A BEFORE DELETE trigger refuses a non-trusted delete of a quotation whose
   status is queued/sent/accepted/rejected OR that has ANY quotation-linked outbox row
   (pending/processing/failed/sent/dead), so a worker's already-claimed row can never point at a deleted
   quotation. A draft/awaiting_price quotation with no outbox history stays deletable; the trusted owner
   keeps a maintenance override. Because `service_role` also holds TRUNCATE (which bypasses row-level
   triggers) on `quotations`/`quotation_items`, statement-level BEFORE TRUNCATE guards refuse a non-trusted
   `TRUNCATE … CASCADE` too (the bare form is independently FK-protected).
3. **Frozen queued snapshot (quotation + items + the delivered message).** The lifecycle trigger now fires
   on the WHOLE row: for a non-trusted writer a queued/terminal quotation is immutable except a pure
   `sent→accepted`/`sent→rejected` decision (every other column — identifiers, company/order, quote number,
   currency, totals, notes, public token, timestamps — must be byte-for-byte unchanged). `quotation_items`
   of a queued/terminal quotation cannot be inserted/updated/deleted by a non-trusted writer; the item
   triggers read the parent status through a **self-gating** SECURITY DEFINER helper
   (`_quotation_status_for_guard`) that returns a status only to a caller already holding
   `sales.quotation.manage` in that company (or the service worker), so an RLS-invisible parent cannot bypass
   the freeze and the helper is not a cross-company oracle. Additionally the actual delivered row
   `message_outbox` has its CONTENT (recipient/body/template/source/key) frozen against `service_role` while
   its delivery-state (status/attempts/lease/provider id/timestamps) stays worker-mutable, and a non-trusted
   DELETE of a delivery row is refused (anti-stranding). Pre-queue editing/repricing stays functional.
4. **`search_path`/`pg_temp` hardening (from the eighth review's own adversarial security pass).** Postgres
   searches the session temp schema for RELATION names before `pg_catalog`/`public` unless `pg_temp` is
   explicitly listed later, so a caller with the default (PUBLIC) TEMP privilege could
   `CREATE TEMP TABLE pg_proc`/`quotations`/`message_outbox` to shadow the real tables inside a SECURITY
   INVOKER trigger or a `SET search_path = public` SECURITY DEFINER function — forging the owner check or
   hiding real rows (verified exploitable, then verified fixed). Every 0066 function now schema-qualifies
   EVERY relation (`pg_catalog.*`/`public.*`) AND pins `search_path = pg_catalog, public, pg_temp` (pg_temp
   LAST); the WP12 delivery RPCs (`enqueue_quotation_outbox`/`complete_outbox_and_advance`/
   `reconcile_quotation_from_outbox`/`claim_outbox_batch`/`enqueue_outbox_row`) are re-pinned the same way
   via ALTER FUNCTION; and the TRUNCATE guard is extended to `message_outbox`. **Documented residual:** the
   same `SET search_path = public` + unqualified-relation pattern exists in OTHER-domain SECURITY DEFINER
   functions (accounting/approval RPCs); a full-codebase search_path audit is a recommended systemic
   follow-up and is OUT of this WP12 review's bounded scope (not silently applied).
5. **Doc correction.** The `message_outbox` service-only DML boundary originated in migration **0038**
   (`0038_capability_authority.sql` §6 — RLS + drop write policies + REVOKE INSERT/UPDATE/DELETE from
   authenticated), not 0048; 0065's AUDIT NOTE said 0048. 0065 is not rewritten — the 0066 AUDIT NOTE and
   the docs carry the correction.
6. **Reviews.** Independent adversarial-security and regression subagent reviews were run; findings were
   incorporated in one correction loop (the security pass found the `search_path`/`pg_temp` shadowing class,
   the unprotected `message_outbox` content, and the missing TRUNCATE guard — all fixed above; the self-gating
   helper closes a would-be cross-company status oracle; the regression review confirmed the app inserts only
   `draft` quotations, advances delivery only via the SECURITY DEFINER RPCs, never deletes quotations, and
   only edits items pre-queue — so no legitimate path is blocked).

Tests: `tests/integration/wp12-snapshot-boundary.test.ts` (30, REAL roles + a bespoke custom role + a
GENUINE two-connection claim-vs-delete/mutate race + pg_temp-shadowing resistance + message_outbox content
freeze), plus the `secure-definer-grants` allowlist updated to classify the self-gating helper.

## 15. Systemic search_path audit + enqueue-item race review (ninth) — what changed

The eighth review's own adversarial pass surfaced a `search_path`/`pg_temp` shadowing class and I fixed it
for the WP12 functions, flagging the OTHER domains as a systemic follow-up. The ninth review took up that
follow-up and added a genuine concurrency finding. Migration **0067**:

1. **Systemic search_path hardening (Correction 1).** A CATALOG-DRIVEN `ALTER FUNCTION` (operating on the
   final active functions after 0066, not historical text) re-pins EVERY application-owned SECURITY DEFINER
   function and every trigger function in `public` — excluding extension-owned — to
   `search_path = pg_catalog, extensions, public, pg_temp` (pg_catalog first; `extensions` for
   digest/pgcrypto; `public` for app relations; `pg_temp` LAST; no `$user`). This closes the shadowing
   class across the identity-RLS predicate helpers, the accounting RPCs, the approval + supplier-bank-change
   RPCs, the journal internals/fingerprint, and the posted-journal/audit trigger functions — 38 functions on
   the disposable DB, verified 0 unsafe after. Only `search_path` changes (never body/owner/args/return/
   SECURITY-DEFINER/ACL). The migration **fails closed** if anon/authenticated/service_role has CREATE on the
   trusted `public`/`extensions` schemas (it reports; it does not revoke hosted privileges). A PERMANENT
   integration gate (`tests/integration/search-path-safety.test.ts`) fails the build on any future unsafe
   application SECURITY DEFINER / trigger function, and proves cross-domain that `has_capability`/`my_company`/
   `is_admin` cannot be forged via temp memberships/profiles, `decide_approval` cannot be forced via a temp
   `approval_requests`, and `_journal_post_internal` stays service-only + unshadowable.
2. **Quotation-item vs atomic-enqueue race (Correction 2).** `_quotation_status_for_guard()` did an UNLOCKED
   parent read, so a concurrent item mutation could see the pre-commit `ready` status while
   `enqueue_quotation_outbox` queued the already-built message. Closed with one lock order (parent quotation
   before child items): the item-freeze guard now reads the parent `FOR UPDATE`, and enqueue locks the item
   rows and returns `stale` when an itemised quotation's `p_expected_total` diverges from the live
   `SUM(line_total)`. Item-first → `stale` (never sends the old body); enqueue-first → the item mutation
   waits then 42501 (queued). enqueue keeps its exact signature/SECURITY DEFINER owner/service-role-only
   EXECUTE/result semantics; numeric-exact (no float).
3. **Hosted remediation prep (NOT executed).** `hosted_secdef_searchpath_check.sql` (read-only; 0041-staged
   disposable DB → 19/19 unsafe) and `hosted_secdef_searchpath_hardening.sql` (owner-approved, self-verifying,
   exact-regprocedure, abort-on-residual; 0041-staged → 19 unsafe to 0, abort-gate rolls back a simulated
   residual). The migration/scripts do not revoke hosted privileges; the fail-closed CREATE check reports the
   incompatible condition for owner-approved remediation.
4. **Reviews.** Independent adversarial-security + concurrency/regression subagent reviews were run; findings
   incorporated.

Tests: `tests/integration/wp12-enqueue-item-race.test.ts` (7 genuine two-connection races) and
`tests/integration/search-path-safety.test.ts` (7 — the permanent gate + cross-domain pg_temp adversarial).

_Phase status: **verified on disposable PostgreSQL 16 (fresh 0001→0067 + upgrade 0058→0067 with legacy
data); not fully verified on hosted infrastructure** (no staging/production application; GitHub Actions
obtained no runner). Nine external reviews returned CHANGES REQUESTED; all corrected. **Awaiting the
final external review — STOP.**_
