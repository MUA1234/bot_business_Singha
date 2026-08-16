# Migration State (per environment)

> **Purpose (WP0 item 5).** Record the **actual applied migration state** separately
> for local, staging and production. **A migration is never recorded as "applied"
> merely because the `.sql` file exists in the repo.** Applied state is only asserted
> when an operator has confirmed it against the live database, with a date.
>
> This file is the single place to track applied-state. Update it whenever a migration
> is run against any environment, and cite who confirmed it and when.

_Last reviewed: 2026-08-15 (Phase 1 — 0048+ Security/Accounting Corrections, WP18)._

> **WP18 authority note.** This file is **the** authoritative migration-state document. The five
> states below are tracked **separately** and never conflated — in particular, *file exists* and
> *tested on a disposable database* never imply *applied to staging/production*. Execution is the
> migration **runner** (`npm run migrate`, `schema_migrations` ledger); the combined `RUN_*.sql`
> files are non-authoritative aids. Hosted (staging/production) state is asserted **only** from an
> owner confirmation with a date; where none exists it is recorded **"owner confirmation required."**
> This development process has **not** applied any migration to a hosted database and has **not**
> enabled any feature flag.

## Migration source of truth

- **Canonical migrations:** `src/db/migrations/0001_*.sql` … `0055_*.sql` (forward-only,
  sequential; `migration-lint` confirms 0001–0061, no gaps). This directory is the **one**
  migration source of truth.
- **⚠️ Divergence risk (flag for WP6):** duplicate/aggregate runnable copies exist and
  can drift from canonical migrations. They must not be treated as authoritative:
  - `docs/architecture-v2/RUN_0014_*.sql` … `RUN_0022_*.sql`
  - `docs/architecture-v2/RUN_ALL_PENDING_MIGRATIONS.sql`
  - `docs/interim-accounting/ALL_MIGRATIONS.sql`

  The master-prompt implementation rule is explicit: *"Do not duplicate migration SQL
  in multiple runnable files; keep one migration source of truth."* Reconciling/removing
  these duplicates is deferred to a later work package (not part of WP0).

## Environments

| Environment | Exists? | How migrations are applied | Applied state |
|---|---|---|---|
| **Local** | No local Postgres/Supabase is provisioned in this repo | n/a (no local DB) | **None tracked.** There is no local database; tests are unit-only (Vitest, no DB). WP1/WP6 introduce a temporary test DB in CI. |
| **Staging** | **Unconfirmed — likely none** | n/a | **Unknown.** No separate staging Supabase project is confirmed to exist. A staging DB is a prerequisite for WP1 live isolation tests and must be provisioned + recorded here before those tests run. |
| **Production** (live Singha Supabase project) | Yes | Owner runs SQL in the Supabase SQL editor | **Partially confirmed — see table below.** |

## Production applied-state (requires owner confirmation to finalise)

