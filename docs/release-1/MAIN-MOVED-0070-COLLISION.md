# The `0070` collision — RESOLVED

`origin/main` moved to `fd41d30` and took version `0070` for
`0070_identity_backfill_and_event_lifecycle.sql`. The candidate also had a `0070`. That is
resolved: main keeps `0070`, and the candidate's own sequence moved up by one.

> **A note on this file.** It previously described the collision as open, and the automated
> reference rewrite then edited the numbers inside it — so it briefly claimed the collision was
> between main's `0070` and a candidate file called `0071`, which is the resolved state, not the
> collision. A document about a past state whose numbers get mechanically updated stops describing
> anything. It is rewritten here rather than patched, and `scripts/shift-candidate-sequence.mjs`
> now carries an explicit skip list for the records that must not move.

## What collided

| Branch | File | Nature |
|---|---|---|
| `origin/main` | `0070_identity_backfill_and_event_lifecycle.sql` | **Data repair only** — no schema change, no new object, idempotent, forward-only |
| candidate (before the shift) | `0070_durable_inbound_processing.sql` | **Creates 16 objects**; six later migrations reference them |

`migrate.mjs` keys `schema_migrations` on the four-digit prefix and skips a recorded version
**silently**, so whichever `0070` was recorded first, the other would never run and nothing would
say so. Same defect class as PR-F-001, which is why the checker exists.

## The resolution

`scripts/shift-candidate-sequence.mjs`, driven by the working tree and by what `origin/main`
actually contains — not by a hardcoded list and not by the recovery branch, which is what the
older `migration-renumber.mjs` reads and why it planned a shift of forty files that no longer
exist under those names.

* **73 files**, `0070`–`0142` → `0071`–`0143`, as one ordered unit, renamed high-to-low so two
  files never briefly share a number.
* `src/db/rollback/` moved in lockstep, so each rollback still names its own migration.
* The dependency analyser ran **before and after**: **0 ordering violations both times**. A shift
  that moved a migration above something it needs would have failed the run.
* Filename-shaped references were rewritten repo-wide (58 files). **Bare prose numbers were not**:
  "migration 0070" now means main's file on one line and the candidate's on another, and guessing
  is how a record becomes wrong.

Verified afterwards:

```
migration-lint       143 migrations, sequential 0001–0143, no gaps or duplicates
migration-collision  no collision against origin/main @ fd41d30a
                     (base high-water 0070, head high-water 0143)
```

The full old→new map is `docs/release-1/candidate-sequence-shift-map.json`.

## Lineage

| | |
|---|---|
| fresh database | `0001`–`0143` |
| production pending, from the proven Case-A ledger (69 rows, high-water `0069`) | `0070`–`0143` = **74** |

`0070` in that pending range is **main's** migration — which brings us to the part that is not
just arithmetic.

## Main's `0070` was already applied to production, without the runner

`fd41d30` records it, and it is easy to misread:

> The repair in `0070_identity_backfill_and_event_lifecycle.sql` was applied to production, but
> **not by the migration runner**, and the `schema_migrations` ledger therefore still shows **0069
> as the last applied version**.

The reason given: `db.gazjughejdzebathpscb.supabase.co` publishes only an AAAA record and the
operator machine had no IPv6 route, so `psql`, `pg_dump` and `npm run migrate` could not reach it.
The row changes were made over the service-role REST API instead.

So the hosted **ledger** is unchanged at 69 rows — the Case A evidence still holds — while the
hosted **data** has already been repaired. The disposition of that is analysed separately, with
read-only predicates and a rehearsal of the exact production shape, in
[MAIN-0070-RECONCILIATION.md](MAIN-0070-RECONCILIATION.md).

It also means there was **no working `pg_dump` path to production from that machine**, which bears
directly on the backup precondition in
[STAGING-AND-PRODUCTION-PLAN.md](STAGING-AND-PRODUCTION-PLAN.md) §4.
