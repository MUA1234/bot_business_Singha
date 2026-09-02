# R2S-P checkpoint 1 — source classification and cursor architecture

**Local-only.** No hosted contact, no deploy, no merge, no production migration number, no live AI.

## Two independent questions

The owner's five source types answer **two** different questions, and conflating them is how
R2S-F-006 happened. Each loader is classified on both axes.

| Axis | Question | Decides |
|---|---|---|
| **Cursor** | how do I page through this table without missing or repeating rows? | pagination strategy |
| **Freshness** | does my information about this row go out of date merely by sitting still? | whether `stale_source` may suppress |

A legal record is *mutable without an update timestamp* (a sweep cursor) **and** a *stored date
condition that does not decay* (freshness unknown, never suppressed). Both are true at once.

## Classification

| Domain | Table(s) | `updated_at`? | Cursor type | Freshness type |
|---|---|---|---|---|
| **operations** | `tasks` | ✅ | **2** — keyset on `(updated_at, id)` | **5** — overdue/blocked are stored conditions, do not decay (corrected, R2S-P-F-004) |
| **governance** | `management_directives` | ✅ | **2** — keyset on `(updated_at, id)` | **5** — an unacknowledged directive is a stored condition (corrected, R2S-P-F-004) |
| **providers** | `service_providers` | ✅ | **2** — keyset on `(updated_at, id)` | **5** — stored status, does not decay |
| **crm** | `wa_conversations` | ✅ | **2** — keyset on `(updated_at, id)` | **5** — "waiting for a reply" is derived from stored timestamps (corrected, R2S-P-F-004) |
| **crm** (outbound) | `wa_messages` | append-only | **1** — append with monotonic `created_at` | event evidence |
| **finance** | `customer_invoices` | ❌ | **3** — bounded continuing sweep on `id` | **5** — overdue is a stored date condition |
| **objectives** | `objectives` | ❌ | **3** — sweep on `id` | **5** |
| **marketing** | `campaigns` | ❌ | **3** — sweep on `id` | **5** |
| **procurement** | `inventory_items` | ❌ | **3** — sweep on `id` | **5** |
| **assets** | `vehicle_documents` | ❌ | **3** — sweep on `id` | **5** |
| **legal** | `licences`, `contracts`, `obligations` | ❌ | **3** — sweep on `id`, per table | **5** |
| **legal** | `insurances` | ✅ | **3** (kept with its siblings — one detector, one cursor) | **5** |
| **workforce** | `capacity_snapshots` | ❌ | **4** — `DISTINCT ON (membership_id)`, keyset over membership | **4** — a SAMPLE, staleness genuinely applies |
| **system** | probe | n/a | none — a bounded aggregate, not a row list | **4** — a sample |

## Cursor strategies

### Type 2 — keyset on `(updated_at, id)`, with an overlap

A **compound** cursor, because `updated_at` is not unique: one bulk insert gives hundreds of
rows a single timestamp, and a bare timestamp boundary is then either ambiguous or unable to
move.

The row-value comparison `(updated_at, id) > ($at, $id)` cannot be expressed as one filter
through this client, so it is composed from the two ordinary filters that are equivalent to it:

```
-- 1. the REST of the current timestamp group
where company_id = $1 and updated_at = $cursorUpdatedAt and id > $cursorId
order by id limit $pageSize

-- 2. then everything strictly after that timestamp
where company_id = $1 and updated_at > $cursorUpdatedAt
order by updated_at, id limit $remaining
```

Progress is guaranteed: each page either drains part of a tie group by `id` or steps past the
timestamp entirely, so a tie group larger than a page cannot stall the sweep.

**Overlap.** A writer whose transaction commits after a later-timestamped one has already been
read would otherwise fall permanently behind the cursor — the classic late-writer loss. So the
preceding `OVERLAP_MS` (60 s) is re-read, as a **separate bounded query that never moves the
cursor**:

```
where company_id = $1
  and updated_at >= $cursorUpdatedAt - 60s and updated_at < $cursorUpdatedAt
order by updated_at, id limit 50
```

Duplicates are absorbed by identity-key deduplication in `ingest`, which is what that mechanism
is for.

