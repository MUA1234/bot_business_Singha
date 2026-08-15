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
| WP13 | Posted-journal immutability allowlist | ⏳ pending |
| WP14 | Canonical-JSON idempotency fingerprints (escape/collision-safe) | ⏳ pending |
| WP15 | Invoice/bill document invariants (require lines; verify existing journal) | ⏳ pending |
| WP16 | Reimbursement/payment reuse — full payload validation | ⏳ pending |
| WP17 | Explicit system-actor path (no human `p_by` on the worker path) | ⏳ pending |
| WP18 | Reconcile migration-state / verification docs | ⏳ pending |

> Note: WP13–WP17 are **partially** present in migration 0044 already, each with the precise gap the
> brief describes (e.g. WP14's `_fp_lines` still concatenates with unescaped `,`/`;` delimiters;
> WP15 only compares header-vs-line totals `when v_line_total > 0`, so a header-only invoice can
> still post; WP13's `block_posted_mutation` uses subset comparisons, not an allowlist). These are
> genuine follow-on corrections, tracked above.

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

## Verification (disposable PostgreSQL 16, this session)

| Gate | Result |
|---|---|
| `npm run secret-scan` | pass |
| `npm run migration-lint` | pass — 48 migrations, sequential 0001–0048 |
| `npm run typecheck` | pass |
| `npm run lint` | pass (pre-existing `<img>` warnings only) |
| `npm test` (unit) | pass — 374 |
| `npm run audit-check` | pass (2 approved exceptions) |
| `npm run build` | pass |
| `npm run test:integration` — **upgrade path** (0047→0048 on legacy data) | pass — 24 files / **101** tests (+12) |
| `npm run test:integration` — **fresh DB** (0001→0048 from scratch) | pass — 24 files / 101 tests |

Toolchain: Node v22.22.2, npm 10.9.7, PostgreSQL 16.13. No hosted migration applied; no feature flag
enabled.
