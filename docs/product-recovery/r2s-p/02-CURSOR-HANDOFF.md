# R2S-P cursor handoff — discovery that does not depend on the overlap

**Local-only.** No hosted contact, no deploy, no merge, no production migration number, no live
AI, no real data.

## The hole this closes

R2S-P left an incremental keyset cursor that moves forward through `updated_at` and never goes
back. Two mechanisms narrowed the resulting gap — a 60-second overlap re-read and a 50-row
re-scan — and both are **fixed guesses about commit latency that this repository has never
measured**.

A guess is not a guarantee. Any of these puts a row permanently behind the cursor:

| Situation | Why the incremental cursor cannot see it |
|---|---|
| a commit that lands later than the overlap | its `updated_at` is already below the bound |
| an import or backfill carrying original timestamps | written years behind the cursor |
| a writer whose clock is behind | stamped before the bound, however recently it committed |
| an edit stamped with a historical time by an ETL | the cursor is already past that point |

The `sweep_by_id` sources never had this problem: they page the whole table by primary key and
**start again when they finish**, so an old row is re-read within one sweep period. The four
`keyset_updated` sources — operations, CRM, governance, providers — had no such pass.

## What was added

Every `keyset_updated` source now also runs a **periodic reconciliation sweep**: a second,
independent cursor over the same table, ordered by primary key, which restarts when it completes.

```
incremental   →  ORDER BY (updated_at, id)   forward only, catches changes quickly
reconciliation →  ORDER BY id                restarts forever, catches everything eventually
```

Discovery is then bounded by **table size ÷ `RECONCILE_PAGE`, in cycles** — a function of row
count and page size only. No timestamp appears in that bound, which is the point: correctness no
longer rests on any assumption about clocks or commit latency.

The two positions are stored separately, under `source` and `` `${source}#reconcile` ``, in the
same `observation_source_cursors` table — so the reconciliation cursor inherits the payload
allowlist, the completion-shape constraint and the service-only write boundary without a new
migration.

## The guarantees it keeps while doing this

| Requirement | How |
|---|---|
| **invoked through the runtime** | `runManagementCycle` reads it every cycle; the summary reports `reconciliation` per source, and the position is durably written under its own key |
| **bounded across cycles** | one page is at most `RECONCILE_PAGE` rows, and the reserve is carved out of `CYCLE_ROW_BUDGET` rather than added to it, so the cycle total is unchanged |
| **no starvation between domains** | every keyset source has its OWN reservation every cycle — see below; rotation still governs the incremental sweep |
| **never resolves from an incomplete sweep** | a source whose full sweep is still running sets `allSweepsComplete = false`, so `resolutionPermitted` is withheld and the cycle is `partial` with the reason *"reconciliation sweep in progress"* |
| **honest status** | a running reconciliation keeps `hasMore` true; the cycle never reports `completed` while a domain is still being reconciled |

A cursor commit failure is treated exactly as the incremental one is: the position does not move,
the source is named in `cursorCommitFailed`, and resolution stays withheld.

## Reconciliation is reserved, not leftover

The sweep first drew on the same `RowBudget` as the incremental read, taking whatever was left
after new rows had been served. That made the discovery guarantee conditional on incremental
traffic being light — which is to say, conditional on the company being quiet. **A busy company
is precisely the one whose records must not go unobserved**, so a guarantee that lapses under
load is not a guarantee.

Reconciliation now has a reserve that incremental reads cannot draw on:

```
reserve            = RECONCILE_PAGE × (number of keyset sources)   = 100 × 4 = 400
incremental budget = CYCLE_ROW_BUDGET − reserve                    = 2000 − 400 = 1600
```

The reserve is carved OUT of the existing total, not added to it, so the cycle remains bounded
by `CYCLE_ROW_BUDGET`. It is sized so that **every** keyset source can take a full page in
**every** cycle — there is no rotation to wait for and no leftover to hope for.

### The generation fence — what makes N a number at all

A sweep with no upper boundary never finishes while rows keep arriving. Each page advances the
position, new rows land ahead of it, and the generation is extended for as long as the company
keeps working — so `⌈N ÷ page⌉` describes nothing, because N is not fixed.

**This was not theoretical.** The fairness suite seeded 450 rows and inserted 150 more on every
cycle. Ten cycles later the generation had still not completed, and `generation` was still 0.