> **Corrected during checkpoint 6 (R2S-P-F-001).** This originally rewound the CURSOR itself by
> the overlap before reading. Whenever more than one page of rows shared the overlap window —
> any bulk write — every page then re-read the same first rows and the sweep never advanced.
> 499 seeded tasks yielded 200 observed, unchanged across 30 cycles, while the cycle went on
> reporting `hasMore`. A look-back must never be the progress bound.

**Precision.** The boundary is carried EXACTLY as the database returned it. PostgreSQL stores
microseconds; rounding the cursor to millisecond precision makes `updated_at = $cursor` match
nothing, and the tie group is never drained (R2S-P-F-002).

### Type 3 — bounded continuing sweep on `id`

There is no mutation signal, so **`created_at` must never be used as a mutation cursor** — a row
edited today keeps its creation date and would never be re-read. Instead the sweep pages through
the whole table by primary key and **starts again from the beginning when it completes**, so a
modification to an old record is observed within one sweep period rather than never.

```
where company_id = $1 and id > $cursorId
order by id
limit $pageSize
```

`id` is a uuid, so the order is arbitrary but **stable** — which is what pagination needs. It is
not a priority order, which is why the priority pre-pass below exists.

### Type 4 — latest sample per subject

```
select distinct on (membership_id) …
 where company_id = $1 and membership_id > $cursorMembershipId
 order by membership_id, week_start desc
 limit $pageSize
```

One row per person, always the newest week, paged by membership. Obsolete weeks are never
returned, and genuine staleness semantics are preserved for the sample that is.

## The priority pre-pass

A keyset sweep by uuid is stable but arbitrary, so a licence that expired two years ago could sit
behind thousands of newer rows for several cycles. The owner's requirement is that urgent
conditions surface promptly **while** pagination stays stable, and those two pull in opposite
directions.

They are separated rather than compromised:

- a small **bounded pre-pass** (`PRIORITY_PAGE`, 50 rows) reads the *most overdue* rows first —
  `order by <condition date> asc` — every cycle;
- the pre-pass **never advances the cursor**, so it cannot disturb the sweep;
- the stable sweep then continues exactly where it left off.

Duplicates between the two are absorbed by identity-key deduplication. The cost is one extra
bounded query per date-condition source per cycle.

## Budgets and fairness

| Budget | Value | Why |
|---|---|---|
| `PAGE_SIZE` | 200 | per source, per cycle |
| `PRIORITY_PAGE` | 50 | the pre-pass |
| `CYCLE_ROW_BUDGET` | 2000 | across all sources |

Sources are served in a **rotating order seeded by the sweep generation**, so a source that
always sorts last cannot be permanently starved when the cycle budget runs out. A source that
grows rapidly consumes its own page and no more.

## Reconciliation generations

Cursor state carries a `generation`. It increments when a type-3 sweep **completes** — that is,
when a page comes back short of the page size and the cursor wraps to the beginning.

**`sweep_complete_at` is only set when a generation finishes without a single page failure.**

> **What this does NOT do, stated plainly.** Nothing in the kernel resolves a management item
> because a condition stopped appearing. There is no resolve-on-absence logic anywhere today, so
> a partial sweep cannot cause a false resolution — the failure mode is currently unreachable
> because the capability does not exist.
>
> The generation machinery is built now so that when resolution *is* implemented it has a safe
> foundation: `resolutionPermitted` is exposed on every cycle result and is true only after a
> complete, failure-free sweep. Claiming to have "prevented false resolutions" would be claiming
> to have fixed something that was never possible.

## Cursor storage

`observation_sources` (draft unit 005) is a **registry**: configuration and last-scan state, keyed
on a nullable company so one row can be the default for every tenant. Cursor position is
per-company runtime state with a mandatory company, a different key and a different lifecycle;
putting it there would mix configuration with position and make the shared default row meaningless.

Draft unit **018** adds `observation_source_cursors`. It stores **only** company, source, cursor
value, generation, bounded counts, timestamps and status. A CHECK constraint refuses a cursor
payload containing anything but the permitted keys, so a future caller cannot quietly park a
message body or an amount in it.

## Atomicity

A cursor advances only after its page has been loaded, normalised, detected, ingested, its
evidence and management items persisted, and the page committed. On failure the cursor is left
where it was and the page is retried — idempotently, because item creation is keyed on the
identity key and returns the original item for a repeat.

## Explicitly out of scope

Ask-AI, task points/bidding, executing recommendations, R2D.
