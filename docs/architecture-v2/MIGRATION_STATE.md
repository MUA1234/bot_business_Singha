# Migration State (per environment)

> **Purpose (WP0 item 5).** Record the **actual applied migration state** separately
> for local, staging and production. **A migration is never recorded as "applied"
> merely because the `.sql` file exists in the repo.** Applied state is only asserted
> when an operator has confirmed it against the live database, with a date.
>
> This file is the single place to track applied-state. Update it whenever a migration
> is run against any environment, and cite who confirmed it and when.

_Last reviewed: 2026-09-01 — **migrations 0048–0068 APPLIED TO PRODUCTION**._

> **2026-09-01 production application (owner-authorised).** The owner supplied hosted credentials and
> instructed that the full set be applied. Recorded facts, all verified against the live database:
>
> - **Pre-state:** the `schema_migrations` ledger held **47** rows (0001–0047). The earlier record in
>   this file — that 0042–0047 were "not applied to any environment" — was **WRONG**; they were applied.
>   Rows below are corrected.
> - **Backup** taken before any change (`pg_dump`, 540 KB, pre-0048 state).
> - **Preflight (0060)** ran clean: both legacy company-mismatch queries returned 0 rows. The two
>   NOT VALID FKs (`approval_requests_fe_company_fk`, `approval_actions_request_company_fk`) were
>   subsequently **VALIDATED**.
> - **Security pre-state (confirmed live exposure):** `_journal_post_internal`, `claim_outbox_batch` and
>   `ledger_integrity_report` were **EXECUTE-able by `anon` and `authenticated`**, and **25 of 25**
>   application SECURITY DEFINER/trigger functions had an unsafe `search_path`. The prepared
>   `hosted_secdef_emergency_revoke.sql` was applied first to close the execute window, then the full
>   migration set.
> - **Applied:** 0048 → 0068, **21 migrations**, all succeeding; ledger now **68**. Migration 0067's
>   fail-closed self-verification passed.
> - **Post-state:** exposure `false` on all 7 service-only SECURITY DEFINER functions; **0 of 39**
>   functions with an unsafe `search_path`; 373 RLS policies; RLS on every table except the four global
>   catalogues (`roles`, `permissions`, `role_permissions`, `schema_migrations`).
> - **Data preserved:** 1 company, 3 profiles, 3 memberships, 2 conversations, 14 messages — unchanged.
> - **Functional verification on production** (single transaction, ROLLED BACK, nothing persisted):
>   `enqueue_outbox_row` → enqueued then duplicate on replay; `enqueue_quotation_outbox` → enqueued with
>   quotation `ready`→`queued`; `claim_outbox_batch` → leased; `complete_outbox_and_advance` → true with
>   quotation `queued`→`sent`; `create_management_case_atomic` → case + 1 task at `captured`, and a replay
>   of the same idempotency key returned the ORIGINAL case creating nothing new.
> - **Not changed:** no feature flag was enabled; `RLS_READS`, `RLS_WRITES` and `WHATSAPP_ASYNC` remain OFF.

> **WP18 authority note.** This file is **the** authoritative migration-state document. The five
> states below are tracked **separately** and never conflated — in particular, *file exists* and
> *tested on a disposable database* never imply *applied to staging/production*. Execution is the
> migration **runner** (`npm run migrate`, `schema_migrations` ledger); the combined `RUN_*.sql`
> files are non-authoritative aids. Hosted (staging/production) state is asserted **only** from an
> owner confirmation with a date; where none exists it is recorded **"owner confirmation required."**
> **Superseded 2026-09-01:** the owner supplied hosted credentials and authorised application, so
> 0048–0068 are now recorded **applied to production** with a date and live verification (see the
> 2026-09-01 note at the top). **No feature flag has been enabled** — `RLS_READS`, `RLS_WRITES` and
> `WHATSAPP_ASYNC` remain OFF.

## Migration source of truth