Each generation now captures a **fence** — the instant it began — and every page of that
generation reads only `created_at <= fence`. Rows created afterwards are the NEXT generation's
work. The fence travels in the cursor, so all pages of one generation share one boundary, and
draft unit **019** requires it to parse as a timestamp at the database so it cannot become a
free-text field wearing a position's name.

### The bound, stated precisely

> A source's reconciliation sweep advances by **`RECONCILE_PAGE` rows per cycle, guaranteed** by
> the reserve. A generation therefore completes in
>
> **⌈N_fenced ÷ RECONCILE_PAGE⌉ + 1 cycles**
>
> where **N_fenced is the number of rows inside the generation's captured boundary** — the rows
> that existed when the generation began — and **not** the table's eventual size. The extra
> cycle is the short page that records the wrap.

Rows arriving after the fence are excluded from that N by construction. They are not lost: they
are the next generation's N, and the incremental keyset path usually observes them long before
then. **A generation is bounded; discovery is eventual; the two are different claims.**

The bound depends on the fenced row count and the reserve. It does not depend on incremental
load, on rotation order, on how many other sources are busy, or on any cursor timestamp.
`reconcileReserve` is reported on every cycle summary so the allocation behind it can be
inspected rather than assumed.

**The one case that still extends a generation** is a backfill inserting rows with *backdated*
`created_at` while a generation is running: those fall inside the fence and add to its N. That
is bounded by the size of the backfill, which is a one-off event, rather than by ongoing write
traffic — but it is a real caveat and the bound should be read with it in mind.

Per company: the budget is per cycle **per company**, so one busy tenant cannot spend another's
reserve. A failing source forfeits only its own reservation — its cursor does not advance on a
failed page — and the other three continue.

## A stored position that cannot be USED — and how narrow that is

A cursor whose SHAPE is unreadable is refused when read, and the sweep restarts. The other half
is a cursor that parses but the query rejects — written by a different schema version, or
corrupted, carrying a value the column will not accept. Left alone that wedges the source
permanently: it can never read again, so its domain can never be observed.

**Restarting a sweep is a real action.** It re-reads a table and discards a recorded position.
It is the right answer to a position this schema cannot use, and the wrong answer to almost
everything else — a reset that swallowed a permission denial or a timeout would convert an
outage into a quiet retry loop, which is precisely the silent-partial failure this phase
exists to prevent. So the trigger is deliberately tiny.

**Explicit validation first, before any query.** Every paged id is a uuid and every keyset
bound is a timestamp, so `cursorIsUsable` decides most cases without provoking an error at all.

**Then SQLSTATE, never message matching.** Only these four mean "that value is not one this
column can take":

| Code | Meaning |
|---|---|
| `22P02` | invalid_text_representation — e.g. a non-uuid where a uuid is required |
| `22007` | invalid_datetime_format |
| `22008` | datetime_field_overflow |
| `22003` | numeric_value_out_of_range |

Everything else propagates untouched and the source stays visibly **failed** — permission and
RLS denial (`42501`), missing table (`42P01`) or column (`42703`), timeout (`57014`),
resource exhaustion (`53*`), unavailable database (`08*`), serialization failure (`40001`).
A message match would eventually catch a sentence that merely mentions a uuid; a code cannot.

### Reset safety

| Rule | How |
|---|---|
| the incomplete generation is invalidated | a reset generation does not increment `generation` and does not stamp `sweep_complete_at` — it restarted somewhere unknown, so it did not sweep the table |
| resolution is prohibited from it | `allSweepsComplete` is cleared for the cycle, so `resolutionPermitted` is withheld |
| at most one retry | the restart is a single read from the beginning; if that fails the error is real and propagates |
| deduplication is retained | re-read rows go through the same identity-key path and create no second item |
| a non-sensitive reason is recorded | the cycle reports `cursorReset` and the reason *"stored position unusable; sweep restarted"*, naming the SOURCE |
| the raw cursor is never logged | the position value is not echoed into the status, the reason or `last_error` — a cursor is small, but it is not a thing to print on the way past |
| company and source isolation | a reset touches one `(company_id, source)` row, and every read stays company-scoped, so a foreign position can never read another company's rows |
| concurrent resets are deterministic | the company-scoped cycle lock serialises them: one runs, the other returns `skipped_locked` |

## Tuning — and why the defaults are not evidence

| Constant | Default | Environment variable | Clamp |
|---|---|---|---|
| overlap window | 60 000 ms | `KERNEL_OVERLAP_MS` | 0 … 3 600 000 |
| overlap re-scan | 50 rows | *(derived, ≤ `RECONCILE_PAGE`)* | 1 … 50 |
| reconciliation page | 100 rows | `KERNEL_RECONCILE_PAGE` | 1 … 10 000 |

