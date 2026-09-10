# Batches 2 and 3 — scheduled verification, and what it may tell learning

**Local-only.** No hosted contact, no deploy, no merge, no migration numbering, no real data, no
live model, no message sent, no financial effect.

## What is now connected

`runManagementCycle` runs a bounded outcome-verification sweep **after** it has established its
source results, and reports what it did — including what it did not do.

The sweep is **deterministic and provider-free**. No model is asked whether work succeeded. Every
conclusion comes from re-reading the originating record and running the same detector that raised
the condition.

## Eligibility

An item is considered only when it is in `verifying` or `monitoring`, belongs to the company being
swept, still names its originating record, has a recorded completion claim, and has a verification
rule for its domain. Eleven domains have no rule and are attempted, concluded `unavailable` **with
the domain named**, and left where they are — never quietly treated as resolved.

## Ordering, and what a partial cycle may conclude

Verification runs last, and only when the cycle actually finished looking:

```ts
const cycleComplete =
  summary.sourcesFailed === 0 &&
  summary.unobservedDepartments.length === 0 &&
  summary.truncatedSources.length === 0 &&
  summary.cursorCommitFailed.length === 0 &&
  !summary.budgetExhausted;
```

A partial cycle defers **every** pending item. The reason is asymmetric and worth stating: a
half-finished sweep looks exactly like a resolved condition — the detector did not raise it — so a
partial cycle is precisely the situation in which a negative conclusion is most tempting and least
supportable.

**A cycle with verification work left unknown can never be `completed`.** `summary.verification.partial`
feeds the same status decision as a truncated read, and the reason string says how many items remain.

## Bounded fairness, measured

| | |
|---|---|
| budget | **10 items per company per cycle** |
| backoff | 5, 15, 60, 240, 1440 minutes — the last repeats, so it is bounded, not endless |
| selection order | `next_attempt_at` ascending, then `item_id` — deterministic |

**Measured bound, printed by the test rather than asserted from theory:**

```
=== VERIFICATION BOUND: 23 pending items cleared in 3 cycles
    (budget 10/cycle, arithmetic bound 3)
```

**A permanently unverifiable item cannot starve the queue.** An item whose originating record has
been deleted concludes `unavailable` for ever. It is given the earliest possible position, attempted,
steps back under backoff, and the item behind it is reached — asserted directly. It is not forgotten
either: `attempts` and `last_outcome` remain readable, and there is no cap that silently drops the
remainder.

The two starvation directions are both covered: verification cannot consume the cycle (a fixed
budget), and pending verifications cannot stop the twelve domain reads (it runs after them, bounded).

## Scheduling state

Draft **025**, under the owner's authorisation, holds only three things: attempts, a next-attempt
time, and append-only attempt evidence. The per-company cycle lock, the lifecycle boundary
`r1_draft_transition_item()` and `management_item_transitions` are reused unchanged.

Read access follows the **item**: someone who may not see an item may not see how often the system
tried to verify it, because the attempt history would otherwise disclose that the item exists. There
is no write policy on either table — a session that could write here could park an item in permanent
backoff or fabricate an attempt history.

## The defect I introduced, and caught

The verification service wrote every lifecycle transition with `actor_type = 'user'`, including
those from a scheduled sweep that passes no actor at all.

That matters because `management_item_transitions` is the log the learning fold reads to decide
whether an outcome is evidence about a person, and `POLARITY` scores `reopened: -1`. A machine
conclusion of `condition_persists` — which writes `reopened` — recorded as a person's would have
become **a negative mark against whoever was accountable**, automatically, with no attribution,
evidence or reason. That is the exact behaviour the owner's instruction forbids.

**Two guards downstream would still have caught it** (`deciderType !== 'user'` and `!deciderId`).
That is not a reason to leave it: a record that is true only because something further on
compensates is not a true record, and the next caller to pass an `actorId` for a manual verification
would have turned a machine-shaped conclusion into person evidence.

