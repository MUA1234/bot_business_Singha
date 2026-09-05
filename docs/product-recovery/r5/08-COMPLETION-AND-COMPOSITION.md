# Batches 1–4 — the completion claim, the real composition, the slice, and what learning may not have

**Local-only.** No hosted contact, no deploy, no merge, no migration numbering, no real data, no
live model, no message sent, no financial effect.

---

## Batch 1 — only the assigned person may report their own work complete

A completion claim means **one thing**: the assigned person reports that their work is complete. It
does not mean the action succeeded, the condition is resolved, the evidence was verified, the
worker performed well, the item may be closed, or that learning may be updated.

Draft unit **026** adds `management_completion_claims` and one narrow authenticated RPC,
`r1_draft_claim_task_completion`.

### Why the boundary cannot lean on the task's status

`completeTask` gates on `requireOps()` and never looks at `assigned_to` (**R2F-F-011**), so any
operations user — a manager, an administrator — can move anyone's task to `completed`. "The task is
completed" therefore does **not** imply "the assigned person said their work is done". The claim
boundary checks the assignment itself rather than inheriting the task API's authority.

### The two real links, kept apart

An item and a task are linked in two different ways (**R2F-F-012**):

| | |
|---|---|
| **originating** | `management_items.subject_table='tasks'` + `subject_id` — the condition that raised the item |
| **effect** | `management_execution_attempts.effect_ref` on an `executed` attempt — the work created in response |

They mean different things: finishing the effect task leaves the originating condition possibly
untouched. The claim records which one it was about, and neither is inferred from the other.

### The sixteen properties

| # | property | where |
|---|---|---|
| 1 | accepts no company, membership, actor or authority | the signature has nowhere to put them |
| 2 | claimant is `auth.uid()` | `v_actor`, refused when null |
| 3 | company derived from the item | `v_company := v_item.company_id` |
| 4 | item then task locked, one fixed order | two `for update`, item first |
| 5 | claimant IS the assignee | `v_task.assigned_to is distinct from v_actor` |
| 6 | active membership + `operations.task.work` | `memberships.status`, `has_capability` |
| 7 | the task's real terminal status | `completed`, `cancelled` — from `isTerminal` |
| 8 | item state admits a claim | `monitoring`, `escalated` — from the lifecycle map |
| 9 | bound to version, action, task and evidence digest | `bound_*` columns, compared before writing |
| 10 | database timestamp | `claimed_at default now()`, never `tasks.updated_at` |
| 11 | claim + transition + audit atomically | one function, one transaction |
| 12 | idempotent exact retry | checked **before** the binding comparison |
| 13 | conflicting retry refused | same key, different task or person → `conflicting_retry` |
| 14 | simultaneous claims serialised | the item lock |
| 15 | all prior history preserved | append-only table + append-only transitions |
| 16 | no verification, no learning signal | asserted by absence, three ways |

Property 12 is the one that needed care: a successful claim moves the item to `verifying`, so an
exact retry carrying the state the claimant *saw* would be refused as stale before it could be
recognised as the same claim. The idempotency lookup therefore runs after the identity checks and
before the binding comparison.

### The hole the tests found in my own migration

The first version revoked EXECUTE from `PUBLIC` and `anon`. Supabase's default privileges grant
EXECUTE on every new function to `authenticated` **and `service_role`**, so the service principal
could still call it — precisely the impersonation the boundary exists to prevent. A revoke naming
only the roles you happened to think of is not a boundary. Both the function and the table now
revoke by an explicit role list, and a privilege test asserts the grantee set is exactly
`{authenticated}`.

### Evidence

| | |
|---|---|
| `r2-completion-claim` (live) | **37 passed** |
| mutations (`claim-mutations.mjs`) | 11 applied, all **CAUGHT** |

Mutations, each against a real database: assignee comparison removed; accountable owner alone
sufficient; `service_role` granted EXECUTE; an unfinished task accepted; the claim time taken from
`tasks.updated_at`; the claim also marking the item verified; the capability check dropped; a
conflicting retry answered with the first claim; the evidence binding dropped; the item lock
removed; the item–task link check dropped.

### The UI

A control appears **only** where the server resolved the state to `claimable`: the signed-in person
is the current assignee of the linked task, the task is finished, required evidence exists, the item
is at a stage that admits a claim, and the capability is held now. Thirteen other states each render
a sentence saying which it is — a missing control and a withheld one look identical to the person in
front of the screen, and only one of them is a true statement about their work.

Hiding the button is a courtesy, not the boundary. Four tests call the RPC exactly as a browser
could, with the values a legitimately rendered page produced, after the facts changed underneath it:
the capability removed, the membership ended, the task reassigned, the task reopened. All four are
refused.

---

## Batch 2 — `verificationSweep` is now a real dependency

### What was wrong

