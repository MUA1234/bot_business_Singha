# Phase 1 — 0048+ Security/Accounting Corrections (WP10–WP18) — Ledger

> Blocking prerequisite for the V3.1 program (pack `00A_SECURITY_CORRECTION_PREREQUISITE_0048.md`).
> This ledger tracks the correction phase. Each work package lands as a forward migration `0048+`
> with failing-before/passing-after tests, verified on a disposable PostgreSQL 16 (fresh **and**
> `0047→0048+` upgrade path). `RLS_READS` / `RLS_WRITES` / `WHATSAPP_ASYNC` stay OFF. No hosted action.

> **Phase 1 status: CHANGES REQUESTED (nine times) → corrected, awaiting the FINAL external review.**
> (This summary block enumerates through the fourth review; reviews five–nine are detailed in the
> per-review sections below — fifth **0063**, sixth **0064**, seventh **0065**, eighth **0066**, ninth
> **0067** — and in `PHASE1_CONSOLIDATION_REPORT.md`.)
> The first review found blocking defects in WP12/WP15/WP11 + a branch-integration problem (fixed:
> migrations **0056–0058**). The second review asked for deeper WP12 outbox-state reconciliation,
> WP11 composite DB constraints + money fail-close, WP15 function-privilege, and doc/deployment
> accuracy (fixed: migrations **0059–0060** + WP12 code + docs). The third review asked for a
> concurrency-safe `refreshQuotationStatus`, reconcile-or-fail-closed for a sent-outbox/quotation
> inconsistency, currency validation against a **catalogue**, a concurrency test through the
> **production enqueue RPC**, and doc accuracy incl. removing the "inert while flags OFF" claim (fixed:
> migration **0061** + WP11/WP12 code + docs). The fourth (security-boundary) review asked to lock every
> service-only SECURITY DEFINER function to `service_role` with an allowlist test over ALL of them, to
> make `tryFinalizeAndSend` end-to-end concurrency-safe, to prepare-but-not-execute a hosted privilege
> check + emergency REVOKE for the already-hosted 0038–0041 functions, and to reconcile the docs (fixed:
> migration **0062** + WP12 code + prepared hosted artifacts + docs). All on the integration branch
> `feature/v3-1-phase-1-external-review-fixes` (PR #3 foundation + stack PRs #4–#12 + all four
> correction rounds). **WP11, WP12 and WP15 are NOT re-marked "done" until a review approves them.**
> See the external-review section below and `PHASE1_CONSOLIDATION_REPORT.md`.

## Status

| WP | Correction | Status |
|---|---|---|
| **WP10** | Remove broad company-member writes on commercially sensitive tables | **✅ done — migration 0048** |
| **WP11** | Approval authority: org scope + currency + delegation bounds | **✅ done — migration 0054** |
| **WP12** | Truthful quotation/order delivery state | **✅ done — migration 0055** |
| **WP13** | Posted-journal immutability allowlist | **✅ done — migration 0050** |
| **WP14** | Canonical-JSON idempotency fingerprints (escape/collision-safe) | **✅ done — migration 0051** |
| **WP15** | Invoice/bill document invariants (require lines; verify existing journal) | **✅ done — migration 0052** |
| **WP16** | Reimbursement/payment reuse — full payload validation | **✅ done — migration 0053** |
| **WP17** | Explicit system-actor path (no human `p_by` on the worker path) | **✅ done — migration 0049** |
| **WP18** | Reconcile migration-state / verification docs | **✅ done — docs** |

> Note: the eight WP migrations (0048–0055) landed in the first pass; the **FINAL external review**
> must approve the corrections below (through migration **0067**) before WP11/WP12/WP15 are considered
> done. The Phase-1 consolidation report is `docs/architecture-v3.1/PHASE1_CONSOLIDATION_REPORT.md` (final
> evidence, stamped with the content commit SHA). **Mandatory STOP** before the V3.1 runtime phases (2–10).

## External-review corrections (increment on `feature/v3-1-phase-1-external-review-fixes`)

The first external review returned **CHANGES REQUESTED**. Corrections, each a forward migration with
failing-before (vs reviewed tip `509685b`) / passing-after adversarial tests:

- **B — WP15 source binding (migration 0056).** The existing-journal path of
  `post_customer_invoice`/`post_supplier_bill` validated only company + key + lifecycle, so a retry
  with a changed date/account, or a second document reusing the first's key + journal link, returned
  a false idempotent success. Now the source invariants are checked on both paths and the linked
  journal is returned only when the recomputed **canonical fingerprint** (operation/company/source/
  date/currency/memo/derived-lines) matches the stored journal's (v3/v2/legacy-NULL) and the journal
  is the document's own. Tests: `wp15-source-binding.test.ts` (6; 5 fail on 0055).
- **C — WP11 fail-closed + domain capabilities (migration 0057).** Authority (capability +
  amount/currency/scope) is now enforced for **reject** as well as approve; a missing/cross-company
  event, NULL amount/currency, or unknown domain **fails closed**; a duplicate actor action is a
  conflict on a different action (no state/audit change) and idempotent on the same; audit is written
  only for a persisted action; delegation joins require from/to memberships in `p_company`
  (defence-in-depth over the existing composite FKs). The generic `approve` capability is replaced by
  a deterministic, fail-closed **domain→capability whitelist** (`finance.approve.payment/expense/
  sales/purchase`, catalogue + role map). Tests: `wp11-approval-failclose.test.ts` (6; 5 fail on 0055).
- **A — WP12 truthful delivery end-to-end (migration 0058 + code).** `tryFinalizeAndSend` now reads
  the current state before any refresh (terminal states never regress; `queued` is never re-priced or
  re-enqueued), handles every `enqueueOutbox` result (`enqueued`/`duplicate`/`unavailable`), and
  reports drain failures instead of swallowing them; message history is written **atomically on
  durable send** (with the provider id) by the completion RPC — never pre-completion; `order-intake`
  marks the conversation `quoted` only on `res.sent`. Tests: `wp12-finalize-truthful.test.ts` (9,
  real function via a fake client) + a completion history assertion in `wp12-quotation-delivery.test.ts`.
- **D — documentation reconciliation.** This ledger, `PHASE1_CONSOLIDATION_REPORT.md`,
  `MIGRATION_STATE.md`, `CLAUDE.md` and `CURRENT_IMPLEMENTATION_STATUS.md` agree on the counts,
  latest migration (0058), Phase-1 = changes-requested-until-re-review, hosted = not applied, flags
  OFF, and the WP11 domain-capability status.

## WP10 — done (migration 0048)

**Problem.** `security/rls-classification.json` classified 21 commercially sensitive tables as
`company_member`, so the generic policies from migration 0034 let **any active company member**
insert/update/delete them. An ordinary staff member could change a product price, alter an issued
quotation, edit an approval policy, restructure the organisation, or forge WhatsApp history —
a violation of system invariant #2.

**Fix (`src/db/migrations/0048_wp10_sensitive_write_rls.sql`).**

- Added 9 least-privilege domain capabilities (`sales.catalog.manage`, `sales.quotation.manage`,
  `sales.order.manage`, `sales.pipeline.manage`, `marketing.campaign.manage`,
  `governance.approval_policy.manage`, `documents.manage`, `admin.organisation.manage`,
  `operations.objective.manage`) with a **deny-by-default** role map: `system_administrator` gets
  all; `owner_management` gets the (genuinely company-wide) business-management set; **every other
  role gets none** — including `project_manager`. project_manager is intentionally excluded: these
  capabilities are company-wide as defined here, so granting them to a project manager would
  misrepresent company-wide authority as project-scoped, and no project-scoped authorisation exists
  yet. Scoped capabilities + a scope-aware check are deferred to a later WP.
- Capability-gated 18 tables (`has_capability(company_id, …)` insert/update/delete), dropping the
  generic `has_company_access` writes.
- Made `wa_conversations`, `wa_messages`, `notifications` **service_only** — dropped member write
  policies and `REVOKE INSERT/UPDATE/DELETE … FROM authenticated` (read left intact).
- Updated `security/rls-classification.json` (no table is `company_member` any more) and
  `docs/architecture-v2/RLS_WRITE_POLICY_MATRIX.md`.

**Behaviour change: none at runtime.** `RLS_WRITES` is OFF, so app writes use the service-role
client (bypasses RLS). These policies become the live gate only at the future, owner-gated cutover.

**Tests.**

