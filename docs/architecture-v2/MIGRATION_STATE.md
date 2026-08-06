# Migration State (per environment)

> **Purpose (WP0 item 5).** Record the **actual applied migration state** separately
> for local, staging and production. **A migration is never recorded as "applied"
> merely because the `.sql` file exists in the repo.** Applied state is only asserted
> when an operator has confirmed it against the live database, with a date.
>
> This file is the single place to track applied-state. Update it whenever a migration
> is run against any environment, and cite who confirmed it and when.

_Last reviewed: 2026-08-06 (WP0)._

## Migration source of truth

- **Canonical migrations:** `src/db/migrations/0001_*.sql` … `0022_*.sql` (forward-only,
  sequential). This directory is the **one** migration source of truth.
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