They are configurable so a measurement can change them without a code change, and clamped so a
typo cannot silently disable a bound (a bad value falls back to the default rather than to zero).

**These defaults are not tuned. They are starting points.** The right overlap depends on how long
a writing transaction stays open under real load; the right reconciliation page depends on real
table sizes and the cycle's time budget. Neither has been measured, because no hosted database has
been touched. **Production values require staging measurements** — specifically the 99th-percentile
open-transaction duration for each keyset table, and the observed cycle duration at real row
counts.

Setting them from guesswork would be the same mistake in a new place. The reconciliation sweep is
what makes that acceptable: if the overlap is set badly, discovery is slower, not incomplete.

## Evidence

Scenarios against a disposable PostgreSQL 16, in `tests/integration/r2s-p-cursor-handoff.test.ts`
and `r2s-p-tail-liveness.test.ts`. Each places a row where the incremental cursor cannot look
and asserts it is observed anyway.

### Tail liveness — the forward lane crosses the whole table

The claim is that forward coverage, resuming rather than restarting across abandonments,
reaches the LAST row. Measured on the forward lane itself, with the recovery lane returning
nothing so it cannot satisfy the assertion:

```
c1: fwd start->2afa85d9  rows=100  abandon=false
c2: fwd 2afa85d9->50850a0c rows=100  abandon=true
c3: fwd 50850a0c->6d9cea6f rows=100  abandon=false
c4: fwd 6d9cea6f->8aa7f76d rows=100  abandon=true
c5: fwd 8aa7f76d->a61a2728 rows=100  abandon=false
c6: fwd a61a2728->c3ff106c rows=100  abandon=true
c7: fwd c3ff106c->da5a6a91 rows=100  abandon=false
c8: fwd da5a6a91->f03be88b rows=100  abandon=true
c9: fwd f03be88b->start    rows=70   abandon=false   ← sentinel carried here
```

**Cycle 9 of the measured phase, after 4 abandonments.**

The lower bound, stated exactly: the sentinel is row **601**, and cycle *k* carries rows
*(k−1)·100+1 … k·100*, so cycles 1–6 carry rows 1–600 and the sentinel can **first appear on
cycle 7** — not 6. (`ceil(600/100)` = 6 is off by exactly the sentinel itself; a bound that
admits an impossible pass is not a bound.) The observed cycle 9 is consistent with that and
with the 60 rows arriving each cycle: 870 rows crossed at 100 a cycle. The position advances
monotonically and wraps only on reaching the end.

**Mutation check.** Restoring "abandonment restarts at page one" makes the forward lane
oscillate over the first two pages and never arrive:

```
c1: start->2705246a   c2: 2705246a->start   c3: start->1d7ba2ad   c4: 1d7ba2ad->start …
```

> **An earlier version of this evidence was wrong, and the correction matters more than the**
> **result.** The first sentinel test asserted only "the sentinel was observed" and passed on
> cycle 4 — arithmetically impossible for a lane advancing 100 rows a cycle behind 600 rows.
> The INCREMENTAL lane had found it: the fixture backdated `created_at` but left `updated_at`
> at now(), placing the sentinel among the newest rows in the keyset ordering. A second version
> warmed up with ordinary cycles, which carried the forward lane to the end of the table as
> well, and it then arrived in a single step. Neither version tested forward coverage.
>
> Reconciliation reads now carry an explicit `lane` marker, because two lanes reading the same
> table through the same function are otherwise indistinguishable to a test — and a claim about
> one of them cannot rest on evidence that any of them could have produced.

## Limits that remain

- **The discovery delay is bounded in CYCLES, not in time.** How long a cycle takes, and how often
  it runs, are deployment questions this repository has not settled.
- **Measured only at test scale.** The largest reconciled table here is hundreds of rows, not
  hundreds of thousands. The bound is arithmetic and should hold, but it has not been observed at
  production volume, and index behaviour at that volume is unknown.
- **`latest_per_key` (workforce) is not reconciled** because it returns every subject's newest
  sample on every pass; there is nothing for a second sweep to find. If that source ever becomes
  paged over a subset, it will need one.
- The reconciliation sweep finds rows; it does not decide anything about them. Everything it
  discovers goes through the same detector, ingest and authority path as any other row.
