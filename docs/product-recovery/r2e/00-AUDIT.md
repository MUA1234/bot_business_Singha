# R2E Batch 1 — audit of the existing approval-to-execution surface

**Local-only.** No hosted contact, no deploy, no merge, no migration number, no live or paid
model, no real data, no message sent, no financial effect.

Baseline: branch `claude/product-recovery-r1`, HEAD `bda274b5cf4bbdb7ed4f3247119557d4ca14f59f`,
`origin/claude/product-recovery-r1` identical, working tree clean.

Findings are registered here **before** any fix, as required.

---

## 1. The headline: there is no execution engine, and the automatic tier is unreachable

Two independent facts, both established by running code rather than by reading it.

**(a) No catalogue action has a handler.** A repository-wide search for the 15 registered action
ids outside `src/kernel/catalogue.ts` returns **nothing**. There is no dispatcher, no handler map,
no execution ledger table, and no `executed` state anywhere in the lifecycle or the schema. The
catalogue is today a *proposal vocabulary* only.

**(b) `mayRunUnattended` is a constant `false`.** Not by policy — by a vocabulary mismatch nobody
recorded. See R2E-F-001.

R2E therefore builds the mechanism; it does not wire up an existing one.

---

## 2. Findings

### R2E-F-001 — the automatic authority tier is unreachable, and no test would notice

`resolveRequiredAuthority` classifies actions against `ACTION_FLOORS`, a **closed list** matched by
exact membership on a normalised key (`src/policy/authority-engine.ts:98`). Unknown actions escalate
to `manager_approval` and set `failedClosed = true`.

Every catalogue id normalises to a key that is **not in that list**. The two lists were written in
different vocabularies: the engine knows `opstaskcreate`; the catalogue registers
`ops.task.create_internal`, which normalises to `opstaskcreateinternal`. Membership is exact, so
nothing matches.

Measured for all 15 actions (`tests/r2e-authority-probe.test.ts`):

| | result |
|---|---|
| `actionFloor(id)` | `null` — **15 of 15** |
| `failedClosed` | `true` — **15 of 15** |
| resolved level | `manager_approval` (13) / `specialist_approval` (2) — never `automatic` |

`recommend.ts:129` computes:

```
mayRunUnattended = required === "automatic" && automaticSafe && reversible
                   && !resolution.failedClosed && evidenceQuality === "sufficient"
```

The first and fourth conjuncts are each independently false for every action. **`mayRunUnattended`
cannot be `true` for any input.** Consequently `assertTransition`'s D-9 bypass
(`recommended → assigned`) is also unreachable from the real pipeline.

**This fails in the safe direction.** It is registered as a finding for three reasons:

1. The catalogue advertises 5 actions as `automatic` + `automaticSafe`
   (`ops.task.create_internal`, `ops.task.reminder_internal`, `ops.task.request_progress_update`,
   `ops.task.escalate_internal`, `system.health.investigate_internal`). That claim is not true of
   the running system. A reader auditing the catalogue would conclude five actions may run
   unattended. None may.
2. **Adding one string to `ACTION_FLOORS` would silently enable unattended execution** for up to
   five actions, with no test failing and no reviewer signal. That is a one-line change with a
   large blast radius.
3. It sets up a false pass for R2E itself: an executor test that *stubs* authority would show the
   allowlisted-action path working, while the same path does nothing in the real pipeline.

**Mutation evidence — the tests do not discriminate.** `mayRunUnattended` was replaced with a
hard-coded `false` and the suite re-run:

| | |
|---|---|
| baseline, `tests/kernel/recommend.test.ts` + `adapters-r2a.test.ts` | 89 passed |
| mutated (`mayRunUnattended: false && (…)`) | 89 passed |
| mutated, **full unit suite** | **2196 passed / 0 failed / 4 skipped, 215 files** |

**SURVIVED.** All 11 existing assertions on this field assert `.toBe(false)`; not one asserts
`true`. The suite is exactly as consistent with a correct computation as with a hardcoded constant.
`src/kernel/cycle-deps.ts:593` persists this always-false value to the database.

