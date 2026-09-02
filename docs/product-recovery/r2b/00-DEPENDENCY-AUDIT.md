# R2B checkpoint 1 — dependency audit and capability architecture

**Local-only.** No hosted contact, no deploy, no merge, no migration renumbering, no live AI.
Read before implementation, as the owner required.

## 1. Input inventory and evidence classification

Every input the owner named, classified by what the schema can actually prove. **Nothing
inferred or self-declared is treated as verified anywhere in R2B.**

| # | Input | Where it lives | Class | Note |
|---|---|---|---|---|
| 1 | Memberships and roles | `memberships`, `membership_roles`, `roles`, `role_permissions` | **verified** | System of record, RLS-scoped, capability-gated writes |
| 2 | Capabilities and authority | `has_capability()`, `authority_rules` (0010/0023), `approval_policies`, `src/policy/authority-engine.ts` | **verified** | Deterministic ladder, fails closed on missing policy |
| 3 | Skills and qualifications | `employee_profiles.skills text[]` | **self-declared / manager-entered** | **No verifier, no evidence reference, no expiry, no issuing authority.** A bare text array. |
| 3b | Person-level expiring qualification | `drivers.licence_number`, `drivers.licence_expiry` | **manager-entered** | The ONLY person-level expiring credential in the schema — and `drivers` has **no FK to `memberships` or `profiles`**, so it cannot be joined to a candidate |
| 4 | Staff availability | derived from 5 + 6 | **inferred** | Computed, never stored as truth |
| 5 | Approved leave | `leave_requests` (`status='approved'`, `decided_by`, `decided_at`) | **verified** | A recorded human decision with a decider and a timestamp |
| 6 | Workload and capacity | `capacity_snapshots` (weekly), `task_assignments.estimate_hours`, `tasks.actual_hours`/`remaining_hours` | **inferred**, and **stale-able** | `capacity_snapshots.week_start` is weekly; a snapshot older than the current week is stale and must be declared so |
| 7 | Department and company | `memberships.company_id`, `membership_assignments` to `organisation_units` | **verified** | |
| 8 | Task requirements | `tasks`, `task_routing.required_capability` (0072) | **partially absent** | A required *capability* exists on the routing row. There is **no required-skill, required-language or required-qualification field on a task at all.** |
| 9 | Language preference | — | **ABSENT** | `communication_preferences` (0104) is a **customer** channel/opt-out/handover record keyed on `(company, channel, identity)`. It has no language column and no staff link. No table anywhere stores a staff language. |
| 10 | Previous assignments | `task_assignments`, `task_routing` (`is_active`, `superseded_by`, `proposed_assignees`), `management_items.recommended_resource_id` | **verified** | Records of what actually happened |
| 11 | Verified outcomes | `management_item_transitions` reaching `verified` (append-only, `actor_id`, `actor_type`, `reason`, `evidence`) | **verified** for kernel items | |
| 11b | Task-level outcome and deadline performance | `tasks` | **ABSENT** | **`tasks` has no `completed_at`, no `verified_at`, no `verified_by`.** Status can reach `completed`, but *when* is not recorded, so **on-time performance cannot be computed against `due_date`** at task level. `task_evidence.verified_by` verifies one *evidence item*, not the outcome. |
| 12 | Coaching / development | — | **ABSENT** | `ai_guide_messages` (0097) is per-task guidance with a visibility rule, not a development record |
| 13 | External provider / consultant records | `service_providers`, `suppliers`, `counterpartyHealth`, `providerHealth` | **verified** for compliance and insurance; **absent** for skills and performance | CRM-004 |
| 14 | Management-item feedback | `management_item_feedback` (draft 006 — append-only, `proposed`/`actual`, `reason`, `actor_type`) | **verified provenance**, **write-only today** | Nothing reads it. This is exactly what IMP-002/003 require and R2B supplies. |

### The two findings that shape the design

**F-R2B-1 — deadline performance is not computable from `tasks`.** The owner listed "confirmed
deadline performance" as a permitted learning input. The schema cannot supply it for tasks: there
is no completion timestamp. R2B therefore derives deadline performance **only** from
`management_item_transitions`, which does carry an append-only timestamped transition into
`verified` alongside the item's recorded business deadline. Task-level performance is recorded
as an open gap, not approximated from `updated_at` (which any edit moves).

**F-R2B-2 — no skill in this system is verified.** `employee_profiles.skills` is an unqualified
text array. The owner requires "required verified skills where mandatory". Since no verified skill
exists, **a task that mandates a verified skill must yield `needs_routing`, not a candidate
selected on a self-declared claim.** R2B implements the distinction now so that a future
verification source changes data, not logic.

