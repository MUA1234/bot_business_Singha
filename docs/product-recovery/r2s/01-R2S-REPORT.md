# Loader Contract and Semantic Integrity — report

**Local-only. No merge, no deploy, no hosted contact, no live AI, no financial effect, no
message sent, no migration renumbering, no R2D.** No staging or production readiness is claimed.

## SHAs

| Checkpoint | SHA |
|---|---|
| Twelve-domain end-to-end proof + six semantic defects | **`e4bd208`** |
| Timezone and truncation defects + contract inventory | **`c074548`** |

## What this campaign proves

Every domain now travels the complete real path, asserted in
`tests/integration/r2s-loader-contract.test.ts`:

> real schema row → real loader → normalised detector input → real `runManagementCycle` →
> management item + evidence → mutate the source → run again → stale / resolved / duplicate

A successful `SELECT` is not evidence. Producing an item from a row somebody actually inserted is.

## Eight defects, all reproduced before being fixed

| | | |
|---|---|---|
| **R2S-F-001** | finance | R2C's fix passed `created_at` as `updated_at` — wrong in the **unsafe** direction. An invoice raised months ago that only just became overdue reads as *stale*, and `priorityFor(warn, stale)` silently **downgrades** it. Now anchored to the last **payment allocation** — real mutation evidence — or `null` |
| **R2S-F-002** | finance | `total_amount − amount_settled` was a **JS float subtraction** on `numeric(20,4)` values that arrive as strings. Now exact `Decimal`: a partial payment of 33333.3333 against 100000 leaves exactly 66666.6667 |
| **R2S-F-003** | workforce | **Every** snapshot reached the detector, so an obsolete "overloaded" week kept raising an exception after the newest week said healthy. Only the latest snapshot per person is current workload |
| **R2S-F-004** | crm | R2C hard-nulled `last_outbound_at` — honest but incomplete: every answered conversation looked un-replied-to for ever. Now derived from genuine `wa_messages.direction='outbound'` evidence. **`message_outbox` is never consulted: a draft or failed send is not a sent message** |
| **R2S-F-005** | six loaders | Returned raw `pg` rows, so `date`/`timestamptz` arrived as **`Date`** where every adapter declares `string`. `.slice(0,10)` yields undefined and an ISO comparison compares `"Mon Sep 02 2026 …"` against `"2026-09-02"` — **a detector that quietly produces nothing**, the same failure mode as a missing column |
| **R2S-F-006** | five adapters | **The worse a condition got, the more certainly it was discarded** — see below |
| **R2S-F-007** | all date columns | **Every `date` read one day early in the deployment timezone** — see below |
| **R2S-F-008** | all loaders | A truncated read was **silently partial**: the first 500 rows were read and the cycle still reported `completed` |

### R2S-F-006 — the most serious

Five adapters used a **due date, an expiry date or a window start** as the evidence-freshness
anchor. `freshnessFor` then returned `stale`, and `ingest` **skips** a stale observation with no
existing item. So:

- a licence that expired **400 days** ago — dropped;
- a vehicle document **300 days** out of date — dropped;
- a provider whose insurance lapsed **a year** ago — dropped;
- an objective late in a long window — dropped;
- and for marketing it was **self-defeating**: a campaign is stalled *because* it is old, and that
  same age disqualified it.

**The queue looked calm precisely when it should not have.**

**The principle, now written into each adapter:** the `stale_source` skip is sound only for a
**sampled measurement whose value decays** — a capacity snapshot, a health probe. A condition
derived from a stored **date or status** that the loader re-reads **every cycle** does not decay:
the expiry either has passed or it has not, and the row was read moments ago. Anchoring freshness
to when the record was *filed* conflated *"the record is old"* with *"our information is old"*.
Where no genuine update timestamp exists the answer is `null` → **unknown**, which neither
suppresses nor downgrades.

Five discriminating regressions pin it; every one of those cases was dropped before the fix.

### R2S-F-007 — invisible to a UTC test suite

`pg` materialises a `date` column as a `Date` at **local midnight**, and my own R2S-F-005 fix
normalised it with `toISOString().slice(0,10)`:

```
TZ=Asia/Colombo (UTC+5:30) · date column 2026-09-02
pg Date        Wed Sep 02 2026 00:00:00 local
toISOString()  2026-09-01T18:30:00.000Z  ->  "2026-09-01"   OFF BY ONE
```

This system runs a **Sri Lankan business at UTC+5:30**, so every licence expiry, insurance expiry,
invoice due date and objective boundary would have read a day early — a licence expiring *today*
reported as already expired. **The test suite runs in UTC, where the defect is completely
invisible**, which is why the new tests set the timezone explicitly rather than trusting the
environment they happen to run in.

