# `origin/main` moved, and version `0070` now collides

**Discovered 2026-09-11 by `npm run migration-collision-check`, which FAILS at the candidate's
current head.** This is a blocking finding and it is not resolved. Nothing here has been applied
anywhere.

## What changed

`origin/main` moved from `acd9fbec` — the base every previous report cited — to `fd41d30`:

| SHA | Subject |
|---|---|
| `a4e433e` | fix: membership identity, event lifecycle, admin-department lockout, price routing (0070) |
| `abc8c05` | ops: REST-path applier for the 0070 data repair (no IPv6 route to the hosted DB) |
| `fd41d30` | docs: record the 2026-09-11 production application of the 0070 repair |

28 files, ~1,264 insertions: identity provisioning, departments, quotations, landing path, routing,
and a new migration.

## The collision

Two different files now claim version `0070`:

| Branch | File | Nature |
|---|---|---|
| `origin/main` | `0070_identity_backfill_and_event_lifecycle.sql` | **Data repair only** — no schema change, no new object, idempotent, forward-only |
| candidate | `0070_durable_inbound_processing.sql` | **Creates 16 objects**, and `0077`, `0078`, `0084`, `0088`, `0089`, `0090` reference them |

The checker's own words:

```
[SAME_VERSION_DIFFERENT_CONTENT] version 0070
[RUNNER_SILENT_SKIP]  version 0070
  if base version 0070 is already recorded in schema_migrations, migrate.mjs would SKIP head's
  0070_durable_inbound_processing.sql without error; 16 object(s) would never be created and
  6 later head migration(s) reference them
```

`migrate.mjs` keys `schema_migrations` on the four-digit prefix and skips a recorded version
**silently**. So whichever `0070` is recorded first, the other never runs and nothing says so.
This is the same defect class as PR-F-001, which is why the checker exists.

## What production actually looks like now

`fd41d30` records something that changes the production picture materially, and it is worth
quoting because it is easy to misread:

> The repair in `0070_identity_backfill_and_event_lifecycle.sql` was applied to production, but
> **not by the migration runner**, and the `schema_migrations` ledger therefore still shows **0069
> as the last applied version**.

The reason given is that `db.gazjughejdzebathpscb.supabase.co` publishes only an AAAA record and
the operator machine had no IPv6 route, so `psql`, `pg_dump` and `npm run migrate` could not reach
it; the row changes were made over the service-role REST API instead.

So:

* the hosted **ledger** is unchanged at 69 rows, high-water `0069` — the Case A evidence this
  candidate rests on is still accurate;
* the hosted **data** has been repaired, and main's `0070` is idempotent, so running it later
  changes nothing and only then writes its ledger row;
* production has **one pending migration by main's reckoning** (`0070`) and **73 by the
  candidate's** (`0070`–`0142`), and those two `0070`s are different files.

It also means production currently has no `pg_dump`-based backup path from that operator machine,
which bears directly on the backup precondition in
[STAGING-AND-PRODUCTION-PLAN.md](STAGING-AND-PRODUCTION-PLAN.md) §4.

## Why this was not fixed in this pass

Three reasons, and the third is the one that matters.

1. **The fix is a whole-sequence renumber, not a rename.** The repository's own decision tree says
   so, and the owner refused a single-file rename of `0069` for exactly this reason in an earlier
   pass: renaming one file can reverse dependency order. Resolving this means shifting the
   candidate's `0070`–`0142` to `0071`–`0143` — 73 files — and leaving `0070` to main's repair.
2. **It requires integrating a moved `main` first.** 28 files of product change (identity
   provisioning, departments, quotations, routing) would come with it. That changes what the
   candidate *is*, and it is not a migration-numbering decision.
3. **Doing both unverified would be worse than reporting them.** Every number in this session's
   campaign was measured against the candidate's chain as it stands. A renumber plus a merge
   invalidates all of it, and a re-run is hours. Landing that unverified at the end of a session,
   unauthorised, is precisely the kind of change this project keeps having to undo.

**The collision check is left FAILING on purpose.** It is the gate that says the candidate cannot
be deployed, and it is telling the truth.

## The resolution, ready to execute on approval

1. Merge `origin/main` (`fd41d30`) into the candidate. Expect conflicts only where both branches
   touched identity/department/routing code; the migration directories do not conflict textually
   because the filenames differ.
2. Renumber the candidate's own chain `0070` → `0071` … `0142` → `0143`, as ONE ordered shift, with
   `scripts/migration-renumber.mjs` and its `checkRenumberPlan` guard — never file by file. The
   tool already excludes `docs/product-recovery/` so historical evidence is not rewritten.
3. Leave `0070` to main's `0070_identity_backfill_and_event_lifecycle.sql`.
4. Re-run `npm run migration-collision-check` against `fd41d30` and require zero errors.
5. Re-run the ten-scenario rehearsal (`scripts/hosted/promoted-chain-rehearsal.mjs`) — the hosted
   Case-A scenario in particular, because the pending count becomes **74** (`0070`–`0143`).
6. Re-run the full campaign at the resulting SHA.

Expected lineage afterwards:

| | |
|---|---|
| fresh | `0001`–`0143` |
| production pending from the proven Case-A ledger | `0070`–`0143` = **74** |
