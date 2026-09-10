# R2S-P — bounded pagination, cursors and complete reconciliation — report

**Local-only.** No hosted contact, no deploy, no merge, no production migration number, no live
AI, no message sent, no financial effect, no real data.

## SHAs

| | |
|---|---|
| Phase start (accepted R2S) | `c074548` |
| Checkpoint 1 — source classification | `10f8fe4` |
| Paging implementation | `13b8701` |
| Lint form correction | `5ecfcda` |
| Test totals | unit 2100 passed · live campaign 268 passed across 11 files |

## What this campaign set out to prove

> Every authorised record must eventually be observable, while each cycle remains bounded and
> honest.

The 500-row cap is gone. What replaces it is not "pagination code exists" but a demonstrated
answer to a narrower question: **can a record hide from the sweep?** That question is what the
test matrix is built around, and it is what found the defects below.

## Five defects, all reproduced on live PostgreSQL before being fixed

Four are in product code. One was in my own test. None was found by reading the code — each was
found by making a dataset large enough, or old enough, for the defect to matter.

| Id | Defect | Consequence |
|---|---|---|
| **R2S-P-F-001** | the compound `(updated_at, id)` cursor was documented but never implemented, and the cycle rewound the bound by the overlap on every page | everything past the first page **permanently invisible** after any bulk write |
| **R2S-P-F-002** | the cursor was truncated to milliseconds; PostgreSQL stores microseconds | the tie group was never drained; the sweep crawled |
| **R2S-P-F-003** | a failed cursor commit was pushed onto `truncatedSources`, which step 13 then overwrote wholesale | a lost sweep position was recorded **nowhere** and the cycle reported `completed` |
| **R2S-P-F-004** | `freshnessFor(row.updated_at)` was applied to conditions derived from **stored** fields | the longest-neglected work in seven domains was silently discarded |
| **R2S-P-F-005** | *(mine)* the size assertion compared item COUNT to subject count | would have forced the product to stop reporting a real second condition |

### R2S-P-F-001 — the sweep could not advance through a tie group

`updated_at` is not unique. One bulk insert gives hundreds of rows a single timestamp. The design
called for a compound `(updated_at, id)` cursor for exactly that reason, and the classification
document described one — but `applyCursor` applied only the timestamp half, **inclusively**, and
`cycle.ts` then rewound that bound by `OVERLAP_MS` before every read.

The two combined so that each page re-read from before the whole batch:

```
cycle 0: inspected=200 subjects=200 hasMore=true cursor={updatedAt:"…22.103Z", id:"281018be…"}
cycle 1: inspected=200 subjects=200 hasMore=true cursor={updatedAt:"…22.103Z", id:"281018be…"}
…
cycle 5: inspected=200 subjects=200 hasMore=true cursor={updatedAt:"…22.103Z", id:"281018be…"}
```

**499 seeded tasks, 200 ever observed, unchanged across 30 cycles** — while the cycle went on
reporting `hasMore: true` for ever. This is precisely the failure the phase exists to prevent: not
a crash, but a company whose 201st task onward is invisible to management, permanently, with the
runtime insisting it has more to read.

The row-value comparison cannot be expressed as a single filter through this client, so it is now
composed from the two ordinary filters equivalent to it — drain the rest of the tie group by `id`,
then step past the timestamp. Progress is guaranteed: each page either advances within a tie group
or leaves it. The late-writer overlap moved into the loader as a **separate bounded query that
never moves the cursor**. A look-back must never be the progress bound.

### R2S-P-F-002 — a millisecond cursor against microsecond data

With F-001 fixed, 499 rows still yielded only 212. `nextCursorFrom` preserved a string timestamp
verbatim but converted a `Date` through `toISOString()`, truncating PostgreSQL's microseconds:
`updated_at = '…22.103Z'` then matched nothing, so the tie-drain returned zero rows every time and
the sweep advanced only when it happened to cross a whole timestamp.

