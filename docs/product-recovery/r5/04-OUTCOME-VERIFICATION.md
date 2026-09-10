# Batch 2 — outcome verification by re-observation (roadmap R5, R2F-F-004)

**Local-only.** No hosted contact, no deploy, no merge, no migration numbering, no real data, no
live model, no message sent, no financial effect.

## The three facts, kept apart

| | |
|---|---|
| **an action was executed** | a row was written |
| **work was claimed complete** | somebody said so, or a status moved |
| **the business condition is verified resolved** | something read the originating record again and found otherwise |

Creating an internal task proves the first. It proves nothing about the third: the overdue task that
caused the recommendation is still overdue until something looks again. A live test asserts exactly
that — the execution effect exists (one `captured`, unassigned task) **and** the originating
condition is independently `condition_persists`. The two assertions are separate, as required.

## Why operations is the first slice

Not because it is easy. Because its condition is a **targeted re-read of one record**, and the
resolution rule can be the detector itself run again — `detectTaskExceptions`, the same function
that raised the item. Verification therefore cannot drift from detection and start disagreeing
about what the problem was.

Eleven domains have **no rule**. They are listed explicitly rather than defaulted, so adding a
domain forces a decision about it, and the verifier returns `unavailable` naming the domain.
`finance` in particular is left unmapped: an invoice that stops being returned by a query may have
been paid, written off, re-dated, or simply missed by a partial sweep, and no absence rule can tell
those apart.

## The contract, enforced in one place

Before any domain rule is consulted: same company; the read must be of the **same originating
record** the item names; a state that admits a conclusion; the evidence generation unchanged; the
observation **later than the completion claim**; and the sweep complete and not interrupted.

The claim moment is read from the append-only transition log — the transition into `verifying` —
not from any column a later edit could move.

## A completion claim is not a verification

The sharpest case. A terminal task status is what "a user clicked complete" produces, and the
contract says that is never proof. The record itself carries the distinction: a task that **demands
evidence** and has none **verified by a human** was closed on somebody's word alone. That returns
`contradicted` and reopens, not `verified_resolved`. Supply verified evidence and the same task
verifies.

## What can never read as success

| | outcome |
|---|---|
| the read failed | `unavailable` |
| the record is gone | `unavailable` — deletion is ambiguous, and refusing is the only truthful answer |
| the sweep did not complete | `pending_clean_observation` |
| the generation was reset or abandoned | `pending_clean_observation` |
| the observation predates the claim | `unavailable` |
| the item belongs to another company | `unavailable` |
| the read was of a different record | `unavailable` |
| the domain has no rule | `unavailable`, naming the domain |

`tasks.updated_at` is never consulted; a test strips comments and asserts the string appears nowhere
in the verification path. Execution state is never consulted either — the same test asserts
`execution`, `effectRef` and `executed` appear nowhere.

## Learning and people

Only `verified_resolved` feeds positive learning. `condition_persists`, `unavailable` and
`pending_clean_observation` are explicitly **neutral for people**: approved leave, a missing record
and a source failure are facts about the world or about this system, and letting them accumulate
against a person is how a management tool becomes a surveillance tool.

## Evidence

| | |
|---|---|
| Unit — the decision | **25 passed**, driving the real detector |
| Live — the runtime path | **15 passed**, real PostgreSQL 16 |

Live coverage: genuine resolution by terminal status and by the condition lifting; reopen when the
condition persists; contradiction on an unevidenced completion and acceptance once evidence is
verified; execution-is-not-outcome; deleted record; incomplete sweep; reset generation; observation
before the claim; cross-company; a domain with no rule; an item with no recorded claim;
**simultaneous verification producing exactly one terminal transition**; and a reopened item not
re-verifiable without a fresh claim.

Concurrency is serialised by `r1_draft_transition_item()`, which takes the item `FOR UPDATE` and
re-checks the from-state — so the second verifier sees the first's committed state and its
transition is refused. One transition row, asserted by count.

## Mutations — all eight CAUGHT

| | verdict |
|---|---|
| V1 a successful read alone counts as resolution | **CAUGHT** — 5 failed |
| V2 task completion treated as success unconditionally | **CAUGHT** — 2 failed |
| V3 generation-completeness check removed | **CAUGHT** — 1 failed |
| V4 loader failure treated as absence, then resolution | **CAUGHT** — 1 failed |
| V5 originating identity comparison removed | **CAUGHT** — 1 failed |
| V6 cross-company evidence accepted | **CAUGHT** — 1 failed |
| V7 unavailable fed into positive learning | **CAUGHT** — 1 failed |
| V8 observation-before-claim check removed | **CAUGHT** — 1 failed |

V3 first reported INCONCLUSIVE — its anchor had the wrong indentation, so the mutation never
applied. Reported as inconclusive rather than survived, corrected, and re-run to CAUGHT.

## Limitations, stated

- **One domain verifies.** Eleven return `unavailable` naming themselves. That is the honest state,
  not a gap hidden behind a generic rule.
- **No absence-based rule exists at all.** Every path here is a targeted re-read. The absence
  machinery in the contract (`pending_clean_observation`, the clean-generation requirement) is
  built and tested but no domain uses it yet.
- **Nothing schedules verification.** There is no cycle step that picks up items in `verifying` and
  runs this. The runtime path exists and is proven; the trigger for it is the next piece.
- **The learning store is not yet fed from these outcomes.** `feedsPositiveLearning` is enforced as
  a predicate and tested, but no writer consumes it.
