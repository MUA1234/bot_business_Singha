# R2F-F-017 — the evidence contract matrix, before any edit

**Local-only.** No hosted contact, no deploy, no merge, no migration numbering.

The owner's instruction is explicit about the shape of the fix: *separate the evidence contracts;
do not force unlike record sets to compare equal.* This document establishes, field by field, what
each set is, who writes it, who reads it, and which comparisons are legitimate — before anything is
changed.

---

## 1. The two evidence sets, as they exist today

| | **Condition evidence** | **Eligibility evidence** |
|---|---|---|
| Question it answers | *why does this item exist?* | *why is this person a plausible assignee?* |
| Record | `management_item_evidence` rows | `management_item_recommendations.evidence_refs` |
| Written by | `r1_draft_create_management_item` (inside the atomic create), from the detector's `Observation.evidence` | `buildSnapshots` → `c.evidenceRefs`, produced by `evaluateEligibility` |
| Typical contents | `('tasks', <task id>)`, `('customer_invoices', <invoice id>)` | `('membership_roles', <id>)`, `('capacity', <id>)`, `('leave', <id>)` |
| Changes when | the business facts change — the invoice is paid, the task is closed | the *person's* facts change — a role is revoked, leave is approved |
| Digest today | `r1_draft_evidence_digest(company, item)` — `md5(string_agg(source_table||':'||source_id …))` | `recommendationGeneration()` in `execution/service.ts` — md5 over the snapshot's `evidence_refs` |

They are different record sets about different subjects. Neither is a version of the other.

## 2. The defect, exactly

`src/kernel/execution/executor.ts:320`

```ts
const decidedAgainst = approval ? approval.evidenceGeneration : item.recommendationGeneration;
if (decidedAgainst !== item.evidenceGeneration) refuse("evidence_stale");
```

* `item.evidenceGeneration` — **condition** digest.
* `item.recommendationGeneration` — **eligibility** digest.
* `approval.evidenceGeneration` — **condition** digest (computed by the same SQL function).

So the **approval** branch compares like with like and is correct. The **automatic** branch — the
only branch an executable action can take, because `ops.task.create_internal` requires no approval —
compares the condition digest against the eligibility digest. They cannot be equal, and a
`needs_routing` snapshot has no refs at all, which digests to the sentinel
`"no-recommendation-snapshot"`.

**Result:** no cycle-created item can ever execute an automatic action. Confirmed live in
`r2-operations-slice`, where the first attempt is refused `evidence_stale`.

**Why no test caught it:** `r2e-execution-ledger`'s fixture seeds the snapshot's `evidence_refs`
with the *item's* evidence pairs — a shape the runtime never produces. The suite therefore proves
the executor's arithmetic on a record shape that does not exist.

## 3. Producers and consumers — the complete list

### Condition evidence

| Site | Role | Notes |
|---|---|---|
| `r1_draft_create_management_item` (draft 012) | **producer** | inserts `management_item_evidence` in the same transaction as the item |
| `r1_draft_evidence_digest(company, item)` (draft 022) | **digest** | the one canonical function; SQL, server-side |
| `evidence-digest.ts` (`evidenceDigest`) | **mirror** | TypeScript reimplementation for the queue panel; pinned to the SQL one by a live test |
| `r1_draft_record_management_decision` (draft 022) | **consumer** | recomputes and compares against `p_expected_evidence_digest`; stores `bound_evidence_digest` |
| `r1_draft_claim_task_completion` (draft 026) | **consumer** | same, stores `bound_evidence_digest` |
| `execution/service.ts::evidenceGeneration` | **digest** | TypeScript reimplementation of the same SQL, over the same table |
| `verification/store-*.ts::evidenceGeneration` | **consumer** | calls the SQL function; used for the observation-after-claim rule |
| `executor.ts` | **consumer** | `item.evidenceGeneration`, and part of `deriveIdempotencyKey` |

### Eligibility evidence