**The root cause is that the test double was less faithful than production, in the direction that
hides defects.** `supabase-js` returns timestamps as strings with all six digits; `node-pg` parses
them into millisecond `Date` objects. This is the same class as R2S-F-005, so the fix was to make
the double faithful rather than to accommodate it: the shim now returns date/time columns as
strings, as PostgREST does.

Two further infidelities surfaced in the same file and are fixed:

- the shim had **no `.gt` or `.lt` at all** — the `sweep_by_id` path would have thrown
  `query.gt is not a function` the first time a sweep cursor became non-null, which only happens
  on a dataset larger than one page;
- `.order()` **overwrote** instead of appending, silently collapsing a compound
  `(updated_at, id)` ordering to a single column — the exact ambiguity a compound cursor exists to
  remove.

### R2S-P-F-003 — a lost position was recorded nowhere

Items are persisted before the cursor is written, so a failed commit is safe for the data: the
page is re-read and deduplicated. It is **not** safe for the runtime's honesty. The failure was
recorded by pushing the source onto `summary.truncatedSources` — which step 13 then reassigned
wholesale from `deps.truncatedSources()`. The push was discarded. A cycle that had lost its sweep
position reported `completed`, and if the cursor store stayed unavailable the sweep would never
advance while every cycle claimed a clean run.

There is now a dedicated `cursorCommitFailed`, the cycle is `partial` with the reason *"position
not committed (items are safe; the page will be re-read)"*, and — because a generation whose
completion was never recorded has not verifiably finished — it also withholds
`resolutionPermitted`.

### R2S-P-F-004 — the longest-neglected work was the most certainly discarded

This is the finding that matters most, and it is not a pagination defect. It was found by the
pagination campaign because that campaign was the first to seed records that were *old*.

`ingest` skips a `stale` observation that has no existing item, on the sound reasoning that acting
on month-old evidence produces confidently wrong instructions. **That reasoning holds only for a
sampled measurement whose value decays** — a capacity snapshot, a health probe. R2S-F-006
established exactly this principle and removed five due-date and expiry-date freshness anchors.

But it substituted `updated_at`, which reproduces the identical failure at a different threshold.
A task overdue since January that nobody has touched since June reads as `stale`, and is dropped
before it can ever become an item. The worse the neglect, the more certain the suppression.

Measured: **0 of 300** overdue tasks observed.

Seven adapters carried it — operations, finance, governance, legal, objectives, CRM and
procurement. An unanswered customer message older than thirty days was being discarded on the same
rule.

The distinction is now explicit in code as `STORED_STATE_FRESHNESS`, applied to state the loader
re-reads in full every cycle, while the genuine sampled anchors remain on workforce
(`capturedAt`) and system-health (`sampledAt`). The record's age is still carried as `evidenceAt`,
which is what out-of-order protection compares — it is simply not a claim about how current our
information is.

**Scope note, for the owner's decision.** This changes behaviour across seven adapters, which is
more surface than "pagination" implies. I judged it in scope on two grounds: it makes this phase's
central requirement false regardless of paging, and the checkpoint-1 classification table had
*already* recorded four of these domains as "stored status, does not decay" while the code did the
opposite. For operations, governance and CRM I extended the same reasoning and have corrected the
classification table to match. It is a reversible judgement and it is yours to reverse.

### R2S-P-F-005 — my own test asserted something the product never promised

The size tests asserted `items === subjects`. One overdue task with no estimate legitimately
raises **two** distinct conditions. Left alone, the test would have pressured a correct behaviour
into being "fixed". Duplication means the same condition about the same subject appearing twice,
so the assertion now compares `(subject_id, kind)` pairs.

## Two corrections to my own earlier reporting

- I reported that the 500- and 501-row cases passed. **They never ran** — the file aborted after
  the 499 case failed. They were not evidence of anything, and I should not have described them as
  passing.
- I attributed the 1-record failure to the product. It was **my assertion** (F-005 above).

## What is proved, and how