`runManagementCycle` called `deps.verificationSweep` **if it was present**. `makeCycleDeps` — the one
factory the request path uses — did not provide it. So the deployed system verified nothing and
reported a summary of zeroes, which is exactly what a company with nothing pending looks like. A
dependency whose absence is indistinguishable from calm is not a dependency.

### What it is now

* `verificationSweep` is **required** on `CycleDeps`. Omission fails at compile time — and did:
  four test fixtures and two suites stopped compiling, which is the point.
* `makeCycleDeps` constructs it, from `createSupabaseVerificationStore(db)`.
* A transport that cannot reach the schema returns `unavailableSweepSummary(reason)` — an explicit
  reason, `partial: true`, and therefore a cycle that can never be reported as `completed`. Zeroes
  are reserved for "there was nothing pending".
* The summary now also names the `transport` that reached the database.

### One implementation, two transports

`VerificationStore` is a **storage port** with six operations. Both adapters fetch rows and write
rows; neither decides anything. Ordering, budget, backoff, the outcome and the lifecycle transition
are decided once, in `schedule.ts` / `service.ts` / `verify.ts` / `rules.ts`.

| moved out of the adapters | to |
|---|---|
| the `order by` on pending items | `orderPending()` in the scheduler |
| `now()` for backoff and attempt time | the scheduler's single clock |
| "never attempted means due now" | `nextAttemptAt: null`, so no clock is consulted to say so |

That last one removed a real hazard: the SQL adapter substituted the **database's** `now()` while the
scheduler compared it against the **application's** clock, so a never-attempted item could be
deferred by nothing but skew between two machines.

PostgREST cannot express the LEFT JOIN or the correlated subqueries the SQL transport uses, so each
becomes a second company-scoped read combined mechanically. Every read in both adapters is filtered
by a `company_id` that came from the server-side cycle request.

### The composition-edge test

Calling the sweep directly cannot detect the defect above, because it constructs the very dependency
the runtime was missing. `r2-cycle-composition.test.ts` therefore builds the graph the **same way the
runtime does** — `makeCycleDeps(client)`, no injection — and drives `runManagementCycle`. The only
substitution is the HTTP transport.

It asserts: the factory supplies the dependency; a resolved item is verified through the Supabase
transport with the attempt recorded as `system`; a persisting condition is reopened, not closed; a
disabled company performs zero writes of any kind; another company's pending item is untouched; and a
broken transport produces an explicit reason with a partial cycle.

A **parity** test runs the same fixtures through both transports and compares the results field for
field — an adapter that decided anything for itself would show there, and deciding anything is
precisely what an adapter must not do.

---

## Batch 3 — the operations slice, and the four places it is not end to end

Every step with a runtime path is driven by that path: the real detector, the real cycle, the real
decision RPC, the real execution service, the real claim RPC, the real verification sweep through the
real dependency graph.

### R2F-F-014 — the middle of the management loop has no writer

**Four spans of the lifecycle have no runtime writer at all.**

```
observed → understood → prioritised → recommended → awaiting_approval    nothing writes these
approved → assigned                                                      nothing writes this
assigned → monitoring                                                    nothing writes this
```

The complete set of runtime writers of `management_items.state` is:

| writer | transition |
|---|---|
| the cycle's atomic create | → `observed` |
| `r1_draft_record_management_decision` | `awaiting_approval` → `approved` / `rejected` |
| `r1_draft_claim_task_completion` (new) | `monitoring` / `escalated` → `verifying` |
| the verification service | `verifying` → `verified` / `reopened` |

**The consequence, stated plainly: in the deployed system an item is created in `observed` and stays
there.** It can never reach the decision boundary, the completion claim or verification, because
nothing moves it. The decision RPC, the claim RPC and the sweep are all real, all tested, and all
unreachable by a real item.

This is R2F-F-008 seen from the other side, and it is now precise about which hops are missing. The
slice test performs them itself through the database boundary, each call marked
`// NO RUNTIME WRITER` — so a passing suite cannot be read as proving the opposite.

I have **not** built the missing writers. Prioritisation, routing and assignment are new management
capability, and the standing instruction is one approved phase at a time.

### What the slice does prove

Two scenarios, each asserting six concerns **independently** — the task effect, the completion claim,
the business condition, the management transition, the audit history and learning eligibility are six
different questions, and a slice that checks one and infers the rest is how "the task is done" comes
to mean "the problem is solved".

**Resolved.** The condition is genuinely fixed; the later cycle verifies; the item reaches `verified`;
the full ten-state history is present in order; the audit carries both `management_item.approve` and
`management_item.completion_claimed`; the final conclusion is recorded as `system` with a null actor.

**The condition persists.** The effect task is completed and claimed by the worker — and the
originating condition is *left exactly as it was*, not manufactured. The later cycle re-observes with
the same detector, concludes `condition_persists`, and:

* does **not** verify (`verified: 0`);
* does **not** close the item (`reopened`, and no `verified` transition exists);
* produces **no** positive learning signal, and no negative one either — the conclusion is the
  system's, and a machine noticing that a problem persists is not evidence about a person.

Execution creates **exactly one** task, and it is **unassigned**: the executor may create work, it may
not give it to anyone. The manager is refused the claim before the worker makes it.

---

## Batch 4 — learning stays disconnected, and here is exactly why

The owner's condition: connect `verified_resolved` to positive learning **only** when the existing
contract can truthfully identify the human subject, the role performed, the completion claimant, the
deterministic evidence, the verification transition and the distinct human reviewers the
anti-fabrication threshold requires. Otherwise register the gap and stop at that boundary.

**It cannot. Nothing is connected.**

### The six facts, against `OutcomeRecord`

| fact | lives in | in the contract? |
|---|---|---|
| accountable subject | `management_items.accountable_owner_id` (membership) | ✅ `membershipId` |
| task assignee | `tasks.assigned_to` (**user**) | ❌ absent |
| completion claimant | `management_completion_claims.claimant_user_id` (**user**) | ❌ absent |
| decision maker | `management_item_decisions.actor_id` | ❌ absent (only the transition actor) |
| deterministic verification service | `actor_type='system'`, `actor_id` null | ⚠️ collapsed into one field with `ai` and `user` |
| human verifier | a person moving the item to `verified` | ✅ `deciderId` + `deciderType='user'` |

Three of the six are absent, and one more is only distinguishable by a field that carries three
meanings. Two consequences follow:

1. **The subject may be the wrong person.** `membershipId` is the accountable owner; the person who
   did the work is `tasks.assigned_to`, and the person who reported it done is the claimant. Draft
   026 makes those genuinely separate identities. `role: "assignee"` is **hard-coded** in the record
   builder on the assumption that the accountable owner is the assignee — an assumption, not a fact.
2. **A machine verification contributes nothing anyway.** `isAdmissible` requires `deciderType ===
   "user"` *and* a non-null `deciderId`; the sweep writes `system` and null. So connecting
   `verified_resolved` to positive learning today would be a no-op wearing the appearance of a
   feature.

**A service verification cannot falsely satisfy the distinct-human-decider rule.** Twenty machine
verifications contribute a `distinctDeciderCount` of zero, and fifty of them alongside one human
record produce a byte-identical signal to the human record alone. Both guards were checked
independently, so neither is load-bearing on its own.

### R2F-F-015 — what actually protects people, and what does not

The protection is the **actor discipline**, not the polarity table. `POLARITY` maps `reopened: -1`
regardless of what produced it, so a `condition_persists` recorded with a *human* actor becomes
admissible negative evidence about whoever is named accountable — for a condition persisting, which
may have nothing to do with that person's work.

Nothing in the runtime does this: the scheduled sweep passes no actor and is the only writer. Two
existing thresholds bound it even then (`MIN_OUTCOMES_TO_DEMOTE` = 5, `MIN_DECIDERS` = 2), so one
conclusion, or one person, can never demote anyone.

I have **not** changed `POLARITY`. `reopened: -1` is R2B's existing semantics for a manager's
judgement of delivery quality, and changing it would alter a different subsystem's meaning to
accommodate a caller that does not exist. The exposure is pinned instead:
`tests/kernel/verification-learning-boundary.test.ts` (12 tests) states it precisely, so the day
somebody passes an actor id to a verification they are looking at a test that says what it would
mean.

### The non-positive outcomes

`condition_persists`, `contradicted`, `reopened`, `unavailable` and `deferred` reach learning by no
route today: the first three write transitions attributed to `system`, and `unavailable` and
`pending_clean_observation` write **no transition at all**. None becomes an automatic negative staff
signal. That is asserted, not assumed.

---

## Registered findings

| id | statement | status |
|---|---|---|
| **R2F-F-011** | `completeTask` gates on `requireOps()` and never checks `assigned_to`; any operations user can close anyone's task | open, out of this scope — the claim boundary does not rely on it |
| **R2F-F-012** | an item and a task have two distinct real relationships, meaning different things | closed by design: `link_kind` records which |
| **R2F-F-013** | `management_item_transitions` cannot record the claimed task, the idempotency key, or the binding | closed by draft 026 |
| **R2F-F-014** | four spans of the management lifecycle have no runtime writer; an item created in `observed` can never reach a decision, a claim or verification | **open, and blocking a genuinely end-to-end loop** |
| **R2F-F-015** | `POLARITY.reopened = -1` regardless of source; a human-recorded `condition_persists` would be an automatic negative signal about the accountable person | open, pinned by a permanent gate; not exploitable by any current runtime path |
| **R2F-F-016** | the queue's decision-capability checks use the read client, which is the service role by default and has no `auth.uid()`, so `has_capability` answers "no" for everyone | open; the completion path uses the request-bound client instead |