- **Canonical migrations:** `src/db/migrations/0001_*.sql` … `0068_*.sql` (forward-only,
  sequential; `migration-lint` confirms 0001–0068, no gaps). This directory is the **one**
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
| 0014 | departments_expansion | ✅ confirmed applied (verified in the `schema_migrations` ledger, 2026-09-01) |
| 0015 | post_journal_rpc | ✅ confirmed applied (verified in the `schema_migrations` ledger, 2026-09-01) |
| 0016 | settlement_and_reversal | ✅ confirmed applied (verified in the `schema_migrations` ledger, 2026-09-01) |
| 0017 | hr_workforce | ✅ confirmed applied (verified in the `schema_migrations` ledger, 2026-09-01) |
| 0018 | marketing_objectives | ✅ confirmed applied (verified in the `schema_migrations` ledger, 2026-09-01) |
| 0019 | task_assignment | ✅ confirmed applied (verified in the `schema_migrations` ledger, 2026-09-01) |
| 0020 | rfq | ✅ confirmed applied (verified in the `schema_migrations` ledger, 2026-09-01) |
| 0021 | inventory | ✅ confirmed applied (verified in the `schema_migrations` ledger, 2026-09-01) |
| 0022 | notifications | ✅ confirmed applied (verified in the `schema_migrations` ledger, 2026-09-01) |
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
| 0042 | authority_tightening (review follow-up: self-service claims tied to the authenticated employee; capability-gate remaining financial subledger tables; payment_allocations service-only) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0043 | transactional_finance (review follow-up: full-payload idempotency; transactional post_customer_invoice / post_supplier_bill / reimburse_expense_claim RPCs) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0044 | canonical_idempotency_and_lifecycle (correction WP3/WP4: SHA-256 canonical fingerprint binding operation+source+date+currency+memo+lines; legacy null-hash upgrade; reimbursement source binding; invoice/bill lifecycle; actor from auth.uid + p_by mismatch reject + system actor_type) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0045 | bank_change_maker_checker (correction WP6: request/decision RPCs; supplier_bank_detail_changes RPC-only; maker<>checker; no bank numbers in audit) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0046 | authority_and_approvals (correction WP7: authority_rules.is_unlimited; deny-by-default within_authority; decide_approval RPC; approval_actions RPC-only) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0047 | rls_write_matrix (correction WP8: capability-gate remaining sensitive finance/bank/planning/inventory/fleet/identity tables; operations.fleet.manage) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0048 | wp10_sensitive_write_rls (Phase 1 WP10: remove broad company-member writes; capability-gate 18 commercially-sensitive tables; WhatsApp/notifications service-only) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0049 | wp17_system_actor (Phase 1 WP17: `_resolve_actor` — system path only via service_role JWT; reject missing/malformed/anon/unknown; EXECUTE revoked from PUBLIC) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0050 | wp13_posted_journal_immutability (Phase 1 WP13: allowlist whole-row posted-journal immutability; posted lines immutable to INSERT too) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0051 | wp14_canonical_json_fingerprint (Phase 1 WP14: versioned canonical-JSON SHA-256 fingerprint `v3:`; v2/legacy-NULL compatibility) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0052 | wp15_invoice_bill_invariants (Phase 1 WP15: require source lines, positive header, header = line total; verify an existing journal is this document's) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0053 | wp16_reimbursement_reuse_validation (Phase 1 WP16: full source-bound payload validation on reimbursement/payment reuse) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0054 | wp11_approval_scope_currency_delegation (Phase 1 WP11: authority_rules/delegations scope + is_company_wide; within_authority_for_event; strict currency; delegation ⊆ delegator) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0055 | wp12_truthful_delivery_state (Phase 1 WP12: outbox source metadata; quotations `queued` state; fenced `complete_outbox_and_advance` RPC; at-least-once) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0056 | wp15_source_binding_fingerprint (external-review B: invoice/bill existing-journal path recomputes the canonical fingerprint — a matching key alone is not proof of source binding) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0057 | wp11_approval_failclose_domain_caps (external-review C: fail-closed approvals incl. reject; deterministic domain→capability whitelist; duplicate-action conflict; delegation company-consistency) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0058 | wp12_message_history_on_completion (external-review A: outbound wa_messages written atomically on durable send only, with the provider id) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0059 | wp15_fp_matches_privilege (2nd review: REVOKE _journal_fp_matches EXECUTE from PUBLIC/anon/authenticated) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0060 | wp11_composite_fk_money_failclose (2nd review: composite company-consistency FKs NOT VALID + preflight; decide_approval fails closed on non-positive/non-finite amount, invalid currency, invalid approvals_required) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0061 | final_review_currency_enqueue_reconcile (3rd/final review: `currencies` catalogue — `is_active` + 16 seeded ISO codes on the existing 0002 table; `decide_approval` validates currency against it; service-only `enqueue_outbox_row` + `reconcile_quotation_from_outbox` RPCs, EXECUTE revoked from authenticated/anon) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0062 | secure_definer_function_grants (4th/security-boundary review: lock every service-only SECURITY DEFINER function — `_journal_post_internal` incl. its legacy 7-arg signature, `claim_outbox_batch`, `complete_outbox_and_advance`, `ledger_integrity_report`, `_journal_fp_matches`, `enqueue_outbox_row`, `reconcile_quotation_from_outbox` — to `service_role`; name-based + `to_regprocedure`-guarded, idempotent, upgrade-safe) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0063 | wp12_atomic_quotation_enqueue (5th/final review: atomic service-only `enqueue_quotation_outbox` RPC — locks the company-scoped quotation row, and only if still legally `ready` inserts the outbox row AND advances ready→queued in ONE transaction, closing the enqueue race; result `enqueued`/`duplicate`/`terminal`/`not_ready`/`stale`/`inconsistent`; plus a BEFORE UPDATE trigger enforcing the legal quotation lifecycle at the DB boundary — `queued` can never jump to a terminal state) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0064 | wp12_delivery_transition_boundary (6th review: the privileged delivery transitions `ready→queued`/`queued→sent`/`ready→sent` are RPC-ONLY — the SECURITY INVOKER lifecycle trigger refuses them when `current_user` is a PostgREST API role, so a direct table UPDATE by authenticated/service_role cannot bypass the atomic/fenced RPCs; and `enqueue_quotation_outbox`'s ready+existing-row recovery now requires an EXACT delivery-identity+payload match — company/source/key/channel/recipient/body/message_purpose — else `inconsistent`) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0065 | wp12_claim_and_insert_boundary (7th review: (a) `claim_outbox_batch` is now **quotation-aware** — a quotation-delivery outbox row is claimable ONLY when its linked quotation is committed `queued` (same company, `source_type`+`message_purpose` both `quotation`, `source_id` present), so a stale `ready` row left after an `inconsistent` enqueue can never be leased/sent; either-field-`quotation`-with-mismatch fails closed; generic rows keep retry/lease/SKIP-LOCKED eligibility. (b) a BEFORE INSERT trigger restricts non-trusted writers to the initial state (`status=draft`, `sent_at` null); the UPDATE trigger's privileged-transition and `sent_at` guards now use a **positive owner allowlist** — `_is_quotation_delivery_owner()` derived from the delivery functions' OWNER — not a role-name denylist, so a bespoke custom role is refused both the fabricating INSERT and the privileged UPDATE) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0066 | wp12_snapshot_and_delete_boundary (8th review: (a) `_is_quotation_delivery_owner()` is **signature-exact** — resolves the owner from the EXACT 9-arg `enqueue_quotation_outbox` identity, with a migration-time fail-closed assertion that enqueue/complete/reconcile all exist, are SECURITY DEFINER, share ONE owner, and are unreachable (SET ROLE) by anon/authenticated/service_role; a like-named overload with a different owner cannot flip it. (b) a BEFORE DELETE trigger refuses a non-trusted delete of a quotation that is queued/terminal OR has ANY outbox delivery history — closing the claim-then-delete race; the trusted owner keeps a maintenance override. (c) a whole-row BEFORE UPDATE freeze + `quotation_items` INSERT/UPDATE/DELETE triggers make a queued/terminal quotation and its items immutable to non-trusted writers except a pure `sent→accepted`/`sent→rejected` decision; pre-queue editing stays functional. The `quotation_items` parent-status read uses a self-gating SECURITY DEFINER helper so RLS visibility cannot bypass the freeze, without becoming a cross-company oracle. The eighth review's own security pass added `search_path`/`pg_temp` hardening — every function schema-qualifies relations + pins `search_path = pg_catalog, public, pg_temp`, the WP12 delivery RPCs are re-pinned via ALTER FUNCTION — and a `message_outbox` CONTENT freeze (recipient/body/template/source immutable to `service_role`; delivery-state stays worker-mutable) + TRUNCATE/DELETE guards. Documented residual: a full-codebase search_path audit of other-domain SECURITY DEFINER functions is a recommended systemic follow-up, out of WP12 scope) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0067 | systemic_search_path_and_enqueue_item_boundary (9th + 10th review — the 10th being the SECOND AND FINAL bounded correction loop, edited in place after reconfirming 0067 was never applied outside disposable databases: (a) a CATALOG-DRIVEN `ALTER FUNCTION` re-pins EVERY non-extension SECURITY DEFINER function and every trigger function in `public` (selected by `pg_has_role(current_user, proowner, 'USAGE')`, NOT a strict owner match) to `search_path = pg_catalog, extensions, public, pg_temp`, closing the `pg_temp` relation-shadowing class across identity-RLS/approvals/journals/settlement/reimbursement/bank-change/fingerprint/integrity — bodies unchanged, ONLY search_path. Fails closed if anon/authenticated/service_role has CREATE — direct or SET-ROLE-reachable — on public/extensions (reports; does not revoke blindly), and SELF-VERIFIES owner-agnostically with a STRICT-CANONICAL predicate: any in-scope function whose parsed path is not EXACTLY `pg_catalog, extensions, public, pg_temp` ABORTS the migration naming it (10th review: pg_temp-last alone was insufficient — a path can LEAD with an attacker-writable schema that wins relation resolution; strict equality also subsumes `$user` and duplicated-pg_temp). The permanent owner-agnostic integration gate — `search-path-safety.test.ts` — enforces the same strict-canonical predicate. (b) closes the quotation-item vs atomic-enqueue race at a SINGLE linearization lock: `_quotation_status_for_guard()` reads the parent quotation FOR UPDATE (serializing every non-trusted item write with `enqueue_quotation_outbox`'s parent lock), enqueue takes NO item-row locks (the target item row is locked BEFORE its row trigger fires, so child-row locking would form an AB-BA deadlock — one lock object cannot cycle) and requires UNCONDITIONALLY that `p_expected_total` equal the live SUM(line_total) — NO item-count exemption (delete-to-zero → `stale`) — refusing any INCOMPLETE snapshot line (10th review: `status<>'priced'`, NULL `unit_price`, NULL `line_total` [SUM skips NULL], or item currency ≠ the LOCKED quotation currency; mirrored 1:1 by `refreshQuotationStatus`/`priceQuotation`/`resolvePriceConfirmation` — no float, no conversion); `quotation_items_enforce_frozen` FAILS CLOSED on a NULL guard result (raw `service_role` with no JWT claims — BYPASSRLS, no RLS backstop). (c) 10th review: the predicted draft-deletion cascade regression does NOT occur — RI cascade queries run as the `quotation_items` TABLE OWNER (= the trusted delivery owner; observed live: current_user=owner, depth=2), so authorised pre-queue deletes of itemised quotations cascade cleanly; that ownership invariant (quotations/quotation_items owner == exact 9-arg enqueue owner) is ASSERTED fail-closed by the migration. enqueue keeps its exact signature/SECURITY DEFINER owner/service-role-only EXECUTE/result semantics) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |
| 0068 | ai_atomic_case_persistence (completion program P1B: `management_cases.idempotency_key` UNIQUE per company + `tasks.management_case_id` linkage + the service-only SECURITY DEFINER RPC `create_management_case_atomic` — the AI-manager analysis paths now persist the case + ALL captured tasks + the audit event in ONE transaction; any invalid row rolls everything back; replaying the same (company, idempotency_key) returns the ORIGINAL result; task status is FORCED to `captured` at the boundary; ≤20 tasks; canonical search_path; signature-exact `service_role`-only EXECUTE with an in-function `caller_jwt_role()` fail-closed gate. The manual path's identity is a company+content hash — the constant "manual" identity is gone; the WhatsApp path's is conversation+transcript hash. Persistence failure now FAILS the analysis; the log-and-continue helper was removed) | ✅ **applied to production** `gazjughejdzebathpscb` (owner-authorised 2026-09-01; verified in the `schema_migrations` ledger) |

