# Batch 1 — the runtime path, edge by edge

**Local-only.** No hosted contact, no deploy, no merge, no migration numbering, no real data, no
live model, no message sent, no financial effect.

Baseline: `claude/product-recovery-r1`, HEAD `d919cf8`. Host preflight: **16 unrelated containers**,
unchanged from the previous session.

Findings are registered before anything is corrected.

---

## The path, and which edges actually exist

| # | edge | state |
|---|---|---|
| 1 | cycle → source observation | **connected** — `runManagementCycle` reads twelve adapters |
| 2 | observation → management item | **connected** — `r1_draft_create_management_item` |
| 3 | item → recommendation snapshot | **connected** — `management_item_recommendations` |
| 4 | recommendation → human decision | **connected** (previous session) — draft 022 decision RPC |
| 5 | decision → controlled effect | **connected** (R2E) — executor, off by a compile-time constant |
| 6 | **item → accountable work → completion claim** | **MISSING — R2F-F-008** |
| 7 | claim → pending verification | **MISSING** — nothing ever reaches `verifying` |
| 8 | pending → targeted re-observation | **built, unscheduled — R2F-F-009** |
| 9 | outcome transition | **connected** — via `r1_draft_transition_item()` |
| 10 | verified outcome → learning | **connected, and correctly gated — see R2F-F-010** |
| 11 | learning → owner/manager visibility | partial — the queue shows state, not verification status |

---

## R2F-F-008 — nothing ever creates a completion claim

A repository-wide search for writers of a transition to `verifying` or `monitoring` returns
**nothing**. `r1_draft_transition_item()` has exactly two callers in application code: the decision
RPC (`awaiting_approval → approved|rejected`) and the verification service I added last session.

The cycle does not advance items at all. `r1_draft_create_management_item` creates them in
`observed`, and no code moves them to `understood`, `prioritised`, `recommended`,
`awaiting_approval`, `assigned`, `monitoring` or `verifying`.

**Consequence.** The verification service is correct and proven, and in a real system it would find
nothing to verify, because no item can reach a state that admits verification.

**Not fixed by inventing one.** A completion claim is a statement that somebody made — by a person,
or by the accountable work reaching a terminal state. Deciding *which* is a product decision about
who is allowed to claim completion, and the middle of the lifecycle (`observed → … → assigned`) is
absent too, so a claim step alone would still not connect. Registered; the scheduler below is built
to handle whatever eventually produces claims.

---

## R2F-F-009 — verification exists but nothing schedules it

`verifyManagementOutcome` is imported by its own tests and by nothing else. There is no cycle step
that selects pending items, no budget for it, no retry state and no summary counter.

**This is what Batch 2 corrects.**

---

## R2F-F-010 — the learning gate is already correct, and stricter than I assumed

I expected to find a defect here and did not, which is worth recording as carefully as a defect.

`loadSignals` (`cycle-deps.ts`) reads transitions to `verified` and `reopened` and builds
`OutcomeRecord`s attributed to `accountable_owner_id` as `assignee`. `POLARITY` in `learning.ts`
scores `verified: +1` and **`reopened: -1`**.

Read alone, that says a machine-written `reopened` — which is exactly what
`condition_persists` produces — would become a negative mark against the assigned person,
automatically, with no human attribution, evidence or reason. That is precisely what the owner
forbids.

**It does not, because the fold excludes non-human deciders:**

```ts
if (r.deciderType !== "user") return false;   // AI- and system-authored are not verification
// …and the exclusion is reported: `confirmed by ${r.deciderType}, not a person`
```

So a system-scheduled verification cannot damage anyone's standing, and the guarantee is already
enforced one layer below where I would have added it. **Adding a second gate would have been the
mistake R2F-F-007 already taught** — a newer, parallel rule beside an existing one.

**The consequence for Batch 3, stated plainly.** Two conditions are each necessary for a positive
person-signal: the outcome must be `verified`, *and* a person must have confirmed it. A
machine-verified resolution therefore does **not** raise anyone's suitability. That is the strictest
reading of "only `verified_resolved` may generate a positive outcome signal" — a restriction, not a
mandate — and it is the reading that keeps machine re-observation out of people's records entirely.

Batch 3 therefore *proves* these guarantees hold under the new writer rather than adding machinery.

---

## Answers to the specific questions asked

| question | answer |
|---|---|
| which state identifies a genuine pending-verification item | `verifying`; `monitoring` also admits a conclusion. Both are unreachable today (F-008) |
| who or what may create a completion claim | **nothing does** (F-008) |
| how the originating observation identity is retained | `management_items.subject_table` + `subject_id`, plus `identity_key`; the re-read is targeted at exactly those |
| does the claim record actor and database timestamp | `management_item_transitions` has `actor_id`, `actor_type` and `created_at default now()` — a **database** timestamp, and append-only |
| where the evidence generation/digest is stored | **not stored** — computed on demand by `r1_draft_evidence_digest`, the same function the decision boundary uses |
| how the operations adapter re-reads the exact record | `readTask` in `verification/service.ts`: targeted by `(company_id, id)`, returning `requires_evidence` and the **verified** evidence count |
| can existing cycle cursors schedule verification | `management_source_cursors` is keyed to observation sources and generations. Verification is per ITEM with retry timing, which that table cannot express — see the scheduling note below |
| does any code treat execution success or task completion as outcome success | **no.** Learning keys only on `verified`/`reopened` transitions, and nothing writes those but the verification service |
| does any learning producer consume unverified/reopened/unavailable/contradicted outcomes | it consumes `reopened`, but excludes it from person-signals unless a **person** confirmed it (F-010). `unavailable` and `pending` write no transition at all, so they reach learning by no route |

## Scheduling state — extending rather than adding

The existing cursor table records a position and a generation per **source**. Fair verification
needs a per **item** attempt count, a next-attempt time and an append-only attempt record — three
facts that table has nowhere to put, and forcing them in would overload a mechanism whose meaning is
already load-bearing for pagination.

One minimal quarantined draft unit is therefore added, under the owner's explicit authorisation,
containing only those three things. The per-company cycle lock, the lifecycle boundary and the
transition log are all reused unchanged.