- `tests/integration/wp10-sensitive-write.test.ts` (9 tests) — adversarial across **INSERT, UPDATE
  and DELETE**: owner_management (with the capability) can insert/update/delete; an ordinary staff
  member, a role-less member and a suspended membership cannot change prices, quotations, approval
  policies, org structure or objectives; WhatsApp history + notifications reject every authenticated
  insert/update/delete; cross-company writes are rejected. UPDATE/DELETE are exercised on
  membership-readable tables (divisions/objectives/approval_policies) so the row-count difference
  isolates the write (capability) gate from the legacy department-based read policy.
- `tests/integration/wp10-classification-policies.test.ts` (3 tests) — classification ↔ enforcement:
  no table remains `company_member`; every `capability` table gates on `has_capability` with no
  generic company-member write; `service_only`/`rpc_only` tables grant `authenticated` no I/U/D.
- `tests/integration/rls-matrix-coverage.test.ts` — extended `mustBeTightened` with the 21 tables so
  a regression to company-member write fails.
- `tests/integration/write-isolation.test.ts` — updated: `leads` is now capability-gated, so the
  isolation actor holds `sales.pipeline.manage`; the property under test (own-company allowed,
  cross-company blocked) is unchanged.

## WP17 — done (migration 0049)

**Problem.** `_resolve_actor(p_by)` recorded a caller-supplied `p_by` as the actor whenever
`auth.uid()` was null — treating **any** "no JWT" caller as a trusted worker. That is a weak trust
boundary: missing/malformed claims, or an unknown role, silently obtained the system path, and a
worker could stamp an **arbitrary human identity** into the ledger (`posted_by`) and audit trail
(`actor_id`) while tagging it `actor_type = 'system'`.

**Fix (`src/db/migrations/0049_wp17_system_actor.sql`).** The system path is reachable **only** by an
explicit `service_role` JWT; everything else is rejected fail-closed:

- `role = 'service_role'` → `actor_type = 'system'`, `actor_id = NULL`, caller-supplied `p_by` **ignored**;
- `role = 'authenticated'` → must carry a subject (`sub`); actor = `sub`; a mismatched `p_by` rejected;
- **missing claims**, **malformed claims**, `anon`, or any **unknown/absent role** → rejected.

`EXECUTE` on `_resolve_actor` is **revoked from `PUBLIC`** (only the SECURITY DEFINER posting RPCs,
running as their definer, call it). The authenticated-user posting path is unchanged. Every posting
RPC derives its actor from this function, so the boundary applies uniformly.

**Consequence handled.** Reimbursement's separation-of-duties self-check (`claimant != actor`) is a
**human** control; a service/worker call has no human maker, so it cannot self-deal. The
`transactional-finance` test now proves self-reimbursement is blocked on the **authenticated** path
(the only path with a human actor), not via the worker path that previously relied on the
now-removed `p_by` impersonation.

**Tests.** `tests/integration/wp17-system-actor.test.ts` (10) — explicit `service_role` → null system
actor; a service_role `p_by` ignored; **missing** claims rejected; **malformed** claims rejected;
authenticated **without a subject** rejected; **anon** rejected; **unknown role** rejected;
authenticated **matching** `p_by` → user; authenticated **mismatch** rejected; and an end-to-end
`service_role` `post_manual_journal` records `posted_by = NULL` + audit `actor_type='system'`,
`actor_id = NULL`, traceable idempotency key. The service-path callers across the existing suite
(`accounting-posting`, `settlement`, `idempotency-lifecycle`, `posting-hardening`, the concurrency
suites, `accounting-rpc-hardening`, `transactional-finance`, `posting-authority`) now present a
`service_role` claim — matching how the real Supabase service-role client is seen by the database.

## WP13 — done (migration 0050)

**Problem.** `block_posted_mutation()` (0044) compared only a **subset** of columns for its allowed
transitions, so a privileged/definer path could change unrelated posted fields (`period_id`,
`exchange_rate`, `source_event_id`, `approval_request_id`, `correlation_id`, `idempotency_key`,
`posted_at`, `created_by`, …) while satisfying the subset check. Separately, the posted-lines guard
fired only on UPDATE/DELETE, so a service-role caller could **INSERT** an extra line into an
already-posted journal (unbalancing it).

**Fix (`src/db/migrations/0050_wp13_posted_journal_immutability.sql`).**

- **Allowlist whole-row header immutability:** each allowed transition names exactly the column(s)
  it may change and requires every other column identical (`to_jsonb(new) - allowed =
  to_jsonb(old) - allowed`). The three transitions are unchanged in intent — (A) reverse the
  original (`status → reversed`); (B) link a reversing entry (`reversal_of_journal_id` NULL→set,
  once); (C) one-time legacy fingerprint upgrade (`idem_fingerprint` NULL→set; a set fingerprint can
  never be replaced).
- **Posted lines immutable to INSERT too:** `block_posted_line_mutation` now fires on INSERT as well
  and rejects any line write whose parent journal is posted. Because the poster previously inserted
  the journal already 'posted' and then added lines, `_journal_post_internal` is restructured to
  insert as **draft**, add lines (parent not posted → allowed), then flip to **posted**. Net posting
  behaviour is unchanged except a posted journal's `version` is 2; no code or test depends on it.

