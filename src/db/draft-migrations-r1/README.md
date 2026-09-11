# The R1 draft chain — PROMOTED, 2026-09-11

**This directory no longer contains migrations.** Its thirty units were promoted into the numbered
Release 1 lineage as `0111`–`0140` and the SQL was removed from here, so there is exactly one
runnable copy of each.

```
R1_DRAFT_001_management_items   →  src/db/migrations/0111_management_items.sql
R1_DRAFT_002_transitions        →  src/db/migrations/0112_transitions.sql
…
R1_DRAFT_030_cycle_lease        →  src/db/migrations/0140_cycle_lease.sql
```

The complete mapping is `docs/release-1/migration-promotion-map.json`, and the reasoning is
`docs/release-1/MIGRATION-PROMOTION.md`.

## What replaced what

| Before | After |
|---|---|
| `scripts/r1/draft-migrate.mjs`, `R1_DRAFT_CONFIRM=disposable-local-only` | `npm run migrate` — the ordinary runner, no special confirmation |
| the `r1_draft_migrations` ledger | `schema_migrations`, the one ledger |
| `*.down.sql` beside the up files | `src/db/rollback/NNNN_*.down.sql` |

A fresh database is now `0001`–`0142` in one run. There is no draft-only runner and no second
ledger.

## Why this directory still exists

For this file. The quarantine is a large part of how the Release 1 evidence reads — owner decision
R1-D-1, PR-F-001, PR-F-004 — and a reader who follows one of those references to a directory that
silently vanished learns nothing. Deleting the explanation along with the SQL would make the
record harder to check, which is the opposite of why the quarantine existed.

## Why the quarantine was lifted

R1-D-1 held the units outside the numbered sequence while **the hosted migration state was
unknown** and while the `0069` collision (PR-F-001) was open. Both conditions are closed:

* **Case A is proven.** A SELECT-only probe of the hosted database showed a 69-row contiguous
  ledger whose high-water is `main`'s `0069_company_routing_and_catalogue_department.sql`, with the
  recovery-branch markers absent and 0 of 27 branch tables present — so the hosted lineage is
  `main`'s, and the candidate's renumbering is correct as it stands.
* **The collision is gone.** `npm run migration-collision-check` reports no collision against
  `origin/main` at `acd9fbec`.

The owner approved promotion on 2026-09-11, together with the schema policy that produced
`0141` (every client-writable text field bounded in the database) and `0142` (every tenant-owned
relationship enforcing tenant integrity).

## Applying a rollback

`src/db/rollback/` is not read by the forward runner — it is a different directory and the
filenames are not `NNNN_name.sql`. Applying one is a deliberate manual act, in reverse dependency
order, on a database somebody has decided to roll back. The numbered chain itself remains
forward-only.
