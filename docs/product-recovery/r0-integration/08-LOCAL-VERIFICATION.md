# Local verification evidence

All measurements at head `0c789d366023eca05a418348cc07923672651428`, working tree clean at
analysis start. **No hosted contact.** All database work ran against **disposable local
containers** created for this purpose and destroyed afterwards.

## Environment

| | |
|---|---|
| Docker | 29.7.2 — **available** |
| Rehearsal container | `postgres:16.10-alpine3.22`, created for this work, bound to `127.0.0.1:55432` |
| PostgreSQL | 16.10 on x86_64-pc-linux-musl |
| Bootstrap | `scripts/apply-sql.mjs tests/integration/helpers/supabase-shim.sql` (the CI bootstrap) |

Local Docker/PostgreSQL **was** available, so the genuine integration suite ran rather than
being reported as `blocked_environment`. Pre-existing containers belonging to other
projects were left untouched; a separate container was created for this work.

---

## Static gates

| Gate | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | **clean** (exit 0) |
| Unit suite | `npx vitest run` | **2443 passed**, 4 skipped, **0 failed** (227 files) |
| Secret scan | `node scripts/secret-scan.mjs` | **clean** — no tracked secrets |
| Migration lint (single-branch) | `node scripts/migration-lint.mjs` | **clean** — 109 migrations, 0001–0109, no gaps |
| Completion inventory | `node scripts/completion-inventory.mjs --check` | **pass** — `supabaseAdmin` confined to the allowlist |
| Requirement audit | `node scripts/autonomy/audit-requirements.mjs --quiet` | **pass** (exit 0) |
| IP boundary | `node scripts/autonomy/check-ip-boundary.mjs --quiet` | **pass** (exit 0) |
| Production build | `npm run build` | **succeeds** — all routes compile |
| **Migration collision (new)** | `node scripts/migration-lint.mjs --base origin/main` | **FAILS — by design.** 2 errors at version 0069 |

The unit count rose from 2425 to 2443 because this work added 18 tests
(`tests/migration-collision.test.ts`); one further test was added afterwards, taking that
file to 19.

Two generated files (`docs/architecture-v3.1/COMPLETION_INVENTORY.md`,
`docs/autonomy/ORIGINAL_VISION_COVERAGE_MATRIX.md`) were rewritten as a side effect of
running their generators. Both diffs were line-number drift and a date stamp, unrelated to
this work, and were **reverted** rather than committed.

---

## The new gate's own evidence

`tests/migration-collision.test.ts` — **19 tests, all passing**, driven by synthetic
main/branch migration sets so they remain valid once the real collision is reconciled.

### Discrimination proven by mutation

Each mutation disabled one detection in `scripts/lib/migration-collision.mjs`; the suite
was run; the file was restored from a pristine copy.

| Mutation | Tests failed |
|---|---|
| content-difference detection disabled | **3** |
| below-high-water detection disabled | **1** |
| renumber dependency-order check disabled | **2** |
| duplicate-version detection disabled | **1** |

All four caught. Restoration verified: `0` mutation remnants in the file, suite green.

### What the gate reports on the real repository

```
✅ migration-lint: 109 migrations, sequential 0001–0109, no gaps or duplicates.

❌ migration-collision: 2 error(s) against origin/main @ acd9fbec:

  [SAME_VERSION_DIFFERENT_CONTENT] version 0069
    base: 0069_company_routing_and_catalogue_department.sql
    head: 0069_durable_inbound_processing.sql

  [RUNNER_SILENT_SKIP] version 0069
    16 object(s) would never be created;
    6 later head migration(s) reference them
    dependants: 0076, 0077, 0083, 0087, 0088, 0089
```

This is the finding the work exists to surface, not a regression.

---

## Database rehearsals

Each on a freshly created database with the Supabase shim applied first.

| # | Scenario | Result |
|---|---|---|
| A | ledger seeded `main` 0001–0069, then apply branch | ❌ `0070`–`0075` committed, then **0076 fails**: `column "next_attempt_at" does not exist`. Ledger left at high-water `0075` |
| B | fresh database, branch 0001–0109 alone | ✅ **109 applied** |
| C | ledger seeded `main` 0001–0069, then apply the **candidate** +1 shift | ✅ **41 applied**, high-water `0110`, 110 rows |

Rehearsal C staged the shift in a temporary directory. **No real migration file was
renumbered.**

Post-state of C, verified by catalogue query — both lineages coexist:

| Object | Present |
|---|---|
| `companies.whatsapp_phone_number_id` (main 0069; legacy backfill source) | ✅ |
| `source_events.next_attempt_at` / `lease_owner` / `dead_lettered_at` (branch 0069) | ✅ |
| `claim_source_events`, `fail_source_event` (branch 0069) | ✅ |
| `channel_accounts`, `resolve_channel_company` (branch 0074; canonical) | ✅ |

Reference shape of the reconciled schema: **147 tables, 107 functions, 42 triggers,
454 policies**; RLS enabled on **143 of 147** tables.

---

## Hosted checklist SQL — validated, not merely written

Every query in [`03-HOSTED-STATE-CHECKLIST.md`](03-HOSTED-STATE-CHECKLIST.md) was executed
against the Rehearsal C database to confirm it parses and returns the intended shape on a
real PostgreSQL 16. Validated: Q1a, Q3, Q3b (gap detection), Q4b (object markers), Q6
(expected-table probe), Q6c (draft-track probe), Q7 (schema size), Q8b (RLS summary),
Q8c (policy listing), Q9 (SECURITY DEFINER `search_path` audit).

They were **never** run against a hosted database.

---

## Integration suite

`npx vitest run -c vitest.integration.config.ts` against a disposable PostgreSQL 16.10,
with **both** migration tracks applied:

1. `scripts/apply-sql.mjs tests/integration/helpers/supabase-shim.sql`
2. `npm run migrate` — 109 migrations
3. `R1_DRAFT_CONFIRM=disposable-local-only node scripts/r1/draft-migrate.mjs --up` — **20
   draft units**

**A first run without step 3 was invalid** and is discarded: the R1 kernel tables
(`management_kernel_enablement` and siblings) live in `src/db/draft-migrations-r1/`, outside
the numbered sequence, so a migrations-only database fails those suites on missing
relations rather than on behaviour. That is a property of the quarantine (owner decision
R1-D-1), not a defect.

The suite is **serial by design** (`fileParallelism: false`, one DB connection at a time)
across **109 integration test files**, and the host carries 15–20 unrelated containers — the
contention already recorded under "Host measurements" in `../AUTONOMOUS-STATE.md`.

**Status at the time this document was committed: still running.** Progress was confirmed
directly (`pg_stat_activity` showing live queries against the R1 kernel RPCs), so it was
executing rather than hung. The result is recorded in the follow-up commit to this file.

**No result may be reported as "integration verified" on the strength of the run having
been started.** Until the completed output is recorded below, integration behaviour at this
SHA is **not** verified by this document.

### Result

_To be filled in from the completed run._
