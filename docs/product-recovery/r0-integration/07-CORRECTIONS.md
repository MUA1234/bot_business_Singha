# Corrections to the factual record

Every correction below removes an **unverified production fact** or an **empirically wrong
failure description** from the record. Each names what was said, why it was wrong, and what
the evidence actually supports.

**Standing rule reaffirmed:** hosted migration state is **UNKNOWN** until supported by
actual read-only database results. No document in this repository may assert what is
applied to production without citing those results and their date.

---

## C-1 — "Production has 0069 recorded" was an inference, not a fact

**Where:** the deployment-readiness assessment delivered 2026-09-10 (conversational
report; no committed document carried the claim).

**What was said:**

> "Production has `0069` recorded. So the branch's `0069` would be **silently skipped**…"

and, later in the same report:

> "Hosted migration state is unconfirmed (`MIGRATION_STATE.md` stops at 0068 while deployed
> code needs 0069)."

**Why it is wrong:** the two statements contradict each other. The first asserts hosted
state as established; the second correctly reports it as unknown. The first was an
inference from `main` being the deployed branch and `main` containing 0069 — which is
exactly the reasoning PR-F-014 / R0-F-007 invalidated when it found the active Railway
deployment carries **no Git SHA and no GitHub source**. If the deployed artifact cannot be
tied to a commit, "the deployed branch contains 0069" does not establish that 0069 was
applied to the database. The ledger and the schema are the only evidence, and neither was
read.

**Corrected statement:**

> Whether version `0069` is recorded on the hosted database is **UNKNOWN**. The collision
> is real and provable from the repository; its *consequence* is conditional on a hosted
> precondition that has not been established. If, and only if, version `0069` is already
> recorded, the branch's `0070_durable_inbound_processing.sql` is skipped.

**Settled by:** hosted checklist Q2 and Q4.

---

## C-2 — The failure mode was described wrongly on both counts

**Where:** `docs/product-recovery/README.md` (PR-F-001 row);
`docs/architecture-v2/MIGRATION_STATE.md` (R0 correction banner, item 2); and the
2026-09-10 readiness report, which repeated it.

**What was said:**

> "…and 0070–0109 would then run against a schema missing its objects."
> "This is a silent-corruption path."

**Why it is wrong:** it was never executed. Executing it (Rehearsal A, disposable
PostgreSQL 16.10, ledger seeded with `main` 0001–0069) gives:

```
✅ 0070, 0071, 0072, 0073, 0074, 0075   — six migrations COMMITTED
❌ 0077_inbound_boundary_correction.sql
   column "next_attempt_at" does not exist
```

Verified afterwards by catalogue query: ledger high-water `0075` / 75 rows; branch-0069
columns and functions absent; `main`-0069 objects present.

So:

* **Not** all of 0070–0109 — six of them, then a halt.
* **Not** silent — the skip is silent, the consequence is a loud abort at 0076.
* **Not** corruption — a **partial migration**, which is a different problem with a
  different remedy.

**Why the difference matters.** "Silent corruption" implies a database that looks fine and
is not; the remedy would be detection. What actually occurs is a database stranded between
two lines with the ledger reporting `0075` as though it were coherent, and **the numbered
sequence has no down-migrations**. The remedy is therefore *restore from backup*, which
makes a proven rollback a **precondition** of any apply rather than a follow-up step. The
wrong description would have led to the wrong preparation.

**Corrected in:** `docs/product-recovery/README.md`,
`docs/architecture-v2/MIGRATION_STATE.md`, and stated in full at
[`01-MIGRATION-DEPENDENCY-INVENTORY.md`](01-MIGRATION-DEPENDENCY-INVENTORY.md) §3.

---

## C-3 — "Renumber branch 0069 to 0110" was unsafe and is withdrawn

**Where:** the 2026-09-10 readiness report's remediation suggestion.

**What was said:**

> "The gating item is the `0069` collision — renumber the branch's migration to `0110`…"

**Why it is wrong:** the owner identified the risk before any evidence was gathered, and
the evidence confirms it. The branch's 0069 has **6 direct and 7 transitive dependants**
(`0076`, `0077`, `0079`, `0083`, `0087`, `0088`, `0089`), which reference its columns
(`next_attempt_at`, `lease_owner`, `lease_acquired_at`, `lease_expires_at`,
`last_error_code`, `dead_lettered_at`, `dead_letter_reason`) and its functions
(`claim_source_events`, `complete_source_event`, `fail_source_event`,
`inbound_backoff_seconds`, `source_event_backlog`). Moving 0069 alone to 0110 would place
it **after every one of them**.

