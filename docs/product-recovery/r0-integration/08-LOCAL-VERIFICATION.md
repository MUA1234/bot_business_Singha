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

### Headline

| Scope | Files | Result |
|---|---|---|
| **Core (non-kernel) suites, clean CI-faithful database** | 74 | ✅ **671 tests passed, 0 failed** (122s) |
| Whole `tests/integration/**` in one run | 111 | ❌ fails either way — see below |

**The core integration behaviour of this branch is green.** That covers accounting posting
and hardening, company isolation, capability RLS, inbound end-to-end, durable inbound
processing, channel/company resolution, outbox and dispatch drain, concurrency and
idempotency, settlement, posting authority, and the four enumeration gates.

### The whole-directory run is not reliably green, and the cause is the harness

| Run | Setup | Result |
|---|---|---|
| 1 | shim + `npm run migrate` (**exactly what CI does**) | **27 files failed**, 84 passed |
| 2 | shim + migrate + `draft-migrate --up` (the canonical harness's own step 4) | **24 files failed**, 87 passed; 146 tests failed |

Neither is green, and **neither failure set reflects product defects**:

* Run 1's failures are dominated by the 35 `r1-*` / `r2-*` **kernel** files, whose tables
  live in `src/db/draft-migrations-r1/` — outside the numbered sequence, quarantined under
  owner decision R1-D-1. A migrations-only database fails them on missing relations.
* Run 2's remaining failure is `secure-definer-grants.test.ts`, which reports
  `r1_draft_create_management_item`, `..._v2` and `r1_draft_record_feedback` as
  **unclassified SECURITY DEFINER signatures** — precisely because the draft functions are
  now present and the allowlist, correctly, does not know about quarantined objects.

**Proof that these are pollution, not defects.** The four enumeration suites that failed in
the whole-directory runs — `rls-coverage`, `rls-matrix-coverage`, `search-path-safety`,
`secure-definer-grants` — were re-run alone on a clean CI-faithful database:

```
✅ 4 files passed, 24 tests passed (3.87s)
```

**Direct evidence of the mutation, and that its teardown is incomplete.**
`tests/integration/r1-draft-schema.test.ts` applies the draft track and tears it down again
(`--up` at its start, `--down` at its end) against the *shared* database. The residue is
observable and differs between runs:

| Moment | `r1_draft_migrations` rows |
|---|---|
| after run 1 (which never applied drafts deliberately) | **8** — left behind by that test's own teardown |
| `draft-migrate --up` before run 2 | applied the remaining **20** → 28 of 28 |
| after run 2 | **15** |

There are 28 draft units. So run 2 *did* start with a complete draft schema — its failures
are not an incomplete setup — and both runs ended with the shared database in a state
neither the suite nor the next run expects. With `fileParallelism: false`, whichever suites
run while the drafts are up, or after they are partially torn down, see a schema the rest of
the run does not. Which tests fail is therefore an artefact of file ordering.

### Consequence: CI's integration job cannot be green as configured

`.github/workflows/ci.yml` runs `npm run test:integration`, which includes
`tests/integration/**` — all 111 files — after shim + migrate only. That sweeps in 35
kernel files whose schema is deliberately absent. **This is a finding about the test
configuration, and it is not caused by anything in this R0 work.**

The kernel suites have their own harness — `scripts/r1/run-r1-security-tests.mjs` — which
builds a purpose-made container, applies migrations **and** drafts, and runs an explicit
file list rather than the directory. That, not `test:integration`, is their canonical
entry point (`../AUTONOMOUS-STATE.md` records it as "the canonical command").

**Recommended for the merge candidate** (not performed here — it is a change to the test
configuration, outside R0's read-only scope):

* split the vitest integration config into `core` and `kernel` projects, so the kernel
  files never run against a database that lacks their schema;
* have `r1-draft-schema.test.ts` use its own database rather than mutating the shared one;
* teach the SECURITY DEFINER allowlist to recognise `r1_draft_*` as quarantined, or assert
  their absence, so the gate is meaningful under both setups;
* point CI's integration job at the core project and add the kernel harness as its own job.

### Kernel suites — FAILING at this SHA

Run through their canonical harness (`scripts/r1/run-r1-security-tests.mjs`), which
provisions its own labelled, loopback-only container, applies migrations **and** all 28
draft units, audits loader columns, then runs its explicit 33-file list.

```
══ campaign mtva8ibk-odlxk3 — FAILED in 899s
   Test Files  5 failed | 28 passed (33)
        Tests  13 failed | 610 passed (623)
```

**These are reproducible, not host contention and not ordering.** Re-running the four
deterministic files alone, on a fresh purpose-built container, reproduces every failure in
**11.83 seconds**:

| Suite | Result in isolation |
|---|---|
| `r1-security-baseline.test.ts` | 38 tests, **3 failed** |
| `r2-operations-slice.test.ts` | 3 tests, **3 failed** |
| `r1-runtime-e2e.test.ts` | 18 tests, **1 failed** |
| `r2-evidence-contracts.test.ts` | 8 tests, **5 failed** |

The fifth file from the full campaign, `r2s-p-fence-and-reset.test.ts` (1 failure —
*"no source is left permanently partial once the arrivals stop"*, a 900 s convergence
assertion), was **not** re-run in isolation and is the one failure that could plausibly be
contention. It is not claimed either way.

**Not caused by this R0 work.** Commit `b3e1516` touches no file under `src/` — only
`scripts/lib/*`, `scripts/migration-inventory.mjs`, `scripts/migration-lint.mjs`,
`tests/migration-collision.test.ts`, `package.json` and documentation.

**Nature of the `r1-security-baseline` failures.** All three are reads returning **0 rows
where 1 was expected** — e.g. *"actor … could not read"* for an owner reading their own
company's `management_items`. That is a **fail-closed** direction: legitimate access
refused, not cross-company data exposed. No test asserting isolation failed. The
roles/permissions seed is present (migrations seed 9 roles including `owner_management`),
so the cause lies elsewhere and is not diagnosed here.

**This contradicts the "Verified at this SHA" table in `../AUTONOMOUS-STATE.md`**, which
recorded `r2-evidence-contracts` as 8 passed and `r2-operations-slice` as 3 passed. Both
now fail completely (5 of 8, and 3 of 3). Exactly one of these is true: the earlier
measurement was taken under a setup the canonical harness does not reproduce, or the
suites have regressed since. **The repository cannot tell which**, and this document does
not guess. Corrected in that file; see also `07-CORRECTIONS.md` C-6.

**Diagnosing these is R1/R2 work, not R0.** R0's task is to establish what is true. What is
true is: the kernel suites do not pass at `0c789d36` under their own canonical harness.

Host conditions during this work: 15–20 unrelated containers, matching the contention
already recorded under "Host measurements" in `../AUTONOMOUS-STATE.md`. The whole-directory
run took **3232s**, of which the kernel files accounted for the large majority; the 74 core
files take **122s**.
