# ⛔ R1 DRAFT MIGRATIONS — NOT FOR HOSTED APPLICATION

**These files are NOT production migrations. They must never be applied to a hosted
database — not production, not staging, not any Supabase project.**

## Why this directory exists

R1 needs six new tables. Migration numbers cannot yet be assigned because two blocking
defects are unresolved:

- **PR-F-001** — `origin/main` and this branch line each define a *different* migration
  numbered `0069`, and `scripts/migrate.mjs` keys its ledger on the four-character prefix
  alone, so a colliding migration is **silently skipped**.
- **PR-F-004** — the real hosted migration state is unknown; the authoritative record
  contradicts the deployed code.

Assigning numbers now would add to that collision. Owner decision **R1-D-1** therefore
directs that the R1 schema live here, quarantined, until the hosted schema investigation
completes and these are **regenerated into the reconciled numbered sequence**.

## How the quarantine is enforced

Four independent mechanisms, each separately tested in
`tests/r1/draft-migration-isolation.test.ts`:

1. **Different directory.** `scripts/migrate.mjs` hardcodes `const DIR = "src/db/migrations"`.
   Nothing here is in that directory, so `npm run migrate` cannot see it.
2. **Filename shape.** The production runner selects files matching `/^\d{4}_.*\.sql$/`.
   Every file here is named `R1_DRAFT_NNN_*.sql`, which **fails that pattern**. Even if
   someone copied these into the production migrations directory, the runner would still
   ignore them.
3. **Separate ledger.** These are applied by `scripts/r1/draft-migrate.mjs`, which records
   state in its own `r1_draft_migrations` table and **never writes `schema_migrations`**.
   Applying drafts therefore cannot make the production runner believe a numbered
   migration is done.
4. **Local-only guard, fail-closed.** The draft runner refuses any `DATABASE_URL` that is
   not loopback, and additionally requires the explicit environment variable
   `R1_DRAFT_CONFIRM=disposable-local-only`. Both must hold; either missing is a refusal.

## How to apply (disposable local database ONLY)

```bash
R1_DRAFT_CONFIRM=disposable-local-only \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/r1_draft \
  node scripts/r1/draft-migrate.mjs --up

# fully reversible
R1_DRAFT_CONFIRM=disposable-local-only \
DATABASE_URL=... node scripts/r1/draft-migrate.mjs --down
```

`--status` reports applied versus pending without changing anything.

## Reversibility

Every unit has a matching `.down.sql`. `--down` rolls back in reverse order, each unit in
its own transaction. The rollback is proven by
`tests/integration/r1-draft-schema.test.ts`, which applies the full set to a disposable
PostgreSQL 16, exercises the schema, rolls back, and asserts **no R1 object remains**.

## Base-schema awareness

These units are written to work in **both** contexts:

- **Standalone** (an empty disposable database) — for fast schema and lifecycle tests.
- **On top of the full application schema** — the foreign keys to `companies`,
  `memberships` and `management_cases`, and the RLS policies, are applied **only when
  those objects exist**, guarded by `to_regclass(...) is not null`.

**Known difference to close at reconciliation time:** the composite `(company_id, id)`
foreign keys used elsewhere in this repository, and the full capability-gated write RLS
matrix, are deliberately minimal here. The regenerated numbered migrations must add them
to match the existing pattern before anything is applied to a hosted database.

## Units

| Unit | Table |
|---|---|
| `R1_DRAFT_001` | `management_items` — the loop instance |
| `R1_DRAFT_002` | `management_item_transitions` — append-only state history |
| `R1_DRAFT_003` | `management_item_evidence` — evidence references |
| `R1_DRAFT_004` | `management_item_decisions` — approve/reject/edit/delegate |
| `R1_DRAFT_005` | `observation_sources` — detector registry and cadence |
| `R1_DRAFT_006` | `management_item_feedback` — outcome capture for later learning |

`R1_DRAFT_002` also creates `r1_draft_transition_item()`, the concurrency-safe transition
function (`FOR UPDATE` plus an expected-from assertion).
