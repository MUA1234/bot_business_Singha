# Batches 2–5 — the lifecycle actor matrix, the assignment boundary, and what learning may have

**Local-only.** No hosted contact, no deploy, no merge, no migration numbering, no real data, no
live model, no message sent, no financial effect.

---

## 1. The lifecycle actor matrix

Who may cause each transition, and where that is enforced. Nothing in this table is enforced by
convention: each row names the boundary that refuses everyone else.

| Transition | Actor | Enforced by |
|---|---|---|
| → `observed` | **service** (cycle) | `r1_draft_create_management_item`, service-only |
| `observed` → `understood` | **service** | orchestrator; DB transition map |
| `understood` → `prioritised` | **service** | orchestrator; DB transition map |
| `prioritised` → `recommended` | **service** | orchestrator; requires a usable catalogue action |
| `recommended` → `awaiting_approval` | **service** | orchestrator |
| `recommended` → `approved` | **service**, automatic authority only | draft 028 gate on the item's own columns |
| `awaiting_approval` → `approved` / `rejected` | **human** manager/owner | `r1_draft_record_management_decision`, `auth.uid()` |
| execution of `ops.task.create_internal` | **service** | executor: two boundaries, policy, authority, approval, freshness |
| `approved` → `needs_routing` | **service** | orchestrator, after the effect exists |
| `needs_routing` / `approved` → `assigned` | **human** manager | `r1_draft_assign_management_item`, `operations.task.manage` |
| `assigned` → `monitoring` | **service** | orchestrator, only when owner and assignee agree |
| `monitoring` → `verifying` | **staff** — the assignee only | `r1_draft_claim_task_completion`, `auth.uid()` = `tasks.assigned_to` |
| `verifying` → `verified` / `reopened` | **service verifier** | verification service, `actor_type='system'`, null actor |

**A language model appears nowhere in this table.** It may propose structured content through
validated contracts; it writes no lifecycle state, no authority, no approval, no assignment, no
execution record and no verification.

**The service is refused at every human boundary by privilege, not by policy.** `service_role` has
EXECUTE revoked on the decision RPC, the completion-claim RPC and the assignment RPC. A service
principal cannot call them at all.

---

## 2. What the orchestrator is, and what it deliberately is not

One service, one pure `decideNext`. Not state writes sprinkled through the cycle: "what may happen
to this item now" has a single answer that can be read and argued with.

* **One step per item per cycle.** Driving an item from `observed` to `approved` in one pass would
  collapse five decisions into one indistinguishable moment. Each step is its own transition row,
  with its own reason and its own timestamp.
* **`hold` and `awaiting_human` are first-class outcomes**, each carrying a per-item reason. An item
  that cannot legitimately move stays put and says why, rather than being nudged forward so the
  queue looks busy.
* **Bounded** at 25 items per company per cycle, for the same reason verification is bounded: the
  twelve domain reads must still happen.
* **Every write goes through `r1_draft_transition_item()`**, which re-locks the item and re-checks
  the from-state. The orchestrator cannot make a move the database does not already permit, and a
  disagreement between them is reported as `transition_refused` rather than retried.

---

## 3. Four findings that only appeared once it ran

### R2F-F-018 — an automatically-authorised item could not become `approved`

The only route to `approved` was `awaiting_approval → approved`, which requires a person. The map's
approval-skipping edge went to `assigned` — a state that asserts an assignee, which the one
automatic action must not have, because it creates the task **unassigned**.

`approved` and `assigned` are the only states that admit execution. So the single action the owner
authorised as automatic could not execute at all.

Draft 028 adds `recommended → approved`, gated **at the database** on the item's own columns: the
exact authorised action id, `automatic` authority, and the unattended flag the recommender sets only
when six independent facts agree. A caller presents none of it.

### R2F-F-019 — nothing in production had ever executed

`executeManagementAction` had no caller outside tests, and no server path provides a `SqlExec`. The
executor reaches its ledger and its four loaders through direct SQL; the request path speaks
PostgREST, which cannot run arbitrary SQL.