## 2. What already exists and is reused unchanged

| Component | Reused for |
|---|---|
| `src/modules/work/availability.ts` — `isOnLeave`, `evaluateAvailability`, `selectBestAvailable` | The availability gate |
| `src/modules/work/capacity.ts` — `computeCapacity` | The capacity gate |
| `src/modules/identity/delegation.ts` — `isDelegationActive`, `activeDelegationsTo`, `delegationPermits` | Delegate eligibility |
| `src/policy/authority-engine.ts` — `LADDER`, `higher`, `maxLevel` | The authority ceiling, unchanged |
| `src/modules/identity/can-act-on-task.ts` — `canActOnTask` | Separation of duties |
| `src/modules/crm/counterparty-compliance.ts`, `src/modules/crm/service-provider.ts` | External-consultant compliance gate |
| `task_routing` (0072) — `needs_routing`, `no_eligible_assignee`, `reason_code`, `proposed_assignees` | The no-candidate vocabulary and its reason codes |
| `management_item_feedback` (draft 006) | The learning input |

**A defect this audit found in reused code.** `delegationPermits` checks the delegation's own
ceiling (domain, currency, `max_amount`) and its window, but **never checks that the delegation
does not exceed the DELEGATOR's own authority.** A delegator with a LKR 50,000 ceiling can today
write a delegation granting LKR 5,000,000 and it is honoured. The owner's rule — "Delegation must
never exceed the delegator's authority" — is therefore not enforced. R2B adds that check as a
separate function rather than editing the existing one, so nothing already depending on
`delegationPermits` changes behaviour, and the composite gate is what candidate resolution uses.

## 3. Architecture

One shared service. Every management recommendation goes through it; there is no second path.

```
resolveCandidates(request, evidence)            src/kernel/people/resolve.ts
  |
  |-- 1. protected-attribute guard   protected.ts    ALLOWLIST, refuses at construction
  |-- 2. hard eligibility gates      eligibility.ts  fail-closed, per candidate
  |        company - active status - authority - capability - availability -
  |        approved leave - capacity - mandatory verified skill - compliance
  |-- 3. task-specific suitability   suitability.ts  explainable reasons, NO stored rank
  |        \-- derived learning signal  learning/signals.ts  (ordering + confidence ONLY)
  \-- 4. outcome                     needs_routing | candidates[] + humanReview[]
```

### Non-negotiable properties, each with the test that proves it

| Property | Mechanism | Proof |
|---|---|---|
| No universal employee rank | Suitability is computed per request and never persisted; derived signals are keyed by `(company, subject, capability, task-kind)`, never by person alone | A person suitable for kind A and unsuitable for kind B, from one evidence set |
| No protected attribute | **Positive allowlist** of evidence keys — anything not listed is refused when the evidence is constructed | Injecting `ethnicity`, `religion`, `marital_status`, `health` etc. throws |
| Approved leave never penalises | Leave sets `available=false` for **this request only** and emits **no** learning signal | A person on leave is excluded today and ranks identically tomorrow |
| Missing data never penalises | Absent evidence lowers **confidence** and populates `missingInformation`; it never subtracts suitability | A cold-start candidate ranks equal to a known one, at low confidence |
| Unverified feedback never penalises | Only rows with an identified human actor and a resolved item are eligible; `actor_type='ai'` is excluded | An unverified manager note changes nothing |
| Learning never touches authority | The authority ceiling is resolved **before** learning is consulted and is not an input to it | Identical authority with learning on and off |
| Delegation never exceeds the delegator | Composite check against the delegator's own resolved ceiling | An over-granted delegation is refused |
| No consultant gets internal access | Consultant candidacy returns a scope boundary, never a membership or a capability | A recommended consultant holds no company capability |
| Company isolation | The company is taken from the authorised request context and re-checked per candidate | A cross-company candidate is refused even when supplied in evidence |
| Deterministic rebuild | Signals are a pure fold over append-only history, with a rule version | Rebuilding from raw history reproduces identical signals |

## 4. Schema

**Preferred path: no new durable structure.** Everything in checkpoints 2 and 3 reads existing
tables and the R1 draft units.

Checkpoint 4 (learning) needs one durable structure, because a derived signal must be
**reproducible and rebuildable** and its **rule version** retained — the owner required both. It
is added as **quarantined R2B draft units only**, excluded from the production migrator, with
apply/rollback and isolation tests, and **no production migration number**.

## 5. Explicitly out of scope for R2B

Points/task auction (WMP), live AI, message sending, financial actions, staff discipline or
remuneration, R2C, and any claim about staging or production.