**Tests.** `tests/integration/wp13-journal-immutability.test.ts` (5) — posted delete blocked; ten
header mutations blocked (incl. `exchange_rate`/`correlation_id`/`idempotency_key`/`source_event_id`/
`posted_at`/`created_by` that the old subset trigger permitted); posted lines cannot be
updated/deleted/**inserted**; the reversal transition still works end-to-end; the legacy fingerprint
upgrade is one-time. `idempotency-lifecycle` legacy seed updated to add lines while draft.

## WP14 — done (migration 0051)

**Problem.** `_fp_lines()` (0044) concatenated `account_code,debit,credit,description` with `,`/`;`
delimiters **without escaping**, so a delimiter inside a description/memo could make two distinct
payloads serialise to the same canonical string → one idempotency fingerprint (silent wrong-reuse).

**Fix (`src/db/migrations/0051_wp14_canonical_json_fingerprint.sql`).** The fingerprint is now a
**versioned canonical JSONB** object hashed with SHA-256 (`v3:` prefix). Each line is a JSON object
(never delimiter-joined) — JSON strings are unambiguously quoted, so no field can bleed into another.
Line order is documented **insignificant** (normalized line objects sorted before aggregation).
Compatibility, without reinterpreting stored data: a `v3:` fingerprint compares to the new v3; a
`v2:` fingerprint compares via the original `_fp_full` and is **never replaced** (WP13 immutability);
a legacy `NULL` reconstructs via `_fp_recon` and upgrades once to v3. `_fp_full`/`_fp_recon` retained.

**Tests.** `tests/integration/wp14-canonical-fingerprint.test.ts` (7) — a crafted delimiter collision
that `_fp_lines` (old) hashes identically is distinguished by `_fp_lines_v3`; same payload →
idempotent; reordered lines → same journal; a changed description on the same key → conflict (not
silent reuse); different date/currency → conflict; an existing v2 fingerprint is compared with v2 and
left unchanged (different payload conflicts); a legacy NULL reconstructs, matches, and upgrades to v3.

## WP15 — done (migration 0052)

**Problem.** `post_customer_invoice` / `post_supplier_bill` (0044) had two gaps:

1. the header-vs-line total check ran only `when v_line_total > 0`, so a positive **header** with
   **no detail lines** (line total 0) posted a journal that had **no source lines** — a document
   with nothing behind it still hit the ledger. A negative source line was likewise not rejected
   (the journal was built from the header total, ignoring a `-100` line).
2. an existing `journal_id` was returned as "idempotent success" **before** confirming the linked
   journal is actually *this* document's journal — a mismatched, cross-company, or missing link
   was blindly returned (attaching/leaking an unrelated journal and masking a corrupt lifecycle).

**Fix (`src/db/migrations/0052_wp15_invoice_bill_invariants.sql`).** `CREATE OR REPLACE` of both
RPCs (no data change):

- A new post requires **≥ 1 source line**, a **positive header**, **header = line total**
  (unconditional — no longer gated on `v_line_total > 0`), and **no negative line amount**;
  journal + document update + audit remain one transaction, and nothing is marked issued/approved
  if any invariant fails.
- The idempotent return happens **only after** verifying the linked journal exists **in this
  company**, its `idempotency_key` equals **this document's** posting key, and the document
  lifecycle is consistent (invoice `issued` / bill `approved`); otherwise it is refused
  (`missing or cross-company`, `binding mismatch`, or `lifecycle inconsistent`).

**Tests.** `tests/integration/wp15-invoice-bill-invariants.test.ts` (11) — header-only invoice and
bill refused (no journal, document stays draft); non-positive header refused; negative line refused;
header≠line-total refused for invoice **and** bill; a valid invoice posts once and is idempotent; a
valid bill posts and moves to `approved`; and the three journal-binding guards — a journal that
belongs to another document (`binding mismatch`), a journal in another company
(`missing or cross-company`), and a right-key journal with an inconsistent lifecycle
(`lifecycle inconsistent`) — are each refused rather than returned. Against the pre-fix schema
(0051) **7 of the 11 fail** (the four already-caught cases — mismatched *positive* line totals and
the valid posts — pass on both). Existing invoice/bill seeds in `transactional-finance`,
`idempotency-lifecycle`, `posting-authority` and `finance-concurrency` now add a matching source
line so their headers satisfy the invariant.

## WP16 — done (migration 0053)

**Problem.** `reimburse_expense_claim` (0044) validated reuse only partially:

1. the **already-reimbursed** branch returned the prior journal from an arbitrary
   `reimbursements → payments` join **without** confirming the reimbursement, payment, claim and
   journal form one consistent, source-bound chain — a corrupt/partial chain, or a claim merely
   **marked** `reimbursed` with no payment at all, was returned as success, and the supplied
   date/key/accounts were ignored;
2. the **payment-reuse** check compared only `party_id`, `amount`, `currency` and `direction` — not
   `party_type`, payment date, status, method, or the **journal binding** — so a key reused with a
   different payment date/method/status, or a stray payment attached to a different journal, slipped
   through as "the same payment".

**Fix (`src/db/migrations/0053_wp16_reimbursement_reuse_validation.sql`).** `CREATE OR REPLACE`
(same signature, so existing grants hold; no data change). On **any** reuse the full material
payload is validated — company (scope), source claim, `party_type = 'employee'`, party id, amount,
currency, direction, payment date, journal id, status, method, and the **effective idempotency
key** — and the source-bound journal is re-derived through `_journal_post_internal`, which binds
company, source claim, date, currency and lines under this key (WP14) and so supplies the canonical
source fingerprint. The prior result is returned **only** when the whole chain is consistent;
otherwise a conflict is raised. The capability gate, approved-only lifecycle, and
separation-of-duties (human maker ≠ claimant) are unchanged.

**Tests.** `tests/integration/wp16-reimbursement-reuse.test.ts` (8) — a valid identical retry
returns the original journal (exactly one payment/reimbursement); the same key cannot reimburse a
second claim; an already-reimbursed claim whose payment chain was altered in **any** material field
(date, method, currency, direction, status, amount, party) is refused; an altered reimbursement row
is refused; a claim **marked** reimbursed with no chain is refused (not returned as success); a
stray pre-existing payment bound to a different journal is refused on the fresh path; a human cannot
reimburse their own claim (authenticated path); and a **second concurrent** reimbursement **blocks**
on the claim `FOR UPDATE` lock (two live connections) — so exactly one payment, reimbursement and
journal result. Against the pre-fix schema (0052) the **4 full-payload/chain tests fail**; the
valid-retry, cross-claim, SoD and concurrency cases pass on both.

## WP11 — done (migration 0054)

**Problem.** `decide_approval` / `within_authority` (0046) checked capability, maker-checker,
lifecycle, amount, currency and domain, but:

1. it did **not** enforce **organisational scope** — a division/project/site/cost-centre-restricted
   approver could approve an event allocated to a scope they do not control, an event could be
   **split** across allocations to dodge scope, and the amount ceiling was not clearly compared to
   the **whole** event; and
2. the delegated-authority branch checked the **delegation's** currency but **not the delegator's
   own** `authority_rules.currency` against the event — a currency-restricted delegator could confer
   effective authority in another currency (Problem #2).

**Fix (`src/db/migrations/0054_wp11_approval_scope_currency_delegation.sql`).** Additive schema +
a new event-aware authority function (no data reinterpretation):

- `authority_rules` and `delegations` gain an explicit **`is_company_wide`** flag and
  `division_id` / `project_id` / `site_id` / `cost_centre_id` scope columns. Existing rows default
  to `is_company_wide = false` with NULL scope — they authorise **nothing** until an owner
  explicitly scopes them (**no silent widening** to company-wide).
- **`within_authority_for_event(company, financial_event)`** (deny-by-default) evaluates, for
  `auth.uid()`: active membership; domain; **strict** event currency (a NULL rule/delegation
  currency is **not** a wildcard); the **whole-event** amount vs the ceiling (splitting cannot
  bypass it); **every** allocation within an authorised scope (via `_scope_covers`); explicit
  **company-wide** authority when the event has no allocations; and a delegation bounded by its
  validity window, amount, currency **and** by being a **subset** of the delegator's own
  currency-matched, sufficient, active authority. `decide_approval` now authorises a financial
  event through this function.
- **Requirement #8 — now IMPLEMENTED** (external-review correction C, migration 0057). The generic
  `approve` capability is replaced for financial-event decisions by a deterministic, fail-closed
  **domain→capability whitelist** (`finance.approve.payment/expense/sales/purchase`; catalogue + role
  map + the pure `_approval_capability` mapping; no AI chooses the capability). The permission-catalogue
  change was **explicitly owner-authorised for the correction increment** (code only; not enabled in
  any hosted environment). (This supersedes the first-pass note that deferred #8.)

**Tests.** `tests/integration/wp11-approval-scope-authority.test.ts` (10) — no rule and unscoped
non-company-wide both denied; explicit company-wide approves within domain/amount/currency; each
scope dimension (division/project/site/cost-centre) enforced (A approves A, not B); a mixed-scope
event denied if any allocation is outside authority; splitting cannot bypass the whole-event
ceiling; strict currency (LKR cannot approve USD); a delegation is bounded by the delegator's
currency, scope and the lower of the two ceilings; expired delegation, suspended delegator and
suspended delegate denied; `decide_approval` end-to-end (company-wide approves, out-of-scope denies,
maker-checker holds); and a second concurrent final approval **blocks** on the request `FOR UPDATE`
lock (two connections). A **Problem #2 witness** shows the retained old `within_authority` accepts a
currency the delegator lacks while the new function denies it. Against the pre-0054 schema the suite
cannot run (the scope columns/function do not exist) — the enforced behaviour is entirely new.
`approval-authority.test.ts` updated: its company-wide approvers now carry an explicit
`is_company_wide=true` + currency, matching the new secure model.

## WP12 — done (migration 0055)

**Problem.** `tryFinalizeAndSend()` enqueued a WhatsApp message, ran a best-effort inline outbox
drain, and then **immediately** marked the quotation `sent`, the order `quoted` and the conversation
`quoted`, returning `{ sent: true }` **even when the provider send or the durable completion had
failed**. The commercial document lied about delivery, and the `DrainResult` was swallowed.

**Fix (`src/db/migrations/0055_wp12_truthful_delivery_state.sql` + TS).**

- `message_outbox` gains `source_type` / `source_id` / `message_purpose` (no secrets) so a completed
  send advances the exact linked document. `quotations.status` gains an explicit **`queued`** state
  (`draft → awaiting_price → ready → queued → sent`).
- **`complete_outbox_and_advance(outbox_id, lease_owner, provider_message_id)`** — a fenced,
  service-only RPC that **atomically**: verifies the outbox id + lease owner (only a `processing`
  row this worker owns), records the provider message id, flips the outbox row to `sent`, advances
  the linked quotation → `sent` / order → `quoted` / conversation → `quoted` (company-scoped, so a
  cross-company source id can never be linked/advanced; terminal order/conversation states are never
  regressed), and writes a non-sensitive audit event. Returns TRUE only when exactly one owned row
  was completed; a zero-row / wrong-lease / duplicate call returns FALSE and advances nothing.
- `tryFinalizeAndSend` now marks the quotation **`queued`** on enqueue (tagging the outbox with its
  source), **propagates the `DrainResult`**, and returns `sent` only if the quotation actually
  reached `sent`. `drainOutbox` completes a `sent` row through the RPC. Delivery is documented
  **at-least-once** — a provider-success / DB-failure window can still cause a retry; a lease does
  **not** make duplicate external delivery impossible. `delivered` (a future state) may only come
  from a verified provider callback.

**Tests.** `tests/integration/wp12-quotation-delivery.test.ts` (9) — a quotation stays `queued`
until completion (a provider failure never advances it); provider success + fenced completion marks
quotation `sent` / order `quoted` / conversation `quoted` + provider id + audit; a wrong-lease or
zero-row completion returns false and advances nothing; the same row completes **at most once**
(no double-advance); an expired lease reclaimed by a new owner completes truthfully while the old
owner cannot; a retry does not create a second outbox row (unique dedupe key); a failed/dead message
stays visible for operator recovery; a **cross-company** source id marks its own outbox sent but
never advances the other company's quotation; and a **second concurrent** completion **blocks** on
the row lock (two connections). The `outbox-drain` unit test now asserts the RPC-based completion.
Against the pre-0055 schema the suite fails (`quotations_status_check` rejects `queued`; the RPC does
not exist) — the truthful model is new.

## WP18 — done (documentation)

**Problem.** The migration-state docs contradicted one another about whether `0038–0043` were
applied to the hosted database, and the verification evidence was stamped at an earlier correction
commit while later fixes had landed.

**Fix (no migration).**

- `docs/architecture-v2/MIGRATION_STATE.md` is reaffirmed as **the** authoritative applied-state
  record: the five states — *file exists*, *tested on disposable DB*, *applied to staging*, *applied
  to production*, *feature flag enabled* — are tracked separately and never conflated; a per-migration
  table now covers `0048–0055`, plus an explicit five-state grid for the correction phase. The
  `0038–0043` contradiction is **reconciled**: `0038–0041` were owner-applied 2026-08-07; everything
  from `0042` onward is **"owner confirmation required"** (dev-verified on disposable PG only). The
  migration **runner** (`npm run migrate` + `schema_migrations`) is the source of execution; the
  combined `RUN_*.sql` files are non-authoritative.
- `docs/architecture-v3.1/PHASE1_CONSOLIDATION_REPORT.md` is the **final verification evidence** for
  the phase (stamped with the final commit SHA + PostgreSQL 16.13; fresh + upgrade counts; the §8
  required final response). `VERIFICATION_EVIDENCE.md` and `CURRENT_IMPLEMENTATION_STATUS.md` point
  to it.

**No hosted ledger was queried** (owner authorisation not given); hosted state is recorded as owner
confirmation required rather than inferred from files, local tests, or any deployment.

## Final (third) external review — bounded corrections (migration 0061 + code + docs)

CHANGES REQUESTED, bounded. Do not merge; do not begin Phase 2. Five items, all addressed:

1. **`refreshQuotationStatus` is concurrency-safe.** The allowed-current-status condition is now **on
   the UPDATE itself** (`… .in("status", ["draft","awaiting_price","ready"])`), so a `queued` or
   terminal (`sent`/`accepted`/`rejected`) quotation receives **zero mutations — status AND totals** —
   even if it transitions between the item read and the write. Tests: terminal-total zero-mutation
   across all four guarded states + a read→update race (`tests/wp12-finalize-truthful.test.ts`).
2. **Sent-outbox / source inconsistency.** When the outbox row is `sent` but the quotation is not, the
   finaliser reconciles atomically through the **idempotent, service-only `reconcile_quotation_from_outbox`
   RPC**; if it cannot make them consistent it **fails closed** with `outbox_source_inconsistent` +
   operator-visible logging. `already_sent` is **never** returned with `sent=false`. Tests: consistent
   (`sent:true`), inconsistent→reconciled (`sent:true`), inconsistent→fail-closed (`sent:false`, never
   `already_sent`).
3. **Currency validated against a catalogue.** The `currencies` reference table (migration 0002, then
   unseeded) becomes the supported-currency catalogue: `is_active` added, 16 ISO codes seeded,
   read-only for app roles. `decide_approval` fails closed unless the event currency is an active
   catalogue row — a well-formed but unseeded `ZZZ` (which the old three-letter regex accepted) is now
   rejected. Tests: `ZZZ` + `1XA` rejected, `LKR` passes (`tests/integration/wp11-composite-money.test.ts`).
4. **Concurrency test through the production path.** The raw duplicate-insert test is replaced by a
   two-connection test of the atomic **`enqueue_outbox_row`** RPC (one `enqueued`, one `duplicate`,
   exactly one row) — and a unit test proves the **real `enqueueOutbox` wrapper invokes that RPC**
   (`tests/outbox-enqueue.test.ts`), so the concurrency guarantee is on the production path, not a
   hand-rolled insert.
5. **Documentation accuracy.** Migration range `0001–0061`; unit **420 (79 files)** / integration
   **34 files / 182 tests**; disposable-local Postgres 16 evidence (fresh + upgrade); hosted state
   `0042–0061` = owner confirmation required, `0038–0041` owner-applied 2026-08-07; automatic Vercel
   **Preview** vs no production deployment. **The incorrect blanket claim that every migration/runtime
   change is inert while the flags are OFF is removed** and replaced with the accurate split (only the
   RLS read/write cutover is flag-inert; the WP12 delivery path runs with `WHATSAPP_ASYNC` OFF, and the
   `decide_approval` fail-close, composite FKs, function REVOKEs and currency catalogue are active for
   any caller/writer once migrated — the safety guarantee is the **un-migrated hosted DB**, not a flag).

Migration **0061** internals worth noting for review: `enqueue_outbox_row` uses `INSERT … ON CONFLICT
(idempotency_key) DO NOTHING` (the key is a globally-unique SHA) with `p_template_params jsonb`
(matching the `message_outbox.template_params` column type); both new RPCs are **service-only**
(EXECUTE revoked from `public`, `authenticated`, `anon`; granted to `service_role`) because Supabase /
the test shim grant EXECUTE on public functions to `authenticated` by default.

## Fourth (security-boundary) external review — migration 0062 + WP12 code + prepared hosted artifacts

CHANGES REQUESTED, bounded. Do not merge; do not begin Phase 2; do not migrate hosted / deploy / enable
flags. Three items, all addressed:

1. **SECURITY DEFINER audit + lockdown (migration 0062).** Every service-only / internal function is
   revoked from PUBLIC, `anon` and `authenticated` and granted only `service_role`:
   `_journal_post_internal` (incl. its legacy 7-arg signature — caught by the name-based loop and an
   explicit `to_regprocedure` guard), `claim_outbox_batch(integer,text,integer)`,
   `complete_outbox_and_advance(uuid,text,text)`, `ledger_integrity_report(uuid)`, `_journal_fp_matches`,
   `enqueue_outbox_row`, `reconcile_quotation_from_outbox`. Idempotent + upgrade-safe. Deliberately left
   executable (documented + asserted): RLS predicate helpers and the authenticated write-path RPCs.
   Tests (`tests/integration/secure-definer-grants.test.ts`): an **allowlist over ALL** SECURITY DEFINER
   functions (fails on any unclassified one); the grant matrix; and `42501` proofs that an authenticated
   caller cannot create a journal, claim/read an outbox batch, read the cross-company integrity report,
   or complete an outbox row — while `service_role` retains execution.
2. **`tryFinalizeAndSend` end-to-end concurrency-safe.** No longer assumes `ready` after
   `refreshQuotationStatus` returns `awaiting=false`; it **re-reads** the real status+total after the
   guarded update. Race to `sent`/`accepted`/`rejected` → stop, zero enqueue/send; race to `queued` →
   reconcile only the existing outbox row; new enqueue only while still `ready`. The message is built
   from the **freshly-persisted total** (not `quote.total`) and formatted **without a JS `Number`**
   (Decimal → string). Unit tests: each race (queued/sent/accepted/rejected before the guarded update)
   creates no outbox row / no delivery, and a stale/zero total sends the newly-calculated total.
3. **Hosted 0038–0041 — prepared, NOT executed.** `docs/architecture-v2/hosted_secdef_privilege_check.sql`
   (read-only), `hosted_secdef_emergency_revoke.sql` (owner-approval-required break-glass) and
   `HOSTED_SECDEF_PRIVILEGE_HOTFIX.md` (evidence: a 0041-staged disposable DB shows the legacy
   `_journal_post_internal`, `claim_outbox_batch` and `ledger_integrity_report` are
   `authenticated`-executable before the hotfix and locked after). Docs reconciled (one 0038–0041 hosted
   statement; 0042–0062 separate; GitHub Actions obtained no runner; Vercel Preview vs no prod; stale
   195/current-state wording removed).

## Fifth external review — migration 0063 (atomic enqueue + lifecycle) + code + docs

CHANGES REQUESTED, bounded. Do not merge; do not begin Phase 2; do not migrate hosted / deploy / enable
flags / run the hosted scripts against hosted. Four items, all addressed:

1. **Atomic quotation enqueue (migration 0063).** The fourth review's application re-read left a
   time-of-check/time-of-use window. The new service-only `enqueue_quotation_outbox` RPC closes it at
   the DB: it LOCKS the company-scoped quotation row (linearization point), inspects the authoritative
   status under that lock, verifies the caller's total/currency still match, and — only if still legally
   `ready` — inserts the outbox row AND advances `ready→queued` in ONE transaction (rolled back together
   on failure). Results: `enqueued`/`duplicate`/`terminal`/`not_ready`/`stale`/`inconsistent`.
   `tryFinalizeAndSend` branches on the result and never drains on terminal/not_ready/stale/inconsistent;
   the generic `enqueue_outbox_row` path is unchanged for non-quotation messages. A BEFORE UPDATE trigger
   enforces the legal quotation lifecycle at the DB boundary (`queued` can never jump to accepted/rejected).
   Tests (`tests/integration/wp12-atomic-enqueue.test.ts`, real two connections): terminal-wins → zero
   rows; enqueue-wins → one row + queued and a concurrent `queued→accepted` FAILS; two finalisers → one
   logical row; plus single-connection stale/inconsistent(cross-company key)/duplicate/atomicity-rollback
   and the lifecycle trigger. Unit orchestration is in `tests/wp12-finalize-truthful.test.ts`.
2. **Signature-exact SECURITY DEFINER allowlist.** `secure-definer-grants.test.ts` classifies by exact
   `regprocedure` identity (name + arg types), so a new overload of an approved name fails the allowlist;
   `enqueue_quotation_outbox` is service-only (+ its own 42501 test).
3. **Self-verifying emergency hotfix.** `hosted_secdef_emergency_revoke.sql` now ASSERTS zero residual
   anon/authenticated EXECUTE in-transaction and RAISES (aborting) if any remains — a partial lockdown
   can never COMMIT. Wording fixed ("owner approval REQUIRED before execution"; **catalog-driven**, not
   `to_regprocedure`). Proven on a 0041-staged DB (exposed → locked; simulated residual → ROLLBACK).
4. **Docs reconciled.** Canonical range fixed to `0001–0063` (MIGRATION_STATE.md no longer says "ends at
   0055"); 0038–0041 owner-reported-applied-2026-08-07-unverified preserved; 0042–0063 owner confirmation
   required; hosted scripts prepared-not-executed; GitHub Actions obtained no runner (no CI-pass);
   automatic Vercel Preview ≠ production; counts from actual runs; the "end-to-end concurrency-safe"
   claim now attributed to the atomic RPC (0063), not the fourth review's re-read.

## Sixth external review — migration 0064 (delivery-transition boundary + exact-payload recovery)

CHANGES REQUESTED, bounded — two WP12 database-integrity gaps. Do not merge; do not begin Phase 2; do
not migrate hosted / deploy / enable flags / run the hosted scripts against hosted. Both addressed:

1. **Privileged delivery transitions are RPC-ONLY (migration 0064).** The 0063 lifecycle trigger still
   permitted a DIRECT table `ready→queued` / `ready→sent`, so a permitted table writer (an authenticated
   user with `sales.quotation.manage`, or `service_role`) could create a queued quotation with no outbox
   row, or mark one sent without provider completion. The SECURITY INVOKER trigger now allows those
   transitions (and `queued→sent`) only when `current_user` is NOT a PostgREST API role — i.e. inside a
   SECURITY DEFINER delivery RPC (`current_user` = owner) or a trusted DB admin — refusing a direct
   authenticated/`service_role` UPDATE with SQLSTATE 42501. Non-spoofable: the API roles cannot `SET ROLE`
   to the owner, the trigger is not SECURITY DEFINER, and `current_user` is not a JWT/header/GUC.
   `complete_outbox_and_advance` / `reconcile_quotation_from_outbox` still recover `queued→sent` /
   `ready→sent` (owner-run) and stay service-role-only; no replacement required.
2. **Exact-payload recovery guard.** `enqueue_quotation_outbox`'s `ready` + existing-row path now returns
   `inconsistent` (leaving the quotation `ready`, creating/queuing/draining nothing) unless the existing
   row matches on company/source type/source id/idempotency key/channel/recipient/body/message purpose —
   so a stale/legacy row (e.g. old total 100 after repricing to 120) is never queued or drained. An
   already-`queued` quotation's original snapshot stays authoritative.

Tests: `tests/integration/wp12-delivery-boundary.test.ts` — REAL roles (a control proves RLS permits the
capability user; authenticated AND service-role direct `ready→queued`/`ready→sent` refused 42501, proven
to be the trigger not an RLS zero-match; RPC + completion succeed; reconcile only with a matching sent
row; `queued→accepted/rejected` blocked; `sent→accepted` allowed; re-pricing works; exact-payload vs
stale-payload recovery through the production RPC).

## Seventh external review — migration 0065 (claim boundary + INSERT boundary + positive owner allowlist)

CHANGES REQUESTED, bounded — two residual WP12 boundary gaps (plus a DML audit). Do not merge; do not
begin Phase 2; do not migrate hosted / deploy / enable flags / run the hosted scripts against hosted.
Both closed:

1. **The scheduled drain cannot pick up a stale recovery row (migration 0065).** `claim_outbox_batch`
   claimed ANY due row without checking the linked quotation, so a `ready` quotation's outbox row left
   `pending` after 0064 returned `inconsistent` was still claimable + sendable, and
   `complete_outbox_and_advance` could then do `ready→sent` — bypassing the exact-payload guard. The claim
   is now **quotation-aware**: a quotation-delivery row (either `source_type` or `message_purpose` is
   `quotation`) is claimable ONLY when `source_type='quotation'` AND `message_purpose='quotation'` AND
   `source_id` identifies a quotation in the SAME company whose status is exactly `queued`; any
   either-field-`quotation`-with-mismatch falls through both branches → **fail-closed unclaimable**. Generic
   (non-quotation) rows keep the original retry / lease / `FOR UPDATE SKIP LOCKED` eligibility, and the RPC
   stays service-role-only.
2. **The direct-INSERT lifecycle bypass is closed with a positive owner allowlist (migration 0065).** The
   0064 trigger was BEFORE UPDATE only, so a permitted direct INSERT (authenticated with
   `sales.quotation.manage`, or `service_role`) could fabricate a `queued`/`sent`/`accepted`/`rejected`
   quotation. A BEFORE INSERT trigger now restricts a non-trusted writer to the valid initial state
   (`status=draft`, `sent_at` null). The trusted-writer signal is `_is_quotation_delivery_owner()` — a
   **positive** check that `current_user` is the OWNER of the delivery functions (derived from
   `pg_proc.proowner` of `enqueue_quotation_outbox`), NOT a role-name denylist — so a **future custom role**
   (whose name is not anon/authenticated/service_role, which a denylist would have let through) is refused
   both the fabricating INSERT and the privileged `ready→queued`/`ready→sent`/`queued→sent` UPDATE. `sent_at`
   is mutable only in the owner context (the UPDATE trigger now fires on `status` OR `sent_at`).
3. **Bounded DML audit.** `message_outbox` is service-only for writes (0048), so the queued snapshot cannot
   be altered by an authenticated user; a DELETE that orphans a quotation's outbox row leaves it
   unclaimable by (1) (no committed `queued` quotation → fail closed), so it can never be sent; `sent_at`
   fabrication is blocked by (2). Documented in the migration's closing AUDIT NOTE.

Tests: `tests/integration/wp12-claim-boundary.test.ts` (16 — REAL service-role drain: a stale/`ready`
quotation row is not claimed and stays `pending`; the same row becomes claimable only after exact recovery
advances `ready→queued`; malformed / cross-company / missing-source / non-existent-source rows are
unclaimable; ordinary non-quotation rows and failed-retry / lease-expired eligibility are preserved; the
happy path enqueue→claim→complete still advances `queued→sent`; `authenticated` cannot call the drain,
42501) and `tests/integration/wp12-delivery-boundary.test.ts` (extended: authenticated, service_role AND a
bespoke **custom role** are all refused a direct INSERT of any non-`draft` status or a non-null `sent_at`;
the custom role — which a denylist would miss — is refused the privileged UPDATE and the `sent_at` mutation;
legal transitions still work).

## Eighth external review — migration 0066 (signature-exact owner + delete boundary + frozen snapshot)

CHANGES REQUESTED, bounded — the residual WP12 boundary gaps. Do not merge; do not begin Phase 2; do not
migrate hosted / deploy / enable flags / run the hosted scripts against hosted. All closed:

1. **Signature-exact trusted-owner check.** 0065's `_is_quotation_delivery_owner()` matched
   `enqueue_quotation_outbox` by `proname` + `LIMIT 1` — not signature-exact, so a future overload with a
   different owner could have been selected. It now resolves the owner from the EXACT 9-arg regprocedure
   identity `enqueue_quotation_outbox(uuid,uuid,text,text,text,numeric,text,text,text)`, and a
   migration-time DO block **fails closed** unless the three exact delivery functions
   (`enqueue_quotation_outbox` / `complete_outbox_and_advance` / `reconcile_quotation_from_outbox`) all
   exist, are all SECURITY DEFINER, share ONE owner, and that owner is neither an API role nor
   `SET ROLE`-reachable by anon/authenticated/service_role (`pg_has_role(..., 'MEMBER')`). A fake
   `enqueue_quotation_outbox(int)` overload owned by another role cannot change the decision (proven).

2. **Claim-then-DELETE race.** 0065 prevents a stale row from being newly claimed, but a worker could
   claim a `queued` row (→ processing), then a non-trusted writer deletes the quotation, then the worker
   sends a body whose quotation no longer exists. A BEFORE DELETE trigger now refuses a non-trusted delete
   of a quotation whose status is queued/sent/accepted/rejected OR that has ANY quotation-linked outbox row
   (pending/processing/failed/sent/dead). A draft/awaiting_price quotation with no outbox history stays
   deletable; the trusted owner keeps a maintenance override. Statement-level BEFORE TRUNCATE guards on
   `quotations`/`quotation_items` close the TRUNCATE bypass (service_role holds TRUNCATE, which skips
   row-level triggers).

3. **Frozen queued snapshot.** Once queued, the customer-facing content must not change while the outbox
   message is live. For non-trusted writers, a quotation in queued/sent/accepted/rejected is immutable
   except a pure `sent→accepted`/`sent→rejected` decision (the whole-row BEFORE UPDATE trigger now fires on
   every column, not just status/sent_at); its `quotation_items` cannot be inserted/updated/deleted either.
   The item triggers read the parent status through a **self-gating** SECURITY DEFINER helper
   (`_quotation_status_for_guard`) so an RLS-invisible parent cannot bypass the freeze, while the helper
   returns a status only to a caller who already holds `sales.quotation.manage` in that company (or the
   service worker) — never a cross-company oracle. Additionally the delivered `message_outbox` row has its
   CONTENT (recipient/body/template/source/key) frozen against `service_role` while delivery-state stays
   worker-mutable, and a non-trusted DELETE of a delivery row is refused (anti-stranding). Pre-queue
   editing/repricing stays functional.

4. **`search_path`/`pg_temp` hardening (from the eighth review's own adversarial security pass).** A caller
   with the default PUBLIC TEMP privilege could `CREATE TEMP TABLE pg_proc`/`quotations`/`message_outbox` to
   shadow the real tables (pg_temp is searched for relations before `pg_catalog`/`public` unless listed
   later) inside a trigger/function — forging the owner check or hiding rows (verified exploitable → fixed).
   Every 0066 function schema-qualifies its relations AND pins `search_path = pg_catalog, public, pg_temp`;
   the WP12 delivery RPCs are re-pinned via ALTER FUNCTION; the TRUNCATE guard covers `message_outbox` too.
   **Documented residual:** the same pattern exists in OTHER-domain SECURITY DEFINER functions (accounting/
   approval); a full-codebase search_path audit is a recommended systemic follow-up, OUT of this WP12
   review's bounded scope.

5. **Doc correction.** The `message_outbox` service-only DML boundary originated in migration **0038**
   (`0038_capability_authority.sql` §6), not 0048; 0065's AUDIT NOTE said 0048. 0065 is not rewritten — the
   0066 AUDIT NOTE and the docs carry the correction.

Tests: `tests/integration/wp12-snapshot-boundary.test.ts` (30 — REAL roles + a bespoke custom role +
a GENUINE two-connection race): the fake-overload owner check; DELETE refused for queued/terminal/
outbox-history quotations across authenticated/service_role/custom; a draft-with-no-outbox stays deletable;
the owner maintenance override; the frozen-column list (notes/total/public_token/quote_number/currency);
`sent→accepted` status-only allowed but `sent→accepted`+field refused; sent_at fabrication still blocked;
pre-queue repricing works; `quotation_items` INSERT/UPDATE/DELETE frozen on a queued parent but editable on
a draft; a two-connection test where conn A (service_role worker) claims + commits, conn B cannot delete or
mutate the quotation / its items, and the worker still completes `queued→sent`; **pg_temp relation shadowing
cannot forge the owner check or hide outbox history**; and **message_outbox content is frozen to service_role
while delivery-state stays mutable**. Independent adversarial-security + regression subagent reviews were run
and their findings incorporated in one correction loop.

## Ninth external review — migration 0067 (systemic search_path audit + enqueue-item race)

CHANGES REQUESTED — the systemic follow-up the eighth review flagged, plus a genuine concurrency gap. Do
not merge; do not begin Phase 2; do not migrate hosted / deploy / enable flags / run the hosted scripts.

1. **Full application-function search_path audit (Correction 1).** Migration 0066 proved the
   `SET search_path = public` + unqualified-relation → `pg_temp` relation-shadowing class; it is NOT WP12-
   specific. A CATALOG-DRIVEN `ALTER FUNCTION` (operating on the FINAL active functions after 0066, not a
   text search) re-pins EVERY application-owned SECURITY DEFINER function and every trigger function in
   `public` — identity/RLS predicate helpers (`has_capability`/`my_company`/`is_admin`/…), the accounting
   RPCs (`post_manual_journal`/`post_customer_invoice`/`post_supplier_bill`/`settle_*`/`reverse_journal`/
   `reimburse_expense_claim`/`_journal_post_internal`/`_journal_fp_matches`), the approval + bank-change
   RPCs (`decide_approval`/`request_supplier_bank_change`/`decide_supplier_bank_change`), the integrity
   report, and the posted-journal/audit trigger functions — to `search_path = pg_catalog, extensions,
   public, pg_temp` (pg_catalog first; `extensions` for digest/pgcrypto; `public` for app relations;
   `pg_temp` LAST; no `$user`). Extension-owned functions are EXCLUDED. Only `search_path` changes — never
   body/owner/args/return/SECURITY-DEFINER/ACL. Selection is by `pg_has_role(current_user, proowner,
   'USAGE')` — NOT a strict `proowner = current_user` match, which would silently skip functions applied
   out-of-band under a different owner (the hosted 0038–0041 case) while the disposable CI database, where
   one session owns everything, still reported success — and the migration then SELF-VERIFIES
   owner-agnostically: if ANY in-scope function remains unsafe (e.g. a foreign owner the session cannot
   alter), it ABORTS naming the function(s), so a silent partial hardening is impossible (empirically
   simulated: a non-superuser migration role + a foreign-owned unsafe function → abort naming
   `foreign_unsafe()`; granting the owner role → hardened + clean pass). The migration **fails closed** if
   anon/authenticated/service_role has CREATE — direct, PUBLIC-granted, or SET-ROLE-reachable via role
   membership (which `has_schema_privilege` alone does not count for NOINHERIT roles; empirically
   simulated → abort naming the reachable path) — on the trusted `public`/`extensions` schemas (it
   reports; it does not revoke hosted privileges blindly). A PERMANENT owner-agnostic integration gate —
   `tests/integration/search-path-safety.test.ts` — fails the build whenever a future SECURITY DEFINER /
   trigger function in `public` (ANY owner, extension-owned excluded) has an unsafe path, where unsafe
   includes a duplicated `pg_temp` whose FIRST occurrence is not the final element (resolution uses the
   first occurrence, so `pg_temp, …, pg_temp` is unsafe despite ending in `pg_temp`; the gate proves it
   catches both a foreign-owned unsafe function and the duplicated-`pg_temp` path).

2. **Quotation-item vs atomic-enqueue race (Correction 2).** 0066 froze `quotation_items` after the parent
   is visibly queued, but `_quotation_status_for_guard()` did an UNLOCKED parent-status read, so a concurrent
   item mutation could still see the pre-commit `ready` status while `enqueue_quotation_outbox` queued the
   already-built message — a committed queued snapshot could disagree with committed items. Closed at the DB
   linearization boundary with a SINGLE lock — the parent quotation row: (a) the item-freeze guard helper
   reads the parent `FOR UPDATE`, so every non-trusted item INSERT/UPDATE/DELETE serializes on the quotation
   row that enqueue already locks; (b) `enqueue_quotation_outbox` takes NO item-row locks — the target item
   row is locked by Postgres BEFORE its row trigger fires, so an enqueue that then locked item rows would
   form a genuine parent→child vs child→parent AB-BA deadlock (found by the pre-submission adversarial
   pass, reproduced on a disposable local PostgreSQL 16; one lock object cannot form a cycle) — and, under the parent
   lock, requires UNCONDITIONALLY that the caller's expected total equal the live `SUM(line_total)`: there
   is NO item-count exemption (the adversarial pass showed the earlier `v_item_count > 0` guard let a
   delete-ALL-items race ship a customer-facing total backed by zero items — now sum 0 ≠ a non-zero total →
   `stale`), and ANY unpriced item (`status <> 'priced'` or NULL `unit_price` — exactly
   `refreshQuotationStatus`'s not-ready predicate) also returns `stale`. If the item mutation commits
   first, enqueue observes the new sum → `stale` (never sends the old body); if enqueue commits first, the
   item mutation waits on the parent lock then fails 42501 (queued/frozen). (c)
   `quotation_items_enforce_frozen` now FAILS CLOSED on a NULL guard result: a caller the guard cannot
   classify — a raw `service_role` session with no PostgREST JWT claims (`caller_jwt_role()` NULL,
   BYPASSRLS, so RLS is no backstop) — is refused ANY item write in ANY status (0066 silently skipped the
   freeze for exactly that caller). enqueue keeps its exact signature, SECURITY DEFINER owner, hardened
   search_path, service-role-only EXECUTE, and every result / exact-payload-recovery semantic;
   numeric/Decimal correctness preserved (no float).

Hosted remediation prep (NOT executed): `docs/architecture-v2/hosted_secdef_searchpath_check.sql` (read-only
inventory; 0041-staged disposable DB shows 19/19 unsafe; the first-occurrence predicate also flags a planted
`pg_temp, …, pg_temp` poisoned path) + `hosted_secdef_searchpath_hardening.sql` (owner-approved,
self-verifying, exact-regprocedure, abort-on-residual with the same first-occurrence predicate; 0041-staged:
19 unsafe → 0 with COMMIT; a planted second-owner function → ABORT + ROLLBACK with the unsafe count
unchanged — nothing half-committed).

Tests: `tests/integration/wp12-enqueue-item-race.test.ts` (11 — genuine two-connection races: item-first →
`stale`; enqueue-first → the concurrent item write waits then 42501; no deadlock while blocked on the parent
lock; a DETERMINISTIC AB-BA-window proof — another tx holds an item-row lock (plain `SELECT … FOR UPDATE`,
no trigger) and enqueue still completes without requesting it, then the item write is refused 42501;
delete-ALL-items-then-enqueue → `stale` with zero outbox rows; an unpriced late item → `stale` even though
the priced sum still matches; raw no-claims `service_role` refused 42501 in ANY status (fail-closed);
two-finaliser; terminal-vs-enqueue; cross-company; pre-queue editable / post-queue immutable — the 4 new
cases were run against the PREVIOUS 0067 build and fail there, proving they discriminate) and
`tests/integration/search-path-safety.test.ts` (9 — the permanent owner-agnostic gate + adversarial gate
proofs: the gate catches a foreign-owned unsafe function and a duplicated-`pg_temp` path; cross-domain
pg_temp adversarial: `has_capability`/`my_company`/`is_admin` cannot be forged via temp
memberships/profiles; `decide_approval` cannot be forced via a temp `approval_requests`;
`_journal_post_internal` stays service-only + unshadowable; the WP12 owner check resists a temp `pg_proc`;
legitimate paths still work). Independent adversarial-security + concurrency/regression subagent reviews
were run; the security pass returned 2 blocker / 3 material / 3 minor-nit findings — the blockers
(delete-to-zero item-guard bypass; `current_user`-scoped hardening silently under-hardening a
differently-owned hosted set) and materials (a REAL AB-BA deadlock, empirically reproduced, in the
parent-then-child item locking the migration had wrongly documented as deadlock-free; the freeze guard
failing OPEN on a NULL guard result for raw no-claims `service_role`) are fixed above; one material claim
(`pg_temp` shadowing of the unqualified `digest()` CALL inside the SECURITY-INVOKER fingerprint helpers)
was REFUTED empirically before closing: PostgreSQL never resolves FUNCTION names from the temp schema —
only relations and types — so a planted `pg_temp.digest(text,text)` is not reachable from an unqualified
call (probe: constant-`\x00` temp digest planted; the helper still returned the true SHA-256).

## Verification (ninth round, disposable PostgreSQL 16 — superseded by the tenth-round table below)

| Gate | Result |
|---|---|
| `npm run secret-scan` | pass |
| `npm run migration-lint` | pass — **67 migrations, sequential 0001–0067** |
| `npm run typecheck` | pass |
| `npm run lint` | pass (0 errors; pre-existing `<img>` warnings only) |
| `npm test` (unit) | pass — **419 (79 files)** |
| `npm run audit-check` | pass (2 approved exceptions) |
| `npm run build` | pass |
| `npm run test:integration` — **fresh DB** (0001→0067 from scratch) | pass — **41 files / 317 tests** (incl. the 0067 search-path-safety owner-agnostic gate + gate-discrimination proofs + cross-domain pg_temp adversarial suite and the 0067 two-connection enqueue-vs-item-mutation race suite with the AB-BA-window, delete-to-zero, unpriced-item and no-claims fail-closed cases; the 0066 snapshot-boundary suite; the 0065 claim + INSERT-boundary suites; the 0064 delivery-boundary suite; the 0063 atomic-enqueue two-connection races; and the 0062 signature-exact allowlist + 42501 suite) |
| `npm run test:integration` — **upgrade path** (0058 + legacy data → 0059→0067) | pass — **41 files / 317 tests**; every non-extension SECURITY DEFINER / trigger function is confirmed pg_temp-safe, the item-vs-enqueue race resolves both orderings without deadlock, the 0062 lockdown holds, a queued quotation is frozen and undeletable, and a legacy `ready` quotation is atomically enqueued on the upgraded DB |
| 0067 fail-closed simulations (scratch DBs) | foreign-owned unsafe fn + non-superuser migration role → ABORT naming `foreign_unsafe()`; owner-role granted → hardened, clean pass; `authenticated` granted membership in a CREATE-holding role → ABORT naming the SET ROLE path |
| hosted hotfix (0041-staged disposable DB) | EXECUTE: exposure before (`exposed=t`, 3 functions) → locked after (`still_exposed=0`, COMMIT); simulated residual → RAISE + ROLLBACK. search_path (re-run with the first-occurrence predicate): 19/19 unsafe before (+ a planted poisoned `pg_temp,…,pg_temp` path flagged → 20/20) → 0 after with COMMIT; a planted second-owner fn → ABORT + ROLLBACK, unsafe count unchanged |

## Tenth external review — the SECOND AND FINAL bounded correction loop (0067 edited in place)

Verdict at head `3991384`: CHANGES REQUESTED, three findings. Precondition satisfied first: 0067 was
reconfirmed **never applied outside disposable databases** (hosted at 0038–0041 only, owner-applied
2026-08-07; nothing hosted by this process) → edited in place, no 0068.

1. **F1 (BLOCKER) — gate accepted attacker-controlled schemas.** The pg_temp-last predicate passed
   `attacker_schema, pg_catalog, public, pg_temp`; with CREATE on `attacker_schema` granted to an API
   role (1a guards only `public`/`extensions`), relations resolve from the attacker schema first, and a
   foreign-owned function with that path also slid through the owner-agnostic self-verify. FIX: STRICT
   CANONICAL EQUALITY at all four sites — 0067 (1b) self-verify, `search-path-safety.test.ts`,
   `hosted_secdef_searchpath_check.sql`, `hosted_secdef_searchpath_hardening.sql` — safe iff the parsed
   path (btrim + strip enclosing identifier quotes) is EXACTLY `pg_catalog, extensions, public, pg_temp`
   (subsumes missing-path/`$user`/duplicated-pg_temp/foreign-schema at once). Evidence: the permanent
   gate plants the exact finding shape (schema with CREATE granted to `authenticated`, foreign-owned
   SECDEF fn, pg_temp last) and flags it; the (1b) simulation under a non-superuser role ABORTS naming
   `atk_path_fn()`; both prior discrimination tests (foreign-owner `search_path=public`, duplicated
   pg_temp) still flag; `ALTER … SET` confirmed to store the exact string the parser compares.
2. **F2 (BLOCKER) — incomplete item snapshot.** `SUM(line_total)` skips NULL (a priced item with NULL
   `line_total` rode an under-counted total — e.g. total 0 enqueued `LKR 0.00` for a priced item), and a
   catalogue-copied item currency ≠ the quotation currency passed on numeric equality while the public
   quotation renders lines in the quotation currency. FIX (DB): the enqueue guard refuses (→ `stale`) any
   item with `status <> 'priced'`, NULL `unit_price`, NULL `line_total`, or
   `upper(btrim(currency))` ≠ the LOCKED quotation currency. FIX (app, mirrored 1:1, no float, no
   conversion): `refreshQuotationStatus` treats exactly those items as awaiting (fetches the quotation
   currency; missing quotation → awaiting); `priceQuotation` auto-prices ONLY from a same-currency
   catalogue entry — a mismatched match goes to a HUMAN price confirmation posed in the quotation
   currency; `resolvePriceConfirmation` stamps the resolved item to the quotation currency, so a
   pre-existing mismatched item exits via the human flow (no stuck state). Discriminating tests (both
   FAIL on the ninth-round build): priced+NULL-line_total+total-0 → `stale`/0 rows/still `ready`; LKR
   quotation + numerically-equal USD item → `stale`/0 rows; same-currency control enqueues; concurrency
   outcomes unchanged.
3. **F3 (predicted MATERIAL regression) — DOES NOT REPRODUCE.** Reproduction was attempted FIRST, as
   instructed: on disposable PostgreSQL 16, a capability holder's DELETE of a draft quotation WITH an
   item SUCCEEDED. Probed mechanism: Postgres runs ON DELETE CASCADE referential actions as the
   REFERENCING TABLE'S OWNER (observed in-trigger: `current_user=postgres`, `pg_trigger_depth()=2`,
   guard NULL yet unreached) — the owner IS the trusted delivery owner, so the trusted branch precedes
   the fail-closed NULL branch. Non-spoofable: client DML (incl. attacker temp-table triggers) never
   acquires the table owner's `current_user` (pinned by the still-refused no-claims direct UPDATE/DELETE
   tests). SHIPPED: fail-closed 0067 assertion (2a″) that `quotations`/`quotation_items` owner == the
   exact 9-arg `enqueue_quotation_outbox` owner (simulated divergence ABORTS naming table+owners), and
   the demanded regression pins — draft AND awaiting_price quotations WITH items deleted by the
   capability holder (parent + children), frozen-parent/cross-company/no-claims refusals unchanged.

Final focused adversarial review (this loop): launched against this exact working tree as the last step
of the loop; its CLEAN verdict — plus the one LOW completion it suggested, applied in the follow-up
commit — is recorded in the dated note appended at the end of this file.

## Verification (tenth round, disposable PostgreSQL 16, this session)

| Gate | Result |
|---|---|
| `git diff --check` | pass |
| `npm run secret-scan` | pass |
| `npm run migration-lint` | pass — **67 migrations, sequential 0001–0067** |
| `npm run typecheck` | pass |
| `npm run lint` | pass (0 errors; pre-existing `<img>` warnings only) |
| `npm test` (unit) | pass — **419 (79 files)** (the `priceQuotation`/`refreshQuotationStatus`/`resolvePriceConfirmation` changes break nothing) |
| `npm run audit-check` | pass (2 approved exceptions) |
| `npm run build` | pass |
| Targeted discrimination vs the ninth-round build | exactly the 2 new F2 tests FAIL there (NULL-line_total; USD item); the F1 gate flags the planted attacker-schema shape; all 4 ninth-round discriminators still fail there |
| `npm run test:integration` — **fresh** 0001→0067 | pass — **41 files / 321 tests** |
| `npm run test:integration` — **upgrade** 0058(+legacy)→0067 | pass — **41 files / 321 tests** |
| 0067 fail-closed simulations | attacker-schema pg_temp-last fn (non-superuser) → ABORT naming `atk_path_fn()`; foreign-owner `search_path=public` → ABORT naming it; membership-granted owner → hardened, clean pass; SET-ROLE-reachable CREATE → ABORT naming the path; `quotation_items` re-owned → 2a″ ABORT naming table+owners; aligned state → pass |
| hosted search-path scripts (0041-staged, STRICT predicate) | before **19/19 unsafe**; + planted attacker-schema fn + second-owner fn → check flags both (21/21); hardening → ABORT+ROLLBACK on multi-owner, count unchanged; after dropping the second owner → COMMIT, 20 pinned (incl. the attacker-schema fn re-pinned) → final **0/20** |
| 0041 EXECUTE privilege hotfix (0041-staged) | before: service-only functions exposed; `hosted_secdef_emergency_revoke.sql` → COMMIT; after: service-only set `exposed = f` (3/3) while the intended-API RLS helpers keep authenticated EXECUTE by design; a re-granted service-only fn is re-closed idempotently on a second run (COMMIT → exposed back to 0) |

_Numbers above are the **tenth review increment** (integration branch, migrations 0048–0067).
Earlier rounds — ninth (0067 initial+adversarial pass, 41 files / 317 tests, unit 419); eighth (0066, 39
files / 297 tests, unit 419); seventh (0065, 38 files / 267 tests, unit 419); sixth (0064, 37 files / 224
tests, unit 419); fifth (0063, 36 files / 207 tests, unit 419); fourth (0062, 35 files / 190 tests, unit
426); third (0061, 34 files / 182 tests, unit 420); second (0060, 34 files / 180 tests, unit 410); first
(0058, 33 files / 173 tests, unit 405); first pass (0055, unit 374) — are superseded. **GitHub Actions
obtained no runner on any run**; all evidence is local disposable PostgreSQL 16 — no CI-pass is claimed._

Toolchain: Node v22.22.2, npm 10.9.7, PostgreSQL 16.13. No hosted migration applied; no feature flag
enabled.

## Final focused adversarial review — verdict (2026-08-17, tenth loop)

An independent adversarial review, scoped strictly to the three tenth-round corrections, ran against the
exact corrected tree on the disposable PostgreSQL 16.13 (19 distinct empirical probes; scratch DBs
created and dropped; the evidence DB left untouched). **Verdict: CLEAN — Correction 1 SOUND,
Correction 2 SOUND, Correction 3 SOUND. No blockers, no material gaps.** Highlights:

- **Correction 1 (strict canonical path):** the dangerous fail-OPEN direction is structurally
  impossible — Postgres normalizes `proconfig` storage (bare tokens only for genuinely-lowercase
  identifiers; quoting/doubling otherwise), and the anchored quote-strip refuses any element containing
  an internal comma/quote; 20+ adversarial stored forms (case/quoting/comma-in-name/equals-in-name/
  embedded-quote/Cyrillic-homoglyph/`$user`/attacker-lead/dup-pg_temp/empty/cardinality) ALL classify
  unsafe, and unquoted-UPPER lowercases to the genuinely-canonical path (correctly safe). The JS gate
  predicate and the SQL predicate agree on all 14 tricky stored forms; the check script reports 38
  in-scope functions / 0 unsafe / single owner on the evidence DB.
- **Correction 2 (item snapshot):** no item state passes the DB guard while disagreeing with the
  customer-visible body (USD-item/NULL-line_total refused → `stale`; degenerate zero cases are
  self-consistent — body sum equals committed item sum 0); `char(3) NOT NULL` + the status CHECK remove
  the NULL-currency/out-of-domain concerns; app and DB predicates are equivalent (no stuck-ready, no
  app-DB divergence). ONE LOW operational caveat: `priceQuotation`'s skip condition did not re-check the
  new completeness, so a PRE-FIX legacy item priced in a non-quotation currency (or with NULL
  line_total) — refused correctly by refresh and the DB guard (fails SAFE, never mis-sends; no live
  population exists) — had no in-app remediation path. **Closed within this loop** by the one-line
  completion the reviewer suggested: the skip now requires the full completeness predicate, so such an
  item re-enters pricing (same-currency catalogue match → repriced in the quotation currency; else → a
  human price confirmation).
- **Correction 3 (cascade trust):** the RI-as-referencing-table-owner mechanism was independently
  reproduced (distinct parent/child owners: the child trigger observes the CHILD table's owner; SET NULL
  behaves identically; direct client DML never acquires it); the 2a″ assertion is signature-exact (a
  planted `enqueue_quotation_outbox(int)` overload is inert) and aborts on divergence; every inbound
  cascade edge into `quotation_items` (quotations CASCADE — gated at the quotations boundary trigger —
  companies CASCADE, product_catalog SET NULL) runs as the trusted owner, so no legitimate operation
  hits the fail-closed NULL branch; and `message_outbox` has NO inbound FK from quotations/orders
  (`source_id` is polymorphic), so NO cascade can reach the frozen delivered snapshot as owner.

Out-of-scope backlog notes recorded by the reviewer (both pre-existing, both LOW): (1)
`orders→quotations` ON DELETE SET NULL (and `product_catalog→quotation_items.catalog_id` SET NULL) run
as the trusted child-table owner, so deleting an order/catalogue row nulls the provenance link columns
(`order_id`/`catalog_id`) even on a frozen quotation — the delivered `message_outbox` content stays
frozen, so no customer-visible effect; a 0007-era FK semantic. (2) The search_path audit scopes schema
`public` only — an app-owned SECURITY DEFINER function in another schema would be out of scope (none
exist today).
