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

> A durable, queryable applied-migrations ledger (a `schema_migrations` table populated
> by the runner) is recommended and is in scope for WP6 (migration validation in CI).
> Until it exists, this file is the record.
