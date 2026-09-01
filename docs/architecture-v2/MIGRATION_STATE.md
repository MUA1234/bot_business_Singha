# Migration State (per environment)

> **Purpose (WP0 item 5).** Record the **actual applied migration state** separately
> for local, staging and production. **A migration is never recorded as "applied"
> merely because the `.sql` file exists in the repo.** Applied state is only asserted
> when an operator has confirmed it against the live database, with a date.
>
> This file is the single place to track applied-state. Update it whenever a migration
> is run against any environment, and cite who confirmed it and when.

_Last reviewed: 2026-09-02 (Product Recovery Phase R0 — see
`docs/product-recovery/12-R0-EVIDENCE.md`). Previous review: 2026-08-15 (Phase 1 WP18)._

> ## ⚠️ R0 CORRECTION BANNER — READ BEFORE APPLYING ANY MIGRATION
>
> Phase R0 of the product recovery found three defects in this record itself. They are
> stated here rather than silently patched, because two of them can destroy data.
>
> **1. This record contradicts the deployed code (PR-F-004 — UNRESOLVED).**
> The rows below state that nothing after 0041 was applied to a hosted database. But the
> deployed `main` code **requires migration 0069** — `src/lib/whatsapp-inbound.ts`
> resolves the inbound company from `companies.whatsapp_phone_number_id`, a column only
> `main`'s 0069 creates, and that code is live on Railway. Exactly one of these is true:
> (a) migrations 0042–0069 were applied and this record was never updated, or (b) live
> code is running ahead of its schema. **The repository cannot tell which.** Until an
> operator resolves it (§R0 commands below), the production starting point is UNKNOWN and
> **no migration may be applied to production.**
>
> **2. Two different migrations are numbered `0069` (PR-F-001 — P0).**
>
> | Line | File |
> |---|---|
> | `main` (deployed) | `0069_company_routing_and_catalogue_department.sql` |
> | `claude/hard-scenario-testing` and descendants | `0069_durable_inbound_processing.sql` |
>
> `scripts/migrate.mjs` keys `schema_migrations` on the **four-character numeric prefix
> only** (`const version = (f) => f.slice(0, 4)`), and never compares the stored filename.
> On a database where `main`'s 0069 is applied, the branch's 0069 is therefore filtered out
> of `pending` and **silently skipped — not reported, not failed** — after which 0070–0109
> run against a schema missing the durable-inbound objects several of them depend on.
> This is a silent-corruption path. It must be resolved by renumbering the branch line
> above the deployed high-water mark (Phase R2), and the runner should be hardened to key
> on version **and** filename/content hash first.
>
> **3. 41 migrations had no state record at all (PR-F-011 — now corrected below).**
> This file previously stopped at 0068 while the branch line had reached 0109.



> **WP18 authority note.** This file is **the** authoritative migration-state document. The five
> states below are tracked **separately** and never conflated — in particular, *file exists* and
> *tested on a disposable database* never imply *applied to staging/production*. Execution is the
> migration **runner** (`npm run migrate`, `schema_migrations` ledger); the combined `RUN_*.sql`
> files are non-authoritative aids. Hosted (staging/production) state is asserted **only** from an
> owner confirmation with a date; where none exists it is recorded **"owner confirmation required."**
> This development process has **not** applied any migration to a hosted database and has **not**
> enabled any feature flag.

## Migration source of truth