| Migration | Purpose | Applied to production? |
|---|---|---|
| 0001 | org_and_access | ✅ confirmed applied (owner, 2026-08-05) |
| 0002 | accounting_core | ✅ confirmed applied (owner, 2026-08-05) |
| 0003 | subledgers | ✅ confirmed applied (owner, 2026-08-05) |
| 0004 | intelligence_and_evidence | ✅ confirmed applied (owner, 2026-08-05) |
| 0005 | banking_and_planning | ✅ confirmed applied (owner, 2026-08-05) |
| 0006 | approval_policies | ✅ confirmed applied (owner, 2026-08-05) |
| 0007 | app_profiles_and_orders | ✅ confirmed applied (owner, 2026-08-05) |
| 0008 | phase0_rls_hardening | ✅ confirmed applied (owner, 2026-08-05) |
| 0009 | composite_company_fks | ✅ confirmed applied (owner, 2026-08-05) |
| 0010 | identity_foundation (additive only) | ✅ confirmed applied (owner, 2026-08-05) |
| 0011 | message_outbox | ✅ confirmed applied (owner, 2026-08-05) |
| 0012 | work_tasks | ✅ confirmed applied (owner, 2026-08-05) |
| 0013 | capacity_snapshots | ✅ confirmed applied (owner, 2026-08-05) |
| 0014 | departments_expansion | ⚠️ **reported applied, unverified** |
| 0015 | post_journal_rpc | ⚠️ **reported applied, unverified** |
| 0016 | settlement_and_reversal | ⚠️ **reported applied, unverified** |
| 0017 | hr_workforce | ⚠️ **reported applied, unverified** |
| 0018 | marketing_objectives | ⚠️ **reported applied, unverified** |
| 0019 | task_assignment | ⚠️ **reported applied, unverified** |
| 0020 | rfq | ⚠️ **reported applied, unverified** |
| 0021 | inventory | ⚠️ **reported applied, unverified** |
| 0022 | notifications | ⚠️ **reported applied, unverified** |
| 0023 | identity_capabilities_rls (WP1: membership access, has_capability, write RLS, composite FKs) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0024 | composite_company_fks (WP1.6: parent/child same-company FKs) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0025 | task_progress_capacity (WP3: task actual/remaining/blocker/ETA + assignment estimate + capacity fields) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0026 | idempotency_keys (WP2: caller-idempotency guard for settlements/reimbursements) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0027 | ai_run_trail (WP5.3: ai_runs.latency_ms + source_event_id) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0028 | management_cases (WP5.1: durable evidence-linked AI case records) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0029 | bank_change_status (WP2.5: supplier bank-detail change maker/checker fields) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0030 | fix_reversal_link_immutability (WP2 bugfix: allow reversing-entry link on posted journals — reversals were broken) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0031 | outbox_next_retry (WP4: message_outbox.next_retry_at for the drain worker backoff) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0032 | outbox_template (WP4.7: message_outbox template_name/params/lang for out-of-window staff delivery) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0033 | conversation_ai_analyzed (WP5.1: wa_conversations.ai_analyzed_at for the continuous monitor) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0034 | domain_write_rls (WP1: company-scoped write policies on 83 domain tables; ledger/worker/append-only excluded) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0035 | posting_hardening (WP2: RPCs SECURITY DEFINER + company guard + caller-idempotency + atomic fail-closed audit + REVOKE/GRANT) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0036 | approval_write_rls (WP1: company-scoped write policies for approval_requests/approval_actions) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-06) |
| 0037 | settlement_row_locks (WP2: FOR UPDATE on settle/reverse source rows — concurrency-safe) | ✅ applied to staging DB `gazjughejdzebathpscb` (2026-08-07) |
| 0038 | capability_authority (Sec&Rel Gate WP A: domain-qualified capabilities, least-privilege role map, suspension-safe has_company_access, delegation-aware has_capability + authority ceilings, capability-gated write RLS, service-only lockdown, approval SoD) | ✅ applied to DB `gazjughejdzebathpscb` (owner-confirmed 2026-08-07) |
| 0039 | accounting_rpc_hardening (WP B: reject anon, actor from auth.uid(), per-op capability, transactional idempotency + conflict-on-key-reuse, narrowed unique_violation, in-RPC audit) | ✅ applied to DB `gazjughejdzebathpscb` (owner-confirmed 2026-08-07) |
| 0040 | durable_messaging (WP C: outbox lease + claim_outbox_batch FOR UPDATE SKIP LOCKED + lease recovery + dead-letter; wa_messages handled_at resume-safety) | ✅ applied to DB `gazjughejdzebathpscb` (owner-confirmed 2026-08-07) |
| 0041 | ledger_integrity_report (WP E: read-only integrity probe for the health surface) | ✅ applied to DB `gazjughejdzebathpscb` (owner-confirmed 2026-08-07) |
| 0042 | authority_tightening (review follow-up: self-service claims tied to the authenticated employee; capability-gate remaining financial subledger tables; payment_allocations service-only) | ❌ **not applied to any environment** (added 2026-08-07; verified on disposable Postgres) |
| 0043 | transactional_finance (review follow-up: full-payload idempotency; transactional post_customer_invoice / post_supplier_bill / reimburse_expense_claim RPCs) | ❌ **not applied to any environment** (added 2026-08-07; verified on disposable Postgres) |
| 0044 | canonical_idempotency_and_lifecycle (correction WP3/WP4: SHA-256 canonical fingerprint binding operation+source+date+currency+memo+lines; legacy null-hash upgrade; reimbursement source binding; invoice/bill lifecycle; actor from auth.uid + p_by mismatch reject + system actor_type) | ❌ **not applied to any environment** (added 2026-08-08; verified on disposable Postgres incl. upgrade-path from 0043) |
| 0045 | bank_change_maker_checker (correction WP6: request/decision RPCs; supplier_bank_detail_changes RPC-only; maker<>checker; no bank numbers in audit) | ❌ **not applied to any environment** (added 2026-08-08; verified on disposable Postgres) |
| 0046 | authority_and_approvals (correction WP7: authority_rules.is_unlimited; deny-by-default within_authority; decide_approval RPC; approval_actions RPC-only) | ❌ **not applied to any environment** (added 2026-08-08; verified on disposable Postgres) |
| 0047 | rls_write_matrix (correction WP8: capability-gate remaining sensitive finance/bank/planning/inventory/fleet/identity tables; operations.fleet.manage) | ❌ **not applied to any environment** (added 2026-08-08; verified on disposable Postgres) |
| 0048 | wp10_sensitive_write_rls (Phase 1 WP10: remove broad company-member writes; capability-gate 18 commercially-sensitive tables; WhatsApp/notifications service-only) | ⛔ **owner confirmation required** (added 2026-08-15; dev-verified on disposable PostgreSQL 16, fresh + upgrade) |
| 0049 | wp17_system_actor (Phase 1 WP17: `_resolve_actor` — system path only via service_role JWT; reject missing/malformed/anon/unknown; EXECUTE revoked from PUBLIC) | ⛔ **owner confirmation required** (added 2026-08-15; dev-verified on disposable PostgreSQL 16) |
| 0050 | wp13_posted_journal_immutability (Phase 1 WP13: allowlist whole-row posted-journal immutability; posted lines immutable to INSERT too) | ⛔ **owner confirmation required** (added 2026-08-15; dev-verified on disposable PostgreSQL 16) |
| 0051 | wp14_canonical_json_fingerprint (Phase 1 WP14: versioned canonical-JSON SHA-256 fingerprint `v3:`; v2/legacy-NULL compatibility) | ⛔ **owner confirmation required** (added 2026-08-15; dev-verified on disposable PostgreSQL 16) |
| 0052 | wp15_invoice_bill_invariants (Phase 1 WP15: require source lines, positive header, header = line total; verify an existing journal is this document's) | ⛔ **owner confirmation required** (added 2026-08-15; dev-verified on disposable PostgreSQL 16) |
| 0053 | wp16_reimbursement_reuse_validation (Phase 1 WP16: full source-bound payload validation on reimbursement/payment reuse) | ⛔ **owner confirmation required** (added 2026-08-15; dev-verified on disposable PostgreSQL 16) |
| 0054 | wp11_approval_scope_currency_delegation (Phase 1 WP11: authority_rules/delegations scope + is_company_wide; within_authority_for_event; strict currency; delegation ⊆ delegator) | ⛔ **owner confirmation required** (added 2026-08-15; dev-verified on disposable PostgreSQL 16) |
| 0055 | wp12_truthful_delivery_state (Phase 1 WP12: outbox source metadata; quotations `queued` state; fenced `complete_outbox_and_advance` RPC; at-least-once) | ⛔ **owner confirmation required** (added 2026-08-15; dev-verified on disposable PostgreSQL 16, fresh + upgrade) |
| 0056 | wp15_source_binding_fingerprint (external-review B: invoice/bill existing-journal path recomputes the canonical fingerprint — a matching key alone is not proof of source binding) | ⛔ **owner confirmation required** (added 2026-08-15; dev-verified on disposable PostgreSQL 16, fresh + upgrade) |
| 0057 | wp11_approval_failclose_domain_caps (external-review C: fail-closed approvals incl. reject; deterministic domain→capability whitelist; duplicate-action conflict; delegation company-consistency) | ⛔ **owner confirmation required** (added 2026-08-15; dev-verified on disposable PostgreSQL 16) |
| 0058 | wp12_message_history_on_completion (external-review A: outbound wa_messages written atomically on durable send only, with the provider id) | ⛔ **owner confirmation required** (added 2026-08-15; dev-verified on disposable PostgreSQL 16, fresh + upgrade) |
| 0059 | wp15_fp_matches_privilege (2nd review: REVOKE _journal_fp_matches EXECUTE from PUBLIC/anon/authenticated) | ⛔ **owner confirmation required** (added 2026-08-15; dev-verified on disposable PostgreSQL 16) |
| 0060 | wp11_composite_fk_money_failclose (2nd review: composite company-consistency FKs NOT VALID + preflight; decide_approval fails closed on non-positive/non-finite amount, invalid currency, invalid approvals_required) | ⛔ **owner confirmation required** (added 2026-08-15; dev-verified on disposable PostgreSQL 16, fresh + upgrade; **VALIDATE the two NOT VALID FKs after the documented preflight on staging**) |
| 0061 | final_review_currency_enqueue_reconcile (3rd/final review: `currencies` catalogue — `is_active` + 16 seeded ISO codes on the existing 0002 table; `decide_approval` validates currency against it; service-only `enqueue_outbox_row` + `reconcile_quotation_from_outbox` RPCs, EXECUTE revoked from authenticated/anon) | ⛔ **owner confirmation required** (added 2026-08-16; dev-verified on disposable PostgreSQL 16, fresh + upgrade; **seed any additional in-use currencies after applying** — an unseeded currency can no longer be approved) |

> **Correction-phase note (0044–0047):** authored 2026-08-08, **not** applied to any hosted
> DB. Verified on a disposable local **PostgreSQL 16** (Supabase-compat shim) from a clean
> database AND via an **upgrade path** (staged at 0043 with legacy data — null-hash journal,
> unposted invoice, pending approval/outbox/bank-change — then migrated 0044→0047 cleanly;
> the legacy null-hash journal's identical retry returns the same journal and upgrades its
> fingerprint). 0044–0047 are pending owner application (with approval) via `npm run migrate`.
>
> **Reconciliation (WP18 — resolves the 0038–0043 contradiction).** The hosted record is:
> **0038–0041** were owner-applied to DB `gazjughejdzebathpscb` on **2026-08-07** (owner
> confirmation on record, combined file `RUN_0038-0041_*.sql`). **0042 and 0043 onward were NOT
> applied to any hosted database** — the per-migration rows above are authoritative; the earlier
> prose that grouped "0038–0043 … applied by the owner" over-reached and is void. Everything from
> **0042 through 0061** has hosted state **"owner confirmation required"** (dev-process verified on
> disposable PostgreSQL 16 only).

### Phase 1 correction migrations (0048–0061) — the five states, kept separate (WP18)

Each state is tracked independently; none implies another. "Applied to staging/production" is
asserted only from a dated owner confirmation — there is none, so it is **owner confirmation
required**. **What "flags OFF" does and does not mean (corrected):** it is **not** true that these
migrations are uniformly "inert at runtime while the flags are OFF." Only the **RLS read/write
cutover** is flag-inert (the app uses the service-role client, which bypasses RLS). The WP12 delivery
path (0055/0058/0061) runs on the **default synchronous WhatsApp path with `WHATSAPP_ASYNC` OFF**;
`decide_approval` (0054/0057/0060/0061) applies its authority/money/currency fail-close to **every
caller** of the RPC; and the composite FKs, function-privilege REVOKEs and `currencies` catalogue
enforce for **any** writer. What keeps all of this off the live system is that **the hosted database
is not migrated** (the rows below are all "owner confirmation required"), **not** the flags.

| Migration | File exists | Tested on disposable DB (PG 16, fresh + upgrade) | Applied to staging | Applied to production | Feature flag enabled |
|---|:---:|:---:|:---:|:---:|:---:|
| 0048 wp10 | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a — `RLS_WRITES` OFF |
| 0049 wp17 | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |
| 0050 wp13 | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |
| 0051 wp14 | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |
| 0052 wp15 | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |
| 0053 wp16 | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |
| 0054 wp11 | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |
| 0055 wp12 | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a — sync path runs with `WHATSAPP_ASYNC` OFF |
| 0056 wp15 (rev A) | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |
| 0057 wp11 (rev C) | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |
| 0058 wp12 (rev A) | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a — sync path runs with `WHATSAPP_ASYNC` OFF |
| 0059 wp15 (rev 2) | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |
| 0060 wp11 (rev 2) | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |
| 0061 wp11+wp12 (rev 3, final) | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |

> Legend: **File exists** = the `.sql` is committed. **Tested on disposable DB** = applied and its
> adversarial + concurrency suite passed on an ephemeral PostgreSQL 16 with the Supabase-compat
> shim, both fresh (`0001→NNNN`) and via the upgrade path. **Applied to staging/production** =
> a dated owner confirmation against that live database exists. **Feature flag enabled** = the
> relevant `RLS_READS` / `RLS_WRITES` / `WHATSAPP_ASYNC` flag is ON in that environment.

### Production Security & Reliability Gate migrations (0038–0041) — applied state

| Environment | 0038–0041 |
|---|---|
| **Local** | Not applied (no local DB provisioned). |
| **CI** | Applied to a **disposable Postgres per run** (service container + `tests/integration/helpers/supabase-shim.sql`), then the integration/RLS/concurrency suite runs. Ephemeral — torn down each run. |
| **Staging** | **Not applied.** No confirmed non-production staging project. Prerequisite before flipping `RLS_READS`/`RLS_WRITES`/`WHATSAPP_ASYNC` (see `RLS_CUTOVER_PLAN.md`). |
| **Production** | **Not applied.** Owner-only, with approval (invariant #16). The **RLS write-policy** parts are inert while `RLS_WRITES` is OFF (the service role bypasses RLS); the **RPC hardening (0039)** and **audit/health (0041)**, however, change the behaviour of those functions for **any** caller once applied — "inert" applies to the RLS cutover, not to every object in the gate. |

> These four migrations were authored offline and **not** run by the development process.
> The **owner applied them via the Supabase SQL editor on 2026-08-07** (combined file
> `RUN_0038-0041_security_reliability_gate.sql`). The **RLS read/write cutover** they add stays inert
> until `RLS_READS`/`RLS_WRITES` are turned on (the service role bypasses RLS); the accounting-RPC
> hardening (0039) and audit/health (0041) they add are **active for any caller of those functions**
> once applied — so "zero behaviour change" is accurate only for the RLS-cutover portion, not the whole
> gate. Still verified by `migration-lint` (sequential 0001–0041) and, in CI, against the disposable
> Postgres.

### Basis for the "reported applied, unverified" status (0014–0022)

- The prior status document confirmed **0008–0013 applied** (owner, 2026-08-05) and
  listed **0014 as pending**.
- During the 2026-08-05 build session the owner repeatedly ran the later SQL scripts
  ("ran the sql") and pasted a live production schema dump that contained tables from
  the later migrations. This strongly suggests 0014–0022 were executed against
  production, **but it has not been verified migration-by-migration** and must not be
  asserted as fact.

### To finalise this record (owner / operator action)

Confirm, in the live Supabase project, that the objects created by 0014–0022 exist
(e.g. tables `leads`, `purchase_orders`, `legal_matters`, `vehicles`, `rfqs`,
`inventory_items`, `notifications`; RPCs `post_manual_journal`, `settle_customer_invoice`,
`settle_supplier_bill`, `reverse_journal`). Then update each row above from
"reported applied, unverified" to "confirmed applied (owner, <date>)".

## Migration runner + ledger (WP6.8 — now implemented)

Migrations are applied by `scripts/migrate.mjs` (`npm run migrate`), which records each
version in a **`schema_migrations`** table so it runs exactly once, in order, each in
its own transaction:

- `npm run migrate` — apply pending migrations to `DATABASE_URL`.
- `npm run migrate:status` — show applied vs pending (exit 1 if pending = drift).
- `node scripts/migrate.mjs --baseline` — mark existing files applied WITHOUT running
  (used once on a DB whose schema already exists, e.g. the staging DB was baselined
  2026-08-06 → 35 applied, 0 pending).

CI applies pending migrations to the test DB (`TEST_DATABASE_URL` secret) before the
integration suite. This table above remains the human-readable per-environment record;
`schema_migrations` is the machine ledger. Production is applied by the owner (with
approval) via the same runner.
