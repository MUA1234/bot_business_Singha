# Phase 1 — 0048+ Security/Accounting Corrections (WP10–WP18) — Ledger

> Blocking prerequisite for the V3.1 program (pack `00A_SECURITY_CORRECTION_PREREQUISITE_0048.md`).
> This ledger tracks the correction phase. Each work package lands as a forward migration `0048+`
> with failing-before/passing-after tests, verified on a disposable PostgreSQL 16 (fresh **and**
> `0047→0048+` upgrade path). `RLS_READS` / `RLS_WRITES` / `WHATSAPP_ASYNC` stay OFF. No hosted action.

## Status

| WP | Correction | Status |
|---|---|---|
| **WP10** | Remove broad company-member writes on commercially sensitive tables | **✅ done — migration 0048** |
| WP11 | Approval authority: org scope + currency + delegation bounds | ⏳ next |
| WP12 | Truthful quotation/order delivery state | ⏳ pending |
| **WP13** | Posted-journal immutability allowlist | **✅ done — migration 0050** |
| WP14 | Canonical-JSON idempotency fingerprints (escape/collision-safe) | ⏳ pending |
| WP15 | Invoice/bill document invariants (require lines; verify existing journal) | ⏳ pending |
| WP16 | Reimbursement/payment reuse — full payload validation | ⏳ pending |
| **WP17** | Explicit system-actor path (no human `p_by` on the worker path) | **✅ done — migration 0049** |
| WP18 | Reconcile migration-state / verification docs | ⏳ pending |

> Note: WP14–WP16 are **partially** present in migration 0044 already, each with the precise gap the
> brief describes (e.g. WP14's `_fp_lines` still concatenates with unescaped `,`/`;` delimiters;
> WP15 only compares header-vs-line totals `when v_line_total > 0`, so a header-only invoice can
> still post). These are genuine follow-on corrections, tracked above. (WP13 and WP17 are done.)

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

## Verification (disposable PostgreSQL 16, this session)

| Gate | Result |
|---|---|
| `npm run secret-scan` | pass |
| `npm run migration-lint` | pass — 50 migrations, sequential 0001–0050 |
| `npm run typecheck` | pass |
| `npm run lint` | pass (pre-existing `<img>` warnings only) |
| `npm test` (unit) | pass — 374 |
| `npm run audit-check` | pass (2 approved exceptions) |
| `npm run build` | pass |
| `npm run test:integration` — **upgrade path** (0049→0050 on legacy data) | pass — **26 files / 116 tests** |
| `npm run test:integration` — **fresh DB** (0001→0050 from scratch) | pass — **26 files / 116 tests** |

Toolchain: Node v22.22.2, npm 10.9.7, PostgreSQL 16.13. No hosted migration applied; no feature flag
enabled.