- **Canonical migrations:** `src/db/migrations/0001_*.sql` … `0109_*.sql` (forward-only,
  sequential; `migration-lint` confirms 0001–0109, no gaps **within this line**). This
  directory is the **one** migration source of truth.
  - ⚠️ **Two lines exist.** `origin/main` (deployed) carries 0001–**0069** and its 0069 is
    `0069_company_routing_and_catalogue_department.sql`. This branch line carries 0001–0109
    and its 0069 is `0069_durable_inbound_processing.sql`. `migration-lint` checks numeric
    sequence within one checkout and therefore **cannot detect this collision** — see the
    R0 correction banner above.
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
| 0062 | secure_definer_function_grants (4th/security-boundary review: lock every service-only SECURITY DEFINER function — `_journal_post_internal` incl. its legacy 7-arg signature, `claim_outbox_batch`, `complete_outbox_and_advance`, `ledger_integrity_report`, `_journal_fp_matches`, `enqueue_outbox_row`, `reconcile_quotation_from_outbox` — to `service_role`; name-based + `to_regprocedure`-guarded, idempotent, upgrade-safe) | ⛔ **owner confirmation required** (added 2026-08-16; dev-verified on disposable PostgreSQL 16, fresh + upgrade). **Note:** `claim_outbox_batch`/`ledger_integrity_report`/legacy `_journal_post_internal` from 0038–0041 are **already hosted and may be `authenticated`-executable** — see `HOSTED_SECDEF_PRIVILEGE_HOTFIX.md` for the prepared read-only check + emergency REVOKE. |
| 0063 | wp12_atomic_quotation_enqueue (5th/final review: atomic service-only `enqueue_quotation_outbox` RPC — locks the company-scoped quotation row, and only if still legally `ready` inserts the outbox row AND advances ready→queued in ONE transaction, closing the enqueue race; result `enqueued`/`duplicate`/`terminal`/`not_ready`/`stale`/`inconsistent`; plus a BEFORE UPDATE trigger enforcing the legal quotation lifecycle at the DB boundary — `queued` can never jump to a terminal state) | ⛔ **owner confirmation required** (added 2026-08-16; dev-verified on disposable PostgreSQL 16, fresh + upgrade) |
| 0064 | wp12_delivery_transition_boundary (6th review: the privileged delivery transitions `ready→queued`/`queued→sent`/`ready→sent` are RPC-ONLY — the SECURITY INVOKER lifecycle trigger refuses them when `current_user` is a PostgREST API role, so a direct table UPDATE by authenticated/service_role cannot bypass the atomic/fenced RPCs; and `enqueue_quotation_outbox`'s ready+existing-row recovery now requires an EXACT delivery-identity+payload match — company/source/key/channel/recipient/body/message_purpose — else `inconsistent`) | ⛔ **owner confirmation required** (added 2026-08-16; dev-verified on disposable PostgreSQL 16, fresh + upgrade, incl. authenticated-role and service-role adversarial tests) |
| 0065 | wp12_claim_and_insert_boundary (7th review: (a) `claim_outbox_batch` is now **quotation-aware** — a quotation-delivery outbox row is claimable ONLY when its linked quotation is committed `queued` (same company, `source_type`+`message_purpose` both `quotation`, `source_id` present), so a stale `ready` row left after an `inconsistent` enqueue can never be leased/sent; either-field-`quotation`-with-mismatch fails closed; generic rows keep retry/lease/SKIP-LOCKED eligibility. (b) a BEFORE INSERT trigger restricts non-trusted writers to the initial state (`status=draft`, `sent_at` null); the UPDATE trigger's privileged-transition and `sent_at` guards now use a **positive owner allowlist** — `_is_quotation_delivery_owner()` derived from the delivery functions' OWNER — not a role-name denylist, so a bespoke custom role is refused both the fabricating INSERT and the privileged UPDATE) | ⛔ **owner confirmation required** (added 2026-08-16; dev-verified on disposable PostgreSQL 16, fresh + upgrade, incl. authenticated-role, service-role AND custom-role adversarial tests) |
| 0066 | wp12_snapshot_and_delete_boundary (8th review: (a) `_is_quotation_delivery_owner()` is **signature-exact** — resolves the owner from the EXACT 9-arg `enqueue_quotation_outbox` identity, with a migration-time fail-closed assertion that enqueue/complete/reconcile all exist, are SECURITY DEFINER, share ONE owner, and are unreachable (SET ROLE) by anon/authenticated/service_role; a like-named overload with a different owner cannot flip it. (b) a BEFORE DELETE trigger refuses a non-trusted delete of a quotation that is queued/terminal OR has ANY outbox delivery history — closing the claim-then-delete race; the trusted owner keeps a maintenance override. (c) a whole-row BEFORE UPDATE freeze + `quotation_items` INSERT/UPDATE/DELETE triggers make a queued/terminal quotation and its items immutable to non-trusted writers except a pure `sent→accepted`/`sent→rejected` decision; pre-queue editing stays functional. The `quotation_items` parent-status read uses a self-gating SECURITY DEFINER helper so RLS visibility cannot bypass the freeze, without becoming a cross-company oracle. The eighth review's own security pass added `search_path`/`pg_temp` hardening — every function schema-qualifies relations + pins `search_path = pg_catalog, public, pg_temp`, the WP12 delivery RPCs are re-pinned via ALTER FUNCTION — and a `message_outbox` CONTENT freeze (recipient/body/template/source immutable to `service_role`; delivery-state stays worker-mutable) + TRUNCATE/DELETE guards. Documented residual: a full-codebase search_path audit of other-domain SECURITY DEFINER functions is a recommended systemic follow-up, out of WP12 scope) | ⛔ **owner confirmation required** (added 2026-08-16; dev-verified on disposable PostgreSQL 16, fresh + upgrade, incl. a GENUINE two-connection claim-vs-delete/mutate race, a fake-overload adversarial test, and pg_temp-shadowing-resistance tests) |
| 0067 | systemic_search_path_and_enqueue_item_boundary (9th + 10th review — the 10th being the SECOND AND FINAL bounded correction loop, edited in place after reconfirming 0067 was never applied outside disposable databases: (a) a CATALOG-DRIVEN `ALTER FUNCTION` re-pins EVERY non-extension SECURITY DEFINER function and every trigger function in `public` (selected by `pg_has_role(current_user, proowner, 'USAGE')`, NOT a strict owner match) to `search_path = pg_catalog, extensions, public, pg_temp`, closing the `pg_temp` relation-shadowing class across identity-RLS/approvals/journals/settlement/reimbursement/bank-change/fingerprint/integrity — bodies unchanged, ONLY search_path. Fails closed if anon/authenticated/service_role has CREATE — direct or SET-ROLE-reachable — on public/extensions (reports; does not revoke blindly), and SELF-VERIFIES owner-agnostically with a STRICT-CANONICAL predicate: any in-scope function whose parsed path is not EXACTLY `pg_catalog, extensions, public, pg_temp` ABORTS the migration naming it (10th review: pg_temp-last alone was insufficient — a path can LEAD with an attacker-writable schema that wins relation resolution; strict equality also subsumes `$user` and duplicated-pg_temp). The permanent owner-agnostic integration gate — `search-path-safety.test.ts` — enforces the same strict-canonical predicate. (b) closes the quotation-item vs atomic-enqueue race at a SINGLE linearization lock: `_quotation_status_for_guard()` reads the parent quotation FOR UPDATE (serializing every non-trusted item write with `enqueue_quotation_outbox`'s parent lock), enqueue takes NO item-row locks (the target item row is locked BEFORE its row trigger fires, so child-row locking would form an AB-BA deadlock — one lock object cannot cycle) and requires UNCONDITIONALLY that `p_expected_total` equal the live SUM(line_total) — NO item-count exemption (delete-to-zero → `stale`) — refusing any INCOMPLETE snapshot line (10th review: `status<>'priced'`, NULL `unit_price`, NULL `line_total` [SUM skips NULL], or item currency ≠ the LOCKED quotation currency; mirrored 1:1 by `refreshQuotationStatus`/`priceQuotation`/`resolvePriceConfirmation` — no float, no conversion); `quotation_items_enforce_frozen` FAILS CLOSED on a NULL guard result (raw `service_role` with no JWT claims — BYPASSRLS, no RLS backstop). (c) 10th review: the predicted draft-deletion cascade regression does NOT occur — RI cascade queries run as the `quotation_items` TABLE OWNER (= the trusted delivery owner; observed live: current_user=owner, depth=2), so authorised pre-queue deletes of itemised quotations cascade cleanly; that ownership invariant (quotations/quotation_items owner == exact 9-arg enqueue owner) is ASSERTED fail-closed by the migration. enqueue keeps its exact signature/SECURITY DEFINER owner/service-role-only EXECUTE/result semantics) | ⛔ **owner confirmation required** (added 2026-08-17; dev-verified on disposable PostgreSQL 16, fresh + upgrade, incl. genuine two-connection enqueue-vs-item-mutation races [both commit orders + a deterministic AB-BA-window no-deadlock proof + delete-to-zero + unpriced/NULL-line_total/wrong-currency items + no-claims fail-closed UPDATE and DELETE + the draft/awaiting_price-with-items cascade pin] and cross-domain pg_temp-shadowing adversarial tests; fail-closed/self-verify paths empirically simulated: foreign-owner residual ABORTS naming the function, attacker-schema-leading pg_temp-last path ABORTS naming the function, SET-ROLE-reachable CREATE ABORTS naming the path, table-ownership divergence ABORTS naming table+owners). Prepared, NOT executed: `hosted_secdef_searchpath_check.sql` (read-only, strict-canonical) + `hosted_secdef_searchpath_hardening.sql` (owner-approved, self-verifying, strict-canonical) for the already-hosted 0038–0041 functions. |
| 0068 | ai_atomic_case_persistence (completion program P1B: `management_cases.idempotency_key` UNIQUE per company + `tasks.management_case_id` linkage + the service-only SECURITY DEFINER RPC `create_management_case_atomic` — the AI-manager analysis paths now persist the case + ALL captured tasks + the audit event in ONE transaction; any invalid row rolls everything back; replaying the same (company, idempotency_key) returns the ORIGINAL result; task status is FORCED to `captured` at the boundary; ≤20 tasks; canonical search_path; signature-exact `service_role`-only EXECUTE with an in-function `caller_jwt_role()` fail-closed gate. The manual path's identity is a company+content hash — the constant "manual" identity is gone; the WhatsApp path's is conversation+transcript hash. Persistence failure now FAILS the analysis; the log-and-continue helper was removed) | ⛔ **owner confirmation required** (added 2026-08-17, completion program; dev-verified on disposable PostgreSQL 16 fresh 0001→0068 + upgrade 0058→0068, incl. two-connection identical-submission concurrency, atomic-rollback, forced-status, hostile-role 42501 tests) |


### Branch-line migrations 0069–0109 (PR-F-011 — previously unrecorded)

These 41 migrations exist on `claude/hard-scenario-testing` and its descendants.
**None is on `origin/main`, so none is deployed.** None has been applied to any hosted
database by this development process. Each was verified only on disposable PostgreSQL 16.

⚠️ **The `0069` in this table is NOT the `0069` on `main`.** See the R0 correction
banner at the top of this file. Applying this line to a database that already ran
`main`'s `0069_company_routing_and_catalogue_department.sql` will **silently skip** this
migration and then run 0070–0109 against a schema missing its objects.

| Migration | Purpose (first header line of the migration file) | Hosted state |
|---|---|---|
| 0069 | `durable inbound processing` — durable inbound processing: leases, bounded retry, dead-letter, fair eligibility. | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0070 | `channel identity resolution` — trusted channel identity resolution (FOUND-003 prerequisite). | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0071 | `task identity dedup` — durable, server-generated task identity and deduplication (AIM-002). | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0072 | `task routing state` — durable task ROUTING state (AIM-003). | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0073 | `case tasks through dedup` — the AI analysis path now creates tasks THROUGH the AIM-002 deduplication boundary. | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0074 | `channel account company resolution` — resolve the RECEIVING company from trusted channel configuration (FOUND-003). | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0075 | `inbound review queue` — the manual-review queue an inbound message actually lands in (FOUND-003). | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0076 | `inbound boundary correction` — inbound boundary correction (correction loop 1 for AIM-002 / AIM-003 / FOUND-003). | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0077 | `inbound boundary correction 2` — inbound boundary, correction loop 2. | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0078 | `routing provenance split` — a routing decision's provenance is DERIVED, never asserted (remediation R1 §2, OF-007). | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0079 | `dispatch release` — hand a leased dispatch back instead of burning it (remediation R1 §3, OF-001). | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0080 | `owner configuration surface` — owner configuration as an audited workflow, not hand-edited SQL (R1 §5, OF-004/OF-005). | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0081 | `approval submitter provenance` — 0081_approval_submitter_provenance.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0082 | `review loop corrections` — the database half of R1 review loop 1. | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0083 | `loop2 corrections` — correction loop 2. The LAST correction loop this package gets. | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0084 | `caller trust boundary` — FOUND-006: a caller's database PRIVILEGE decides service authority, never its request text. | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0085 | `trust boundary corrections` — FOUND-006 correction loop 1. An independent security review returned CHANGES REQUESTED. | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0086 | `actor privilege not claim` — 0086_actor_privilege_not_claim.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0087 | `duplicate review resolution` — 0087_duplicate_review_resolution.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0088 | `duplicate review boundary corrections` — 0088_duplicate_review_boundary_corrections.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0089 | `duplicate review sibling and budget` — 0089_duplicate_review_sibling_and_budget.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0090 | `inbound review grant authority` — OF-018: inbound-review service authority is the EXECUTE grant, not request text. | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0091 | `model gateway telemetry` — 0091_model_gateway_telemetry.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0092 | `model gateway budget policy rls` — MOD-003: configuration is human-governed; attempt telemetry remains worker-only. | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0093 | `risk register` — 0093_risk_register.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0094 | `insurance register` — 0094_insurance_register.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0095 | `integration gateway` — 0095_integration_gateway.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0096 | `management directives` — 0096_management_directives.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0097 | `ai guide messages` — 0097_ai_guide_messages.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0098 | `conflicting directive resolution` — 0098_conflicting_directive_resolution.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0099 | `directive escalation` — 0099_directive_escalation.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0100 | `commitment expected payments` — 0100_commitment_expected_payments.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0101 | `service provider registry` — 0101_service_provider_registry.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0102 | `counterparty compliance` — 0102_counterparty_compliance.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0103 | `task escalation chain` — 0103_task_escalation_chain.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0104 | `communication preferences` — 0104_communication_preferences.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0105 | `funding requirements and investments` — 0105_funding_requirements_and_investments.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0106 | `incidents and statutory obligations` — 0106_incidents_and_statutory_obligations.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0107 | `project risks decisions scenarios` — 0107_project_risks_decisions_scenarios.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0108 | `push subscriptions` — 0108_push_subscriptions.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |
| 0109 | `bounded user text` — 0109_bounded_user_text.sql | ⛔ **owner confirmation required** — never applied to any hosted DB by this process; dev-verified on disposable PostgreSQL 16 |

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
> **0042 through 0067** has hosted state **"owner confirmation required"** (dev-process verified on
> disposable PostgreSQL 16 only).

### Phase 1 correction migrations (0048–0067) — the five states, kept separate (WP18)

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
| 0062 secdef grants (rev 4, security) | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |
| 0063 atomic quote enqueue (rev 5, final) | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a — sync path runs with `WHATSAPP_ASYNC` OFF |
| 0064 delivery-transition boundary (rev 6) | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |
| 0065 claim + INSERT boundary (rev 7) | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a — sync path runs with `WHATSAPP_ASYNC` OFF |
| 0066 snapshot + delete boundary (rev 8) | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a — sync path runs with `WHATSAPP_ASYNC` OFF |
| 0067 systemic search_path + enqueue-item race (rev 9) | ✅ | ✅ | ⛔ owner confirmation required | ⛔ owner confirmation required | n/a (no flag) |

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
| **Hosted (owner-reported)** | **Owner reported applying 0038–0041 to the hosted Supabase DB on 2026-08-07** (SQL editor, `RUN_0038-0041_security_reliability_gate.sql`). This development process has **no hosted access** and cannot independently re-verify presence or ACLs. The **RLS write-policy** parts are inert while `RLS_WRITES` is OFF; the **RPC hardening (0039)** and **audit/health (0041)** are behaviour-changing once applied. **Security caveat:** 0039/0040/0041 revoked service-only function EXECUTE only **from PUBLIC**, and managed Supabase grants `authenticated` EXECUTE on `public` functions directly — so `claim_outbox_batch`, `ledger_integrity_report` and the legacy 7-arg `_journal_post_internal` may be **`authenticated`-executable on the hosted DB**. Mitigation prepared (not executed): `HOSTED_SECDEF_PRIVILEGE_HOTFIX.md`; migration **0062** fixes it permanently once applied. |

> This is the single authoritative 0038–0041 hosted statement; earlier prose that said both "applied
> 2026-08-07" and "not applied to any environment" is void — treat 0038–0041 as **owner-reported
> applied to the hosted DB, unverified by this process**. These four migrations were authored offline
> and **not** run by the development process.
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