The factory's default now returns **"execution transport unavailable"** against the item and marks
the cycle partial — never a silent no-op. The remaining work is the same shape as the verification
store: a PostgREST transport for the ledger and the loaders.

### R2F-F-020 — no cycle-created item can resolve to `automatic` authority

`authorityFor` supplies `actorMembershipId: null` — correctly, because the cycle proposes and never
approves — and the authority engine escalates a null actor membership to `manager_approval` and
fails closed.

**Not repaired.** Lowering an authority the engine raised would be weakening an authority control to
make a test pass. The consequence is stated instead: every cycle-created item waits for a person,
and the real path — a manager approves, then the system carries out the action it is registered to
carry out — is what the tests drive.

### R2F-F-021 — the executor could not see an approver's capabilities

It read only `user_company_access`, the legacy table. Migration 0038 made **membership**
authoritative, so every approver the current model creates was found to hold nothing and a
legitimately approved action was refused `approver_lacks_capability`. The query now mirrors
`has_capability`'s own two branches — the question the repository already answers, rather than a
narrower one that happened to be answerable from an older table.

---

## 4. The assignment boundary

`r1_draft_assign_management_item`. One act, or nothing.

| Property | How |
|---|---|
| the assigner is a real person | `auth.uid()`; `service_role` has no EXECUTE |
| authority in scope | active membership + `operations.task.manage`, both from the database |
| the target is internal, active, same company | membership row read under lock |
| the target can do the work | the **target's** `operations.task.work`, not the assigner's |
| the target is available | approved leave in `leave_requests` refuses |
| bound to what the assigner saw | item state + condition digest |
| the candidate evidence is still true | the eligibility digest **for that candidate** |
| an override is explained | no snapshot for the target ⇒ `is_override`, reason required |
| the item and the task agree | `tasks.assigned_to` and `accountable_owner_id` written together |
| history is preserved | append-only `management_item_assignments`, with `previous_membership_id` |
| retries | exact retry returns the first assignment; a conflicting one is refused |
| races | the item lock serialises two managers; one assigns, the other finds it moved |

### The defect the tests found in my own RPC

The first version looked up "the latest recommendation" with `order by created_at desc limit 1`. The
resolver writes **one row per ranked candidate, all in the same statement**, so they share a
`created_at` and that read returned an arbitrary one. The eligibility evidence being revalidated
therefore belonged to whichever candidate the planner happened to return first — not to the person
being assigned — and `is_override` was effectively random.

It now keys on `candidate_ref = the target`, with a deterministic `id` tie-break. The evidence that
matters is the evidence **about this person**; and a target nobody ranked is, by definition, an
override.

---

## 5. Learning — what the contract can now carry, and what still may not flow

The owner's condition was to connect `verified_resolved` to positive learning **only** if the
existing contract can truthfully identify the human subject, the role performed, the completion
claimant, the deterministic evidence, the verification transition, and the distinct human reviewers
the anti-fabrication threshold requires.

### Before: one identity stood in for six

`OutcomeRecord` carried `membershipId` — the accountable owner — and nothing else about people.
`role: "assignee"` was hard-coded on the assumption that the accountable owner was the assignee.
Three of the six facts were absent entirely.

### Now: each fact comes from the record that names it

| Fact | Source | Field |
|---|---|---|
| accountable subject | `management_items.accountable_owner_id` | `membershipId` |
| task assignee | `management_item_assignments.membership_id` | `taskAssigneeId` |
| completion claimant | `management_completion_claims.claimant_user_id` | `completionClaimantId` |
| assigning manager | `management_item_assignments.assigned_by_user_id` | `assigningManagerId` |
| approving decision maker | `management_item_decisions.actor_id` | `approvingDeciderId` |
| what verified it | the transition's actor | `verifierKind: service \| human \| none` |
| role performed | the assignment's `purpose` | `role` — now a fact, not an assumption |

Draft 028 writes the item's accountable owner and the task's assignee **in one act from one resolved
membership**, so the two agree by construction — and the fold now *checks* that rather than assuming
it.

### Five new admissibility rules, every one a tightening

None admits a record that was inadmissible before. Each closes a way for one person to occupy two
roles that are supposed to check one another.