Disposition: **not fixed in Batch 1.** Correcting the catalogue/engine vocabulary is an authority
change and belongs to Batch 6 (approval and authority), with the discriminating tests that must
accompany it. A permanent gate pinning the *current* behaviour is added first, so any future change
to it is deliberate and visible.

### R2E-F-002 — the only candidate write path is a form action that swallows its own failure

`ops.task.create_internal` is the one catalogue action whose *effect* already exists in the product,
via `createTask` (`src/app/app/operations/tasks/actions.ts:38`). It is not usable as an execution
handler:

- it takes `FormData`, not typed parameters;
- it derives identity from the **session** (`requireOps()`), so it cannot act for an approved
  request on behalf of another actor;
- **`if (error) return;`** — a failed insert returns normally. An executor calling this would record
  a successful execution while nothing was written. The comment explains it as pre-migration
  tolerance; on an execution path it is a silent-success defect;
- it calls `revalidatePath`, so it is bound to a Next.js request context;
- it audits with the soft `writeAudit`, not `writeAuditStrict`, so a lost audit row does not fail
  the operation.

R2E must not call it. A separate, typed, transactional command is required — and per the standing
instruction, no handler is to be invented for the other 14 merely to fill the matrix.

### R2E-F-003 — no execution ledger, and `management_item_decisions` cannot express an attempt

`management_item_decisions` (draft 004) is append-only and records `approve | reject | edit |
delegate` with `authority_level` and actor. It has **no `execute` value and no attempt, result or
failure columns**. `management_cycle_runs` (draft 011) records cycles, not actions.

There is nowhere to record *"this approved action was attempted, at this time, with this outcome"* —
which is the requirement that prevents duplicate business effects. A new draft unit is needed.

### R2E-F-004 — enablement exists per company, but the kernel switch is global and env-driven

`management_kernel_enablement` (draft 011) is per-company, `enabled boolean not null default false`,
RLS-protected, revoked from `public`/`anon`. That is the right shape and R2E should reuse it.

The kernel's own switch is `kernelGloballyEnabled()` — `MANAGEMENT_KERNEL === "on"`
(`src/kernel/cycle.ts:849`). An environment variable is deployment configuration, which the standing
constraints treat as an owner-approved production boundary. R2E's execution switch must follow
`worker-boundary.ts` instead, not this pattern.

---

## 3. Mechanisms R2E reuses rather than reinvents

| Mechanism | Where | Why it is the right one |
|---|---|---|
| `WORKER_ENABLED = false as const` | `src/kernel/worker-boundary.ts:18` | Hard-coded, **not** an env var, so no deployment configuration can turn it on; refuses loudly with `WorkerDisabledError`; scope comes from the server's enablement table and cannot be passed in by a caller. Precisely the posture R2E requires. |
| `management_kernel_enablement` | draft 011 | Per-company, default false, RLS. |
| `assertTransition` | `src/kernel/lifecycle.ts:161` | Illegal transitions **throw**; terminal states are closed; reason and evidence requirements enforced. |
| `writeAuditStrict` | `src/lib/audit.ts:85` | Fail-closed: throws `AuditError`, so an unaudited mutation is never reported as done. Execution attempts must use this, never `writeAudit`. |
| `resolveRequiredAuthority` + `higherOf` | `authority-engine.ts` / `recommend.ts:101` | Max-of-all-rules; the catalogue floor can only raise, never lower. |
| Outbox lease pattern | `0040_durable_messaging.sql` | `FOR UPDATE SKIP LOCKED`, lease expiry, recovery, dead-lettering. |
| `assertActionRegistered` / `assertInternalOnly` | `src/kernel/invariants.ts` | Already re-checked at proposal time; must be re-checked again at execution time. |

---

## 4. Action matrix

Every catalogue action, as the system stands. **"Existing command/handler" records what is there —
not what could be written.**