> **Correction-phase note (0044–0047):** authored 2026-08-08, **not** applied to any hosted
> DB. Verified on a disposable local **PostgreSQL 16** (Supabase-compat shim) from a clean
> database AND via an **upgrade path** (staged at 0043 with legacy data — null-hash journal,
> unposted invoice, pending approval/outbox/bank-change — then migrated 0044→0047 cleanly;
> the legacy null-hash journal's identical retry returns the same journal and upgrades its
> fingerprint). 0044–0047 are pending owner application (with approval) via `npm run migrate`.
>
> **Reconciliation (WP18 — resolves the 0038–0043 contradiction).** The hosted record is:
> **0038–0041** were owner-applied to DB `gazjughejdzebathpscb` on **2026-08-07** (owner
> confirmation on record, combined file `RUN_0038-0041_*.sql`). **Superseded 2026-09-01:** the live
> `schema_migrations` ledger showed **0001–0047** already applied (so the claim that 0042–0047 were
> never applied was wrong), and **0048–0068 were then applied to production on 2026-09-01** under owner
> authorisation. Everything 0001–0068 is now applied and ledger-verified.

### Phase 1 correction migrations (0048–0067) — the five states, kept separate (WP18)

Each state is tracked independently; none implies another. "Applied to staging/production" is
asserted only from a dated owner confirmation — **granted 2026-09-01**, so these rows now read
**applied 2026-09-01**, verified against the live `schema_migrations` ledger. **What "flags OFF" does and does not mean (corrected):** it is **not** true that these
migrations are uniformly "inert at runtime while the flags are OFF." Only the **RLS read/write
cutover** is flag-inert (the app uses the service-role client, which bypasses RLS). The WP12 delivery
path (0055/0058/0061) runs on the **default synchronous WhatsApp path with `WHATSAPP_ASYNC` OFF**;
`decide_approval` (0054/0057/0060/0061) applies its authority/money/currency fail-close to **every
caller** of the RPC; and the composite FKs, function-privilege REVOKEs and `currencies` catalogue
enforce for **any** writer. **As of 2026-09-01 the hosted database IS migrated**, so all of this is
now live for every caller — the flags never gated it.