1. **A service verification is refused by name.** `deciderType` already excluded it; `verifierKind`
   states the same refusal in the verifier's own terms, so a future producer that sets
   `deciderType: "user"` on a scheduled sweep is still refused.
2. **Nobody verifies the completion they claimed.**
3. **The manager who chose the assignee is not an independent judge of the result.** Their
   assessment is real management information; it is not the second opinion the distinct-decider
   threshold counts.
4. **Nor is the person who approved the action.**
5. **A record whose subject and assignee disagree is refused, not guessed at.** Guessing is how a
   good worker inherits somebody else's record.

### The answer to the owner's question

**A machine-verified `verified_resolved` still produces no positive learning signal, and that is
correct.** Thirty of them yield `null`. The reason survives the contract being extended: the
verifier is a service, and the anti-fabrication threshold counts **distinct human deciders**
(`MIN_DECIDERS = 2`, `MIN_OUTCOMES_TO_PROMOTE = 3`). A service contributes none.

What has changed is that this is now a **checked fact rather than a lucky one**. Before, the
protection rested entirely on `deciderType`; the contract could not have expressed the difference
between the claimant, the assigner, the approver and an independent reviewer, so a future connection
would have had no way to be truthful. It can now.

`condition_persists`, `contradicted`, `reopened`, `unavailable` and `deferred` remain non-positive
and reach learning by no route: the first three are written by the service, and the last two write
no transition at all.

**R2F-F-015 remains open and pinned.** What protects people is the actor discipline, not the polarity
table: `reopened` is −1 whatever produced it. Nothing in the runtime records a human actor on a
verification, and `MIN_OUTCOMES_TO_DEMOTE = 5` with `MIN_DECIDERS = 2` bounds it even then. The
fairness model was not weakened to make any of this pass.

---

## 6. Mutation evidence, and what was not run

The owner named thirteen adversarial cases. `scripts/r1/mutations/lifecycle-assignment-mutations.mjs`
encodes **nineteen** mutations covering them, each run against the suite that should catch it —
running both suites every time would be more thorough on paper and nearly three hours slower on a
host already five times its quiet-run baseline.

**Not all nineteen were run.** Each campaign takes five to eleven minutes here, and a
partially-completed nineteen-campaign run is weaker evidence than a complete run over the guards
that matter most. The harness therefore accepts a subset on the command line, and the exact command
for the remainder is:

```bash
node scripts/r1/mutations/lifecycle-assignment-mutations.mjs          # all nineteen
node scripts/r1/mutations/lifecycle-assignment-mutations.mjs L3,L4,L5 # a named subset
```

### A mistake worth recording

Three commits captured a mutated source file mid-campaign — a deliberately disabled guard,
committed to the branch. `.gitignore` already stopped the harness's `.bak` files being staged;
the mutated SOURCE is a tracked file and staged happily, so that was only half a fix.

A campaign now takes `.r1-mutation-campaign.lock`, every harness takes it, and a pre-commit hook in
`.githooks` refuses while it is held. The offending commits were corrected in place.

## 7. Findings register

| id | statement | state |
|---|---|---|
| **R2F-F-014** | four spans of the lifecycle had no runtime writer | **closed** by the orchestrator + draft 028 |
| **R2F-F-017** | the executor compared condition evidence against candidate-eligibility evidence | **closed** by draft 027 |
| **R2F-F-018** | an automatically-authorised item could not reach `approved` | **closed** by draft 028's gated edge |
| **R2F-F-019** | no server path provides the execution SQL transport | **open**; the default reports it explicitly |
| **R2F-F-020** | the authority engine fails closed on a null actor, so nothing resolves to `automatic` | **open**, deliberately unrepaired |
| **R2F-F-021** | the executor read approver capabilities from the legacy table only | **closed** |
| **R2F-F-015** | `POLARITY.reopened = -1` regardless of source | open, pinned by a permanent gate |
| **R2F-F-016** | the queue reads through the service-role client unless `RLS_READS=on` | open |
| **R2F-F-011** | `completeTask` never checks `assigned_to` | open, out of scope |
| **R2F-F-005** | consultant access deliberately fail-closed | future original-scope work |