| # | Action id | Intended effect | Existing command/handler | Capability | Approval required *today* | Risk | Rev. | Int/Ext | Idempotency | R2E disposition | Evidence | Stale check | Audit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `ops.task.create_internal` | create an internal task | **partial** — `createTask(FormData)`, unusable (F-002) | `operations.task.manage` | `manager_approval` | low | yes | internal | none | **candidate** for local execution via a new typed command | ≥1 ref | task not already created | `task.created` (soft) |
| 2 | `ops.task.reminder_internal` | internal reminder | **none** | `operations.task.work` | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | task still open | none |
| 3 | `ops.task.request_progress_update` | ask for progress | **none** | `operations.task.work` | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | task still open | none |
| 4 | `ops.task.escalate_internal` | escalate overdue work | **none** — `modules/work/follow-up.ts` computes a target, does not act | `operations.task.manage` | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | still overdue | none |
| 5 | `finance.invoice.flag_for_review` | flag invoice for a human | **none** | finance | `specialist_approval` | med | yes | internal | none | draft-only | ≥1 ref | invoice still unpaid | none |
| 6 | `crm.followup.draft_for_human` | draft a follow-up *for a person* | **none** | crm | `manager_approval` | med | yes | internal | none | draft-only | ≥1 ref | conversation still open | none |
| 7 | `workforce.capacity.review_allocation` | request allocation review | **none** | workforce | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | overload persists | none |
| 8 | `governance.directive.chase_internal` | chase a directive | **none** | governance | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | directive open | none |
| 9 | `objectives.objective.review_internal` | request objective review | **none** | objectives | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | objective off-track | none |
| 10 | `marketing.campaign.review_internal` | request campaign review | **none** | marketing | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | campaign live | none |
| 11 | `procurement.stock.review_internal` | request stock review | **none** | procurement | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | stock still low | none |
| 12 | `assets.document.schedule_renewal_internal` | schedule a renewal | **none** | assets | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | not yet renewed | none |
| 13 | `legal.obligation.escalate_internal` | escalate an obligation | **none** | legal | `specialist_approval` | high | yes | internal | none | **prohibited** locally | ≥1 ref | obligation open | none |
| 14 | `providers.provider.review_internal` | request provider review | **none** | providers | `manager_approval` | med | yes | internal | none | draft-only | ≥1 ref | engagement active | none |
| 15 | `system.health.investigate_internal` | raise an internal investigation | **none** | system | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | signal still failing | none |

Notes on the columns that matter:

- **"Approval required *today*"** is the *measured* resolution, not the catalogue's `authorityFloor`.
  For rows 1–4 and 15 the catalogue says `automatic`; the engine says `manager_approval` with
  `failedClosed`. Where they disagree, the measured value is what the system does (R2E-F-001).
- **Idempotency: none.** Not one catalogue action has an idempotency key, a natural unique
  constraint, or a dedupe path. The accounting core has `unique (company_id, idempotency_key)`
  (`0002`, `0003`); the kernel has no equivalent. R2E must supply it.
- **Audit: none**, for 14 of 15. Only row 1's underlying form action writes an audit event, and it
  writes it softly.
- **Evidence** is already enforced upstream — `recommend.ts` throws `InvariantViolation`
  (`zero_evidence`) before an action can be proposed at all. R2E must re-check at execution time,
  because approval and execution are separated in time.

---

## 5. What Batch 1 changes

Nothing in product behaviour. One test is added (`tests/r2e-authority-probe.test.ts`) pinning the
measured authority classification of all 15 actions, so that R2E-F-001 cannot change silently.

---

# Batch A audit addendum (2026-09-05) — gaps exposed by the owner's ten conditions

The owner's decision authorises `ops.task.create_internal` as potentially automatic, subject to ten
conditions that must each be independently true. Four of those conditions had nothing enforcing them.
Each was reproduced before any code changed.

### R2E-F-005 — the idempotency key is caller-supplied, which makes it a bypass

`ExecutionRequest.idempotencyKey` is a caller field (`contract.ts:114`). A caller that varies the key
gets a second execution of the same approved decision; a caller that reuses one across different
decisions collapses two distinct actions into one.