| Site | Role | Notes |
|---|---|---|
| `people/eligibility.ts::evaluateEligibility` | **producer** | collects `evidenceRefs` from the gates that passed |
| `people/resolve.ts` | **carrier** | `evidenceRefs: outcome.evidenceRefs` |
| `people/snapshot.ts::buildSnapshots` | **producer** | `evidence_refs: c.evidenceRefs.map(...)`; **empty** for `needs_routing` |
| `r1_draft_create_management_item_v2` (draft 014) | **persister** | writes the snapshot rows |
| `execution/service.ts::recommendationGeneration` | **consumer** | ⚠️ digests these and hands the result to the *condition* comparison |
| *(nothing else)* | | no assignment path exists yet to consume it legitimately |

### Approval digests

| Site | Field | Set |
|---|---|---|
| `management_item_decisions.bound_evidence_digest` | condition | ✅ correct |
| `management_item_decisions.bound_action_id` | action | ✅ |
| `management_item_decisions.bound_parameter_digest` | parameters | ⚠️ **caller-supplied**, never recomputed — see §5 |
| `management_item_decisions.bound_state` | lifecycle state | ✅ |

### Parameter digest

| Site | Role | Notes |
|---|---|---|
| `execution/parameters.ts::canonicalHash` | **digest** | over the *validated* parameter object |
| `executor.ts` | **consumer** | folded into `deriveIdempotencyKey` only — **never compared against anything** |
| the decision RPC | **stores** | `p_expected_parameter_digest`, taken verbatim from the caller and stored |

**There is no plan.** Nothing decides an action's parameters before execution: the executor
validates whatever the caller supplies. So there is nothing for a stored parameter digest to be
compared *to*, and the decision RPC's stored value is a browser's assertion about a screen rather
than a server-derived fact.

### Policy version

Does not exist. `policy.ts` has no version identity, so "the policy changed under an approval" is
not expressible.

## 4. Which comparisons are legitimate

| Compare | Against | Verdict |
|---|---|---|
| current condition digest | condition digest stored at approval | ✅ correct, and already done on the approval branch |
| current condition digest | condition digest stored at recommendation | ✅ **this is the fix** |
| current condition digest | eligibility digest | ❌ **the defect** |
| current validated parameters | parameter digest planned at recommendation | ✅ once a plan exists |
| current canonical action | action stored at recommendation/approval | ✅ |
| current policy version | policy version stored at recommendation/approval | ✅ once a version exists |
| current eligibility digest | eligibility digest at recommendation | ✅ **at assignment only** — a stale candidate must not block creating an unassigned task |

## 5. What has to be added, and why each is unavoidable

| Addition | Why it cannot be derived from what exists |
|---|---|
| `condition_evidence_digest` on the snapshot | today the snapshot records *nothing* about the condition it was advice for |
| `eligibility_evidence_digest` on the snapshot | derivable from `evidence_refs`, but storing it makes the two sets namable and impossible to confuse at a call site |
| `action_id` on the snapshot | the item's `proposed_action_id` can be edited later; the advice was for a specific action |
| `planned_parameters` + `parameter_digest` on the snapshot | **no plan exists**; without one, "the parameters changed" cannot be detected at all |
| `policy_version` on the snapshot | no version identity exists; without one, "the rules changed" cannot be detected |

Every one is **derived server-side** from canonical records, per the owner's instruction. The
digests are computed inside the create RPC, in the same transaction that writes the evidence, so
no caller can assert one.

`resolver_version`, `signal_rule_version`, `fingerprint` and `candidate_ref` already exist and cover
the recommendation's own version identity and candidate identity.

**One term reconciled:** the owner's list names both "evidence generation" and the two digests. In
this repository the *generation* of a set of evidence **is** its content digest — that is what
`evidenceGeneration` means everywhere in `execution/` and `verification/`. There is no separate
generation counter for item evidence, and inventing one would add a second way to say the same
thing. The condition digest is the condition evidence's generation, and this document uses the two
words interchangeably for that reason rather than by oversight.

## 6. New refusal reasons

`RefusalReason` is a closed union, deliberately. Two members are added:

* `parameters_stale` — the validated parameters differ from the plan.
* `policy_version_changed` — the execution policy has changed since the advice was recorded.

Both are distinct from `evidence_stale`, because "the world moved" and "the rules moved" call for
different responses.