| Migration | File exists | Tested on disposable DB (PG 16, fresh + upgrade) | Applied to staging | Applied to production | Feature flag enabled |
|---|:---:|:---:|:---:|:---:|:---:|
| 0048 wp10 | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a — `RLS_WRITES` OFF |
| 0049 wp17 | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |
| 0050 wp13 | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |
| 0051 wp14 | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |
| 0052 wp15 | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |
| 0053 wp16 | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |
| 0054 wp11 | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |
| 0055 wp12 | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a — sync path runs with `WHATSAPP_ASYNC` OFF |
| 0056 wp15 (rev A) | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |
| 0057 wp11 (rev C) | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |
| 0058 wp12 (rev A) | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a — sync path runs with `WHATSAPP_ASYNC` OFF |
| 0059 wp15 (rev 2) | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |
| 0060 wp11 (rev 2) | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |
| 0061 wp11+wp12 (rev 3, final) | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |
| 0062 secdef grants (rev 4, security) | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |
| 0063 atomic quote enqueue (rev 5, final) | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a — sync path runs with `WHATSAPP_ASYNC` OFF |
| 0064 delivery-transition boundary (rev 6) | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |
| 0065 claim + INSERT boundary (rev 7) | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a — sync path runs with `WHATSAPP_ASYNC` OFF |
| 0066 snapshot + delete boundary (rev 8) | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a — sync path runs with `WHATSAPP_ASYNC` OFF |
| 0067 systemic search_path + enqueue-item race (rev 9) | ✅ | ✅ | ✅ applied 2026-09-01 | ✅ applied 2026-09-01 | n/a (no flag) |

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
| **Hosted (owner-reported)** | **Owner reported applying 0038–0041 to the hosted Supabase DB on 2026-08-07** (SQL editor, `RUN_0038-0041_security_reliability_gate.sql`). This development process has **no hosted access** and cannot independently re-verify presence or ACLs. The **RLS write-policy** parts are inert while `RLS_WRITES` is OFF; the **RPC hardening (0039)** and **audit/health (0041)** are behaviour-changing once applied. **Security caveat:** 0039/0040/0041 revoked service-only function EXECUTE only **from PUBLIC**, and managed Supabase grants `authenticated` EXECUTE on `public` functions directly — so `claim_outbox_batch`, `ledger_integrity_report` and the legacy 7-arg `_journal_post_internal` may be **`authenticated`-executable on the hosted DB**. **CONFIRMED AND RESOLVED 2026-09-01:** the read-only check on the live database showed all three functions EXECUTE-able by both `anon` and `authenticated`. `hosted_secdef_emergency_revoke.sql` was applied, then migration **0062**; a re-check reports `exposed = false` for all seven service-only functions. |

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