Condition 9 requires a durable identity, and the owner requires it **derived** from company,
management item, decision/approval version, canonical action and canonical parameter hash. A value
the caller chooses is none of those.

**Fix:** the key is computed inside the trusted boundary, after the approval and item are loaded,
from server-held values only. It is removed from the request type, so a caller has nowhere to put one.

### R2E-F-006 — nothing checks that evidence is still the evidence that was approved

There is no generation, version or digest anywhere in `src/kernel/execution/*`. The executor checks
`evidenceCount >= 1` — that *some* evidence exists, not that it is *the same* evidence.

An approval given against three overdue invoices can therefore be executed after all three are paid
and replaced by three unrelated ones. The count is still 3 and the item is still `approved`.

Condition 4 requires the evidence generation to be current. **Fix:** the approval records the
generation it was granted against, the item reports its generation now, and they must match. For an
automatic action there is no approver, so the comparison is between the generation the
recommendation was computed from and the generation now.

### R2E-F-007 — action parameters reach the handler unvalidated

`parameters` is `Readonly<Record<string, unknown>>` and does not appear in `executor.ts` at all: it
is passed through to the handler untouched. The handler coerces with `String(req.parameters.title ?? "")`.

Condition 7 requires a strict typed schema. Nothing enforced one, and nothing prevented an
`assignedTo` key from riding along in the parameter bag — harmless only because the RPC happens not
to accept one, which is a property of a different file.

**Fix:** a strict per-action Zod schema, keyed canonically, validated inside the boundary before the
handler is reached. Strict means unknown keys are rejected rather than ignored.

### R2E-F-008 — there is no runtime entrypoint

`executeApprovedAction` is imported by nothing outside `src/kernel/execution/`. R2E delivered a
library, not a path the running system can take. Condition 1 speaks of a "compile-time/server
execution boundary", which implies a server surface that the boundary actually guards.

**Fix:** one server execution service that assembles the real dependencies, is the only production
entrypoint, and refuses before touching anything while the boundary is closed.

### R2E-F-009 — an automatic action has no human creator, and the schema said it must

Found by running the real service, not by reading: `createInternalTask` required `createdBy` to be
a uuid, so the automatic path — which has no approver by definition — failed with
`invalid_input: createdBy`.

The stubbed unit tests could not have found this. They passed a `UserId` because the harness had
one to give; only the real service, which reads the approver from the decision record and finds
none for an automatic action, produced the null.

**Fix:** `createdBy` is nullable. `tasks.created_by` is already nullable, so the fact that nobody
authored this task can be recorded as such. The alternatives were worse: attributing it to a
fabricated system user, or to whoever happened to trigger the cycle, would put a name against a
decision that person did not make.

### Product guards that the stubbed tests had hidden

Three constraints only appeared when the tests drove real tables. None is a defect; each is the
product working, and each had been silently bypassed by a stub:

- `management_item_evidence` is **append-only** — the "evidence changed" case cannot UPDATE a row,
  so the generation changes by accretion, which is what actually happens when a detector observes
  something new after a recommendation was computed.
- `management_items_outcome_ck` requires an outcome for terminal states, so a test cannot seed
  `rejected` without also seeding a contradiction.
- `management_items.state` may only move through `r1_draft_transition_item()`; a direct UPDATE is
  refused by the transition boundary. The correction path in the tests now goes through the real
  lifecycle function, as production would.

### R2E-F-010 — the executor read a column nothing writes, and my own test agreed with it

`management_items` carries **two** columns for the proposed action: `proposed_action` (draft 001)
and `proposed_action_id` (draft 009). Only the second is ever written — the kernel's atomic create
RPC populates it (`R1_DRAFT_012`, line 129) and **nothing populates the first**.

The executor's item loader read `proposed_action`. Every item the kernel actually creates would
therefore have looked actionless, and every real execution would have refused with `stale_state`.

**This was a false pass I introduced.** The integration test seeded `proposed_action` — the same
wrong column the reader read — so the fixture and the code agreed with each other and neither
agreed with the product. The existing `ManagementQueuePanel` reads `proposed_action_id`, which is
what exposed the discrepancy.