**Corrected statement:** a collision is resolved by renumbering the **whole dependent
sequence in order**. Under the Case A hypothesis that is a uniform +1 shift of the branch's
0069–0109 to 0070–0110, with the offset calculated from the **proven** hosted high-water
mark rather than assumed.

**Enforced by:** `checkRenumberPlan` in `scripts/lib/migration-collision.mjs` raises
`RENUMBER_BREAKS_DEPENDENCY_ORDER` for exactly this plan;
`tests/migration-collision.test.ts` locks the refusal in with a synthetic fixture, and
proves the whole-sequence shift is accepted.

---

## C-4 — A stale test count in the audit record

**Where:** `docs/product-recovery/README.md`, PR-F-013 (P2).

**What was said:** "One unit test fails on the required HEAD. 1362 passed / 1 failed /
2 skipped across 184 files."

**Current measurement** on `0c789d36` (2026-09-10): **2425 passed, 4 skipped, 0 failed,
across 226 files.** The CRLF-sensitive source-text assertion no longer fails here.

**Note, not a correction:** PR-F-013 was accurate for the SHA it was measured on
(`abc7767e`). It is recorded here because it is now stale, and because the finding's real
substance — *source-text assertions are not behavioural verification* — remains open
regardless of the count. Counts anywhere in this repository are advisory; run the suite.

---

## C-5 — Scope of what the R0 tooling proves

**Stated plainly to prevent a future over-claim:**

| Proven | By |
|---|---|
| `main` and the branch define different migrations at 0069 | SHA-256 comparison of both blobs |
| 0001–0068 are byte-identical between the two lines | SHA-256 comparison, 68 versions |
| Branch 0070–0109 depend on branch 0069 | object-reference analysis + manual SQL inspection + execution |
| The unshifted apply halts at 0076 leaving a partial migration | execution on disposable PG 16.10 |
| The branch line is self-consistent on a fresh database | execution: 109 applied |
| A uniform +1 shift applies cleanly over a `main`-seeded ledger | execution: 41 applied, high-water 0110 |

| **Not** proven | Why |
|---|---|
| What is applied to the hosted database | no hosted read has been performed |
| That production is in the Case A state | hypothesis only; Q2/Q4 settle it |
| That the +1 offset is the correct final mapping | depends on the proven hosted high-water mark |
| That the deployed artifact corresponds to any commit | PR-F-014 / R0-F-007 unresolved |
| That the merge candidate is correct | it has not been built |

A rehearsal seeded from a hypothesis proves the hypothesis is self-consistent. It does not
prove the hypothesis.

---

## C-6 — "Verified at this SHA" overstated the kernel suites

**Where:** `../AUTONOMOUS-STATE.md`, the "Verified at this SHA" table (R5 checkpoint).

**What was said:**

| Suite | Recorded |
|---|---|
| `r2-evidence-contracts` (live) | **8 passed** — "every item created by the real cycle" |
| `r2-operations-slice` (live) | **3 passed** |
| `r1-security-baseline` | not listed, but the R1 baseline is treated throughout as holding |

**Measured 2026-09-10** at `0c789d36`, via the repository's own canonical harness
`scripts/r1/run-r1-security-tests.mjs` (own container, migrations + all 28 draft units,
its explicit 33-file list):

```
Test Files  5 failed | 28 passed (33)
     Tests  13 failed | 610 passed (623)
```

Re-run in isolation on a fresh container, reproducing in 11.83s:

| Suite | Result |
|---|---|
| `r2-evidence-contracts` | 8 tests, **5 failed** |
| `r2-operations-slice` | 3 tests, **3 failed** |
| `r1-security-baseline` | 38 tests, **3 failed** |
| `r1-runtime-e2e` | 18 tests, **1 failed** |

**Why the correction is needed:** a table headed "Verified at this SHA" asserts a
present-tense fact about the current commit. It is not one. Either the earlier measurement
was taken under a setup the canonical harness does not reproduce, or these suites have
regressed since. The repository cannot distinguish the two, so neither is asserted.

**Not attributable to the R0 work:** commit `b3e1516` changes no file under `src/`.

**Direction of the security failures:** the three `r1-security-baseline` failures are reads
returning 0 rows where 1 was expected — legitimate access **refused**, not data exposed. No
company-isolation assertion failed. This is stated so the finding is not read as a leak.

**Corrected statement:** the kernel suites' status at `0c789d36` is **failing, cause not
established**. The core (non-kernel) integration suites are green — 74 files, 671 tests —
and that is a separate claim which the kernel result does not weaken and which does not
excuse it.