Fixed: `input.actorId ? "user" : "system"`. Asserted live — a scheduled transition is recorded as
`system` with a null actor, for both `verified` and `reopened`.

## What learning may and may not receive

The guarantees are enforced by the **existing** fold in `people/learning.ts`, not by anything added
here. R2F-F-007 taught the cost of adding a second rule beside an existing one; these tests prove
the existing rules hold under the new machine writer, which is the part that was never exercised —
until now, nothing wrote a `verified` or `reopened` transition at all.

| | |
|---|---|
| machine `verified` | recorded as `system`, so **not** person evidence |
| machine `reopened` (a persisting condition) | recorded as `system`, so **not** a negative signal |
| `unavailable` / `pending_clean_observation` | write **no transition**, so they reach learning by no route |
| execution success, task creation | write no outcome transition — asserted by count |
| attempt history | append-only; a superseded conclusion cannot be rewritten to match a newer reality |

Two conditions are each necessary for a positive person-signal: the outcome must be `verified`,
**and** a person must have confirmed it. That is the strictest reading of "only `verified_resolved`
may generate a positive outcome signal" — a restriction, not a mandate — and it keeps machine
re-observation out of people's records entirely.

## Evidence

| | |
|---|---|
| `r2-verification-schedule` (live) | **20 passed** |
| `r2-outcome-verification` (live) | 15 passed |
| `verification` (unit, real detector) | 25 passed |

Live coverage includes: scheduled verified resolution; persisting condition reopened; append-only
attempt with its observation and generation; partial cycle deferring everything; interrupted
generation; budget exhaustion reported as partial with the remainder counted; the measured bound;
a permanently unverifiable first item not starving the queue; backoff bounded and increasing; an
item in backoff deferred without consuming budget; company isolation; unsupported domain; idempotent
re-run; simultaneous sweeps producing exactly one transition; one item's failure not suppressing
another; and the four learning-boundary assertions above.

---

## Adversarial review — where code existence is not a runtime connection

The review question was: *at which point is a function's existence being mistaken for the system
actually calling it?* Three answers, and the first is about my own work in this session.

### 1. `verificationSweep` is not provided by the real dependency factory

`runManagementCycle` calls `deps.verificationSweep` when it is present. **`makeCycleDeps` does not
provide it.** So in the deployed shape of the system the sweep is never reached, and the live tests
— which call `runVerificationSweep` directly — prove the sweep works without proving the cycle runs
it.

That is precisely the confusion this campaign keeps finding, and it would have been easy to report
"verification is scheduled in the cycle" on the strength of code that is never called.

**What is now proven, and what is not.** Five tests assert the EDGE: that the cycle calls the sweep
with the right company; that it reports `cycleComplete: false` when a source failed; that a partial
sweep makes the cycle `partial`; that a throwing sweep is reported rather than hidden and does not
fail the cycle; and that without the dependency the cycle still runs and reports zeroes rather than
pretending. What is **not** proven is production wiring — and cannot be, because `makeCycleDeps`
speaks through the Supabase query builder while the sweep needs direct SQL, and the schedule tables
live in a quarantined draft that no hosted database has.

**Registered as the next dependency:** provide `verificationSweep` from `makeCycleDeps`, which means
either a SQL-capable server client or converting the sweep's four statements to RPCs.

### 2. Nothing produces the input the sweep consumes

R2F-F-008 again, from the other side. Even fully wired, the sweep would find nothing: no code moves
an item into `verifying`. The whole middle of the lifecycle — `observed → … → assigned → monitoring`
— has no writer.

### 3. What IS reachable end to end

The decision path is: `/app/command/queue` renders `ManagementQueuePanel`, which renders
`DecisionControls`, which calls the server action, which calls the decision RPC. Every hop exists
and is tested. Execution is deliberately unreachable — the global boundary is a compile-time
constant — and that is a decision, not a gap.