**Fix:** the loader reads `proposed_action_id`, the fixtures seed it, and a new test creates the
item through the **real** `r1_draft_create_management_item` RPC so the column choice is proven by
the product rather than by the fixture. Verified discriminating: restoring the dead column fails 7
tests, including the kernel-seeded one that does not depend on the fixture at all.

Reaching the real RPC required satisfying four guards the seeded fixtures had been bypassing — a
service-role **JWT claim** (not merely the database role), an actor with an **active membership**,
an observation source on the RPC's **closed allowlist**, and the RPC's own jsonb return envelope.
Each is the product working; each had been invisible while the tests wrote rows directly.

---

# Batch B audit (2026-09-05) — the management surfaces

### R2E-F-011 — no approval or rejection can be recorded through any runtime path

A repository-wide search for writers of `management_item_decisions` or callers of
`r1_draft_transition_item()` outside `src/db/` and `src/kernel/execution/` returns **nothing**. The
only mention in application code is a comment.

`ManagementQueuePanelContent` renders `approved`, `rejected` and `dismissed` states and reasons
about whether "the current viewer may record feedback and accept or reject a suggestion" — but
there is no server action, route or command behind that question. The management queue is
**read-only in fact**, whatever the interface implies.

> **⚠️ CORRECTED 2026-09-05 (R2-F-014).** The paragraph below was **wrong**, and wrong in the
> dangerous direction. It read: *"`management_item_decisions` has a read policy and no INSERT
> policy at all, so an authenticated session cannot record a decision even if a form existed."*
>
> Draft **007** creates `management_item_decisions_ins` — `for insert to authenticated with check
> (has_capability(company_id, 'operations.task.manage'))`. Any authenticated manager could already
> write a decision row **directly**: unbound to any item state, with no lifecycle transition and no
> audit event. The log could therefore say `approve` while the item stayed in `awaiting_approval`
> for ever, and the two never had to agree.
>
> The error came from grepping draft 004 alone and concluding from one file what was true of the
> schema. It was found by a test that attempted the direct insert and watched it **succeed**.
> Draft 022 drops that policy; see R2-F-014 below.

**Consequence for R2E.** The executor's approval path — `loadApproval`, `approval_superseded`,
`approver_lacks_capability` — reads a table that nothing writes. Those branches are exercised only
by injected snapshots. For the one action the owner authorised, approval is not required, so the
gap does not block R2E; it blocks every future action that needs a human.

### R2E-F-012 — the queue shows management state but no execution state

`ManagementQueuePanel` reads items, evidence, transitions and observation sources. It does not read
`management_execution_attempts`, so an operator cannot see whether an approved action was attempted,
refused, executed or failed — the record R2E exists to produce is invisible to the people it is for.

### R2E-F-011 disposition — BLOCKED, needs owner authorisation for a new quarantined draft unit

The approval and rejection controls Batch B asks for cannot be built under this session's
containment, and this is a genuine blocker rather than a scoping choice.

Recording a decision requires a write to `management_item_decisions`. That table has a read policy
and **no INSERT policy**, so an authenticated session cannot write one; and `management_items.state`
may only move through `r1_draft_transition_item()`, which is a service-only boundary. Either route
therefore needs schema work:

- a service-only `SECURITY DEFINER` decision RPC — a **new quarantined draft unit (022)**; or
- an INSERT policy on the decisions table — also a migration.

The standing containment for this session says **"do not number or apply the quarantined draft
migrations"**. Draft 021 existed because the owner authorised it explicitly ("a minimal quarantined
execution ledger is authorised"). No equivalent authorisation covers a decision unit, so one is not
created.

**What this costs.** The management queue stays read-only in fact. For R2E specifically it costs
nothing: the single action the owner authorised resolves to `automatic`, so no human approval is
required for it. It blocks every future action that does need a human, and it is the natural first
piece of R2F.