`isoDate` now reads **local** components and never converts through UTC. Thirteen tests across
Asia/Colombo, Asia/Tokyo, Pacific/Kiritimati (UTC+14), UTC and America/Los_Angeles.
**Mutation-checked**: restoring the UTC route turns six red.

## The twelve-domain matrix

| Domain | Loader runs | Real row → item | Mutation → resolved | Semantic evidence |
|---|---|---|---|---|
| finance | ✅ | ✅ | ✅ paid, cancelled, credited, due-date correction | exact decimal; payment-allocation freshness; **no financial effect asserted** |
| workforce | ✅ | ✅ | ✅ overload resolved | latest snapshot only; wrong-company excluded; missing snapshot ≠ zero |
| operations | ✅ | ✅ | ✅ deleted row | malicious text never reaches an observation |
| crm | ✅ | ✅ | ✅ reply after outbound | inbound-only, outbound, out-of-order, duplicate, draft/failed, cross-company |
| system | ✅ | n/a (probe) | n/a | shaped signal, key names only — never a value |
| governance | ✅ | ✅ | ✅ | |
| objectives | ✅ | ✅ | ✅ | long-window objective still reported |
| marketing | ✅ | ✅ | ✅ | 200-day stalled campaign still reported |
| procurement | ✅ | ✅ | ✅ | |
| assets | ✅ | ✅ | ✅ | 300-day-expired document still reported |
| legal | ✅ | ✅ | ✅ | four record kinds tagged; 400-day-expired licence still reported |
| providers | ✅ | ✅ | ✅ | year-lapsed insurance still reported |

**All twelve produce genuine evidence through their real loader and the actual runtime path.**

## Cross-cutting proofs

A loader failure is **loud** — the department is reported unobserved and the cycle is `partial`,
never all-clear. Every loader is company-scoped. Deleted rows stop producing conditions. Nulls do
not crash. Malicious text never reaches an observation and the table survives. The row cap holds
and truncation is reported. The sweep is idempotent. No loader joins, so duplicate rows from a
join are structurally impossible. 543 kernel tests pass with **every outbound network primitive
throwing**.

## Permanent gates

| Gate | What it prevents |
|---|---|
| `scripts/r1/check-loader-columns.mjs` | a loader selecting a column that does not exist — **33/33 verified**, run by the live campaign |
| `scripts/r1/check-loader-types.mjs` | a temporal column reaching a detector unnormalised |
| `tests/kernel/temporal.test.ts` | a date shifting by timezone, asserted outside UTC |
| `tests/integration/r2s-loader-contract.test.ts` | any domain regressing to a fixture-only claim |

## Test totals at `c074548`

| Suite | Before | After |
|---|---|---|
| Full unit suite | 2064 / 207 files | **2077 passed, 0 failed, 4 skipped / 208 files** |
| Kernel | 528 | **541** |
| Live full-schema | 188 / 9 files | **237 / 10 files** |
| Kernel under the outbound network guard | 530 | **543** |
| Live draft apply + rollback | 31 | 31 |

`verify` exit 0 · typecheck clean · lint 0 errors · build compiled · browser-check passed ·
accessibility 2 · quarantine 28 · secret-scan clean · migration-lint 109 sequential ·
IP boundary clean · autonomy audit consistent.

## Requirement truth

**KRN-002 remains `locally_verified`**, re-evaluated as the owner required and now resting on
**end-to-end evidence rather than adapter fixtures**: every one of the twelve domains is proven
from a real inserted row, through its real loader, through the real runtime, to a management item
and its evidence, and then through mutation to stale/resolved/duplicate behaviour.

The record itself now carries the full defect history and the known limits, so the status cannot
be read as a stronger claim than it is.

**`locally_verified` unchanged at 67. Staging and production remain ZERO.**

## Remaining limitations

- **Local only.** No staging, no production, no readiness claim.
- **The 500-row cap.** Beyond it a sweep is reported `partial` rather than `completed`, but the
  remainder is still unread. Incremental cursors do not exist.
- **Task completion timestamps** (F-R2B-1) remain a schema gap; task-level deadline performance is
  not computable.
- **Four domains remain partial by data availability** — MKT-001, PRC-002, AST-001, CRM-004.
- **The kernel still recommends but does not act.** No executor; no scheduler registered.
- Deployment blockers unchanged: PR-F-004, PR-F-001, PR-F-014/R0-F-007, R0-F-001, PR-F-002/003.