| Claim | Evidence |
|---|---|
| every record is eventually observed | 0 / 1 / 499 / 500 / 501 datasets each reach exactly `n` distinct subjects |
| a tie group cannot stall the sweep | 300 rows sharing ONE timestamp are all observed |
| no record is observed twice | `(subject_id, kind)` pairs equal item count in every size case |
| a mid-sweep insert is not lost | inserted during a sweep, observed by its end |
| a mid-sweep edit is re-observed | editing moves the row to the end of a keyset order |
| a failed page does not advance the cursor | the page is retried and its rows still arrive |
| a duplicate page creates no duplicate item | the same page delivered three times |
| a lost cursor write is reported | cycle is `partial`, names the source, withholds resolution |
| a cursor holds position and nothing else | a payload allowlist trigger in draft unit 018, plus refusal tests |
| a tampered cursor cannot reposition a sweep | malformed cursors are refused, not silently accepted |
| a cycle is bounded | row budget, page size, and a query-count ceiling per page |
| a source cannot starve | rotation moves the front of the queue each generation |

## Mutation evidence

A passing suite has misled this recovery repeatedly, so each fixed defect was re-introduced and
the live suite re-run.

A passing suite has misled this recovery repeatedly, so each fixed defect was re-introduced in
product code and the live suite re-run against a disposable PostgreSQL 16. A mutation that
leaves the suite green means the suite does not test that behaviour.

| Mutation | Re-introduces | Result |
|---|---|---|
| **M1** | the compound cursor reverts to a bare inclusive timestamp bound | **CAUGHT** — 4 failed / 27 passed |
| **M2** | stored state treated as a decaying sample again | **CAUGHT** — 14 failed / 17 passed |
| **M3** | a lost cursor position swallowed again | **CAUGHT** — 1 failed / 30 passed |

The *which* matters as much as the count.

**M1** failed exactly the four tests that can see a stalled sweep — the 499, 500 and 501 sizes
and the shared-timestamp tie-group test. The 0- and 1-record cases stayed green, correctly: a
dataset smaller than one page never exercises a cursor at all. A mutation that broke everything
would have told me the tests were coupled, not that they were discriminating.

**M3** failed exactly one test, the one that asserts a lost position is reported. Nothing else
moved, which is the right blast radius for a status-reporting rule.

**M2** failed fourteen, including `a record INSERTED mid-sweep is not lost` and the
`1 record` case. That is the honest measure of how much of this suite's evidence depends on
observations actually being raised: when stored state is suppressed as stale, most of the
campaign has nothing to observe. It also shows the defect's real reach — F-004 was never a
pagination bug, and a suite that only tested paging would have missed it entirely.

## Requirement truth

No requirement is advanced by this phase.

`KRN-002` remains `locally_verified` for its existing invariant. Pagination is a property of the
observation path, not a new capability, and the honest reading of this campaign is that it
**removed a defect that made the existing verified status partly untrue** — for any company past
one page, the twelve-domain observation claim did not hold. That is a correction to the evidence
behind an existing status, not grounds for a new one.

Nothing here is staging- or production-ready. Staging and production remain zero. The cursor table
exists only as quarantined draft unit `R1_DRAFT_018`, which cannot be applied by the production
runner and requires `R1_DRAFT_CONFIRM=disposable-local-only`.

## Remaining limitations

- **Resolution on absence does not exist.** No code path resolves an item because a condition
  stopped appearing, so a partial sweep cannot cause a false resolution — the failure mode is
  unreachable because the capability is absent, not because it is guarded. `resolutionPermitted`
  and the generation machinery exist so that when resolution is built it cannot be built
  unsafely. I have not "prevented false resolutions"; I have made them impossible to introduce
  carelessly later.
- **The overlap window is 60 seconds and the re-scan is 50 rows.** Both are bounded constants, not
  derived from measured commit latency. A writer whose transaction stays open longer than a minute
  under load could still fall behind the keyset cursor. This is a known, unmeasured limit.
- **No hosted database has been touched**, so none of this is evidence about production data
  volumes, index behaviour or timing.
- The priority pre-pass reads the most overdue rows first but **never advances the cursor**, so
  urgency and stable pagination are separated rather than compromised. It is an accelerator; its
  failure delays urgent rows to their natural place in the sweep and never loses them.