**What would unblock it.** Owner authorisation for one further quarantined draft unit containing a
service-only decision RPC that validates active membership and capability, requires a reason for
`reject`/`dismiss`, respects the existing no-self-approval trigger, and performs the decision insert
and the lifecycle transition in one transaction.

### R2E-F-013 — the exact-action check in the automatic gate was untested

Found by mutation, not by reading. Deleting `actionId === AUTOMATIC_ACTION_ID` from the automatic
predicate broke **no test** — the mutation SURVIVED.

The reason is subtle and is exactly why mutation testing earns its place: the only action whose
policy floor is `automatic` is already the authorised one, so the remaining conjuncts excluded
everything else and masked the missing check. The guard was doing real defensive work — it is what
stops a second action that acquires an `automatic` floor from also acquiring automatic execution —
and nothing was watching it.

**Fix:** the predicate is extracted as `isGenuinelyAutomatic`, so it can be asked about inputs the
live table cannot currently produce — a SYNTHETIC policy in which a different action carries an
automatic floor, which is precisely the mistake it defends against. Each of the six conjuncts is
now removed one at a time and asserted to be load-bearing.

Re-running the same mutation now fails, naming the case: *"another action with an automatic floor:
expected true to be false"*.


---

# R4/R5 findings (2026-09-05) — building the decision boundary

### R2-F-014 — the decision log was directly writable, and the audit said it was not

Draft 007's `management_item_decisions_ins` policy let any authenticated holder of
`operations.task.manage` insert a decision row directly. That is not a smaller version of the RPC;
it is a way past all of it — no binding to the item state, action or evidence the person saw, no
lifecycle transition, no audit event, and the actor, company and authority level all whatever the
payload said.

Found by a test that performed the insert and asserted the row's **absence**, rather than asserting
that an exception was thrown. The insert succeeded silently. Had the test only expected a throw and
stopped there, it would have reported the same failure with none of the diagnosis.

**Fixed** in draft 022 by dropping the policy — a tightening that removes a write path, grants
nothing, and changes no authority rule. Reads are untouched. Mutation M5 confirms the append-only
guard still holds; the new suite confirms a direct insert now writes nothing.

**The audit entry that got this wrong is corrected in place, above.**

### R2-F-015 — the decision controls were dead links

`Accept suggestion`, `Reject suggestion` and `Assign someone` were `<a href>` links to
`/app/command/queue/{id}/accept`, `/reject` and `/assign`. **None of those routes exists.** The
queue offered a person a decision and led them to a 404.

A control that cannot do the thing it names is worse than no control: it teaches people the system
is broken, and it hides the fact that nothing was recorded. Accept and Reject are now real buttons
calling the decision server action; the assignment link is replaced by an honest sentence, because
routing and assignment still have no runtime path.

### R2-F-016 — permission defaulted to "yes"

`QueueItem.viewerMayDecide` was optional, the server **never set it**, and the component read
`item.viewerMayDecide !== false` — so an unset flag meant permission. Every viewer, including staff
with no approval capability, was shown decision controls.

Combined with R2-F-014 that was a complete path: the interface offered a decision to someone who
should not have one, and the database would have accepted a direct write from anyone holding an
unrelated capability.

Now resolved server-side from the repository's own `has_capability`, failing closed on any error,
and the component requires `=== true`.

### Unresolved authority cases, recorded rather than invented

Two cases have no rule in this repository, and the RPC **fails closed** on both rather than
choosing one:

- **`specialist_approval` and `owner_approval`.** These levels exist in the TypeScript authority
  vocabulary and in **no** database rule. `authority_ceiling` and `within_authority` are
  amount-based; no permission distinguishes a specialist or an owner from an ordinary approver.
  Recording such a decision would assert an authority the system cannot verify.
- **`dismiss`, `edit`, `delegate`, `postpone`, `route`, `request_evidence`.** The existing decision
  guard anticipates all six and requires reasons for them, but the permission table defines no
  capability that authorises any. The UI therefore offers Approve and Reject only.

Both need an owner decision. Neither is worked around.
