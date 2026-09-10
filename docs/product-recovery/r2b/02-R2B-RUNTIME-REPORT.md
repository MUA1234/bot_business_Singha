# R2B runtime integration — consolidated report

**Local-only. No merge, no deploy, no hosted contact, no live AI, no message sent, no financial
effect, no production migration number, no points/auction, no automated assignment, discipline,
pay or termination, no R2C.** No staging or production readiness is claimed anywhere.

## SHAs

| Checkpoint | SHA |
|---|---|
| 1 — financial delegation correction (Decision 1) | **`c8adfd9`** |
| 2 — resolver wired into the cycle (Decision 2) | **`c153d04`** |
| 3 — feedback runtime path (Decision 3) | **`5054ac8`** |
| 4 — spatial presentation | **`c19e19b`** |
| 5 — end-to-end learning proof (Decision 4) | **`ad5903f`** |
| 6 — independent adversarial review + corrections | **`8f98ee6`** |
| Final verification SHA (all evidence below) | **`75a0010`** |

## Decision 1 — the financial delegation defect is closed

    effective delegated ceiling = MIN(delegation ceiling, delegator's valid DIRECT ceiling)

Before this, `checkAuthority` honoured a delegation on its own word: a manager whose own ceiling
was LKR 50,000 could write a delegation granting LKR 5,000,000 and it approved. **"Direct" is the
load-bearing word** — authority a delegator holds only *by* delegation is borrowed, and borrowed
authority may not be delegated onward, or a chain of three people launders a small ceiling into
an unlimited one.

The rule lives in one new module, `src/modules/identity/delegation-authority.ts`, providing both
halves the owner required: `validateDelegationGrant` (creation time) and
`resolveDelegatedAuthority` (exercise time). **A grant valid when written is revalidated, not
trusted** — between creation and use the delegator may have been revoked, lost the domain, or had
their ceiling cut.

Every requirement, each with tests: inactive, revoked, expired, not-yet-started, cross-company
(delegation *and* delegator) and out-of-scope (delegation domain *and* delegator domain) refused;
re-delegation refused; unscoped delegation invalid; separation-of-duties and self-approval
evaluated **before** any delegation is considered and never overridable by one; direct and
delegated authority **distinguished and recorded** (`via`, `delegationId`, `effectiveCeiling`,
`boundBy`, `refusalCode`); a delegate's own direct authority still works even when their
delegation is expired *and* over-granted; exact `Decimal` throughout, including 2^53+1 against
2^53 to prove no float rounding; fail-closed on unknown, contradictory or unreadable evidence.

**No amount is ever silently reduced** — asserted that a refused verdict cannot even carry an
approved-but-smaller figure.

**Fail-closed is a deliberate behaviour change.** A delegation offered *without* the delegator's
authority and the delegate's live standing is now refused (`delegator_evidence_absent`). One
existing test relied on the old behaviour; it was updated to supply the evidence, and a new test
pins the fail-closed path.

**Duplication guard.** The MIN rule now exists in two places — the financial path and capability
routing — because they answer adjacent questions and merging them would force each caller to
carry the other's fields. Since R2B exists largely *because* one rule had two implementations
that disagreed, a **72-cell matrix test** sweeps amounts and both ceilings through both and
asserts they always agree.

**Mutation-checked:** disabling the delegator-ceiling comparison turns five tests red.

## Decision 2 — capability resolution in the cycle

`runManagementCycle` now resolves candidates for every item with a registered proposed action and
persists an append-only snapshot **in the same transaction** as the item, its evidence, its
opening transition and its audit row.

**Recommendation only, structurally.** The create RPC accepts **no accountable owner at all**, so
there is no shape in which a cycle can assign anyone, grant authority, alter workload, notify a
consultant, send anything or perform work.

**Draft unit 014** (quarantined, no production number) adds `management_item_recommendations` and
a v2 RPC that **calls** the existing create RPC rather than reimplementing it — unit 013 already
replaces that function's body, and a copy would drift the moment either was edited.

**What is deliberately not stored:** no protected attribute, no coaching note, and **no opaque
universal score**. `suitability` is an ordering value for one request; persisted against a person
it becomes a rating with a history. The **order** (`rank_position`) and the **reasons** survive —
those are what a manager can argue with. The full **rejected list** is also dropped: "excluded
because overloaded" rows accumulate into exactly the performance file the owner ruled out. A
database trigger refuses protected keys *and* score-like keys by name.

**Every failure mode is recorded truthfully, never as a candidate:** no eligible candidate,
evidence unavailable, stale capability data, unregistered action and resolver failure each
produce a `needs_routing` snapshot naming the **department** and an exact reason code. There is
no branch that returns an unchecked candidate.

**A real design error of mine, caught by test:** I required the *assignee* to hold the item's
*approval* authority. That is the level needed to approve the action, not to do the work — it
would have meant only people senior enough to approve something could be recommended to do it.
Assignee resolution now passes `automatic`; approval authority is checked separately, against the
approver, at approval time.

## Decision 3 — the feedback runtime path

`management_item_feedback` had existed since R1 and **nothing ever wrote to it**. Draft unit 015
gives it a door that carries the rules, all enforced in the database and tested live:

- actor and company **server-derived**; cross-company feedback fails, and a company-A member
  cannot reach a company-B item by claiming company B either;
- the actor must be an **active** member holding a task capability;
- `actor_type` is **fixed** to `user` inside the function — no parameter can label a model claim
  as human;
- **a verified outcome requires the lifecycle evidence** — `outcome_successful` is refused unless
  the item actually reached `verified`;
- **reopened work is not successful completion**;
- **one manager cannot fabricate hundreds of outcomes** — a daily cap plus a refusal of a second
  entry of the same type for the same item unless it is an explicit correction;
- **corrections supersede without deleting**, may not cross items or companies, and a row may be
  corrected only once;
- append-only; comments bounded at 2000 characters with control characters stripped — and the
  code does **not** claim to sanitise meaning: markup is preserved as text and always *rendered*
  as text, because pretending to neutralise content invites a caller to render it as HTML;
- **feedback changes no authority, role, membership status, pay or employment** — asserted by
  comparing roles and status before and after.

**A documented behaviour change:** an R1 test asserted staff could insert feedback directly under
an RLS policy. Feedback is now RPC-only, which is strictly stronger — the lifecycle-evidence,
reopened-work, company-boundary and burst rules cannot be expressed as an RLS policy. The test's
intent is preserved and still proven.

**The missing task fields are recorded as a schema gap, not worked around.** `tasks` has no
`completed_at`, `verified_at` or `verified_by` (finding F-R2B-1). `tasks.updated_at` is **not**
used as completion evidence anywhere. Deadline performance is derived only from
`management_item_transitions`, and is null for ordinary tasks.

## Decision 4 — the end-to-end learning proof

All eight steps through the **real** runtime — `runManagementCycle` with `makeCycleDeps`, the
real feedback RPC and the real fold — against the full schema with real RLS and real identity
functions. Nothing is stubbed but the HTTP transport to the database.

1–3. A real overdue task is detected, candidates resolved, an explainable recommendation
persisted naming who, in what order, why, and under which versions — and **nobody is assigned**:
`accountable_owner_id` is null on every item the cycle created, asserted directly.
4\. A human records `recommendation_accepted` through the real path, and only then is anyone
accountable.
5–6. Work reaches `verified` through the RPC-only lifecycle; `outcome_successful` is appended.
7–8. A later cycle reads that history **through the production loader**, and the recommendation
**changes**: a proven candidate and a newcomer rank **equal** with no history, and the proven one
is ordered first once three verified outcomes from three distinct deciders exist — with a reason
naming the confirmed-outcome count, the deciders and the rule version. **The newcomer is not
pushed down**: absence of history moves nobody, asserted by equality.

Also proven live: cross-company history invisible to both fold and loader; 150 fabricated
duplicates collapse to **one**; contradictory feedback makes no adjustment; a correction
supersedes rather than double-counts; protected-attribute injection refused before anything is
written; approved leave excludes for the day and leaves **no** learning trace; no skill is ever
verified; recommendation history append-only and free of protected attributes and person scores.

## UI

The existing spatial window now shows suggestions with reasons, evidence, confidence,
availability, missing or unverified skills, the truthful no-suitable-candidate state, **accept /
reject / override** controls, and the feedback and outcome history. Every control is a **link** —
the panel emits no `<form>`, no submit control and no `<button>` at all. A superseded feedback
entry stays **visible** and marked. Comments render as escaped text. A viewer who may not decide
sees neither the controls nor the history. **The derived learning signal itself is not
displayed** — what was *recorded* is disputable evidence; the fold's *output* is a number about a
person and would recreate the universal rank by another route.

## Defects found

**In existing code:** R2B-F-001 — now closed on **both** paths.

**In my own runtime work**, each reproduced before being fixed, each with a regression test:

| | |
|---|---|
| **R2B-F-007** (security) | **Feedback could name a subject in another company.** The RPC validated the item's company and the *actor's* membership — but the actor and the subject are different people, and `subject_membership_id` had no check at all. A manager could record an unsuccessful outcome against someone in a company they have no relationship with, feeding *that* company's fold |
| **R2B-F-008** | **Candidate evidence and outcome history were loaded once per observation.** Beyond the cost, it made a sweep internally inconsistent — two items could be judged against a company that changed between them. Now loaded once per cycle, failures cached too |
| **R2B-F-009** | **`assertSnapshotSafe` was never called.** The guard against persisting a person-level score was written, exported, unit-tested in isolation, and invoked by nothing on the production path |

**Four defects in my own tests and fixtures**, all fixed rather than worked around: a direct-insert
refusal asserted while connected as the `postgres` superuser (for whom the guard correctly does
not fire) — it passed the insert while claiming to prove a boundary; a concurrency test running
two cycles on **one** connection, where the session-scoped advisory lock let both succeed; a
premise that `verified → reopened` was possible when `verified` is **terminal**; and a
system-health fixture returning `[]` to an adapter that takes a shaped object.

## Test totals at `75a0010`

| Suite | Before this programme | After |
|---|---|---|
| Full unit suite | 1825 / 200 files | **2005 passed, 0 failed, 4 skipped / 204 files** |
| Kernel (incl. people) | 365 | **483** |
| Live full-schema | 135 / 6 files | **172 / 8 files** |
| Spatial | 126 | **136** |
| Kernel under the outbound network guard | 365 | **483** |
| Live draft apply + rollback | 31 | 31 |

`verify` exit 0 · typecheck clean · lint 0 errors · build compiled · browser-check passed ·
secret-scan clean · migration-lint 109 sequential, no gaps · IP boundary clean · autonomy audit
consistent · accessibility suite passing.

## Requirement status

| ID | From | To | Evidence |
|---|---|---|---|
| **WRK-005** Fair assignment | `implementation_in_progress` | **`locally_verified`** | On a runtime path; eight-step E2E passes |
| **IMP-001** Outcome recording against recommendations | `absent` | **`locally_verified`** | Recommendations recorded; what actually happened recorded against them |
| **IMP-002** Staff feedback and lessons learned | `implementation_in_progress` | **`locally_verified`** | The fold now has both a runtime input and a runtime reader; the owner's bar met by test |
| **WRK-007** Advisor/delegate/consultant | *(held)* | `implementation_in_progress` | **The cycle requests `roles: ["assignee"]` only.** Nothing in production recommends an advisor, delegate or consultant, so this is not verified however complete the code is |

**`locally_verified` 63 → 66. `absent` 23 → 22. Staging and production remain ZERO.**

## Remaining limitations

- **Local only.** No staging, no production, no readiness claim.
- **WRK-007 is not on a runtime path** — the cycle asks for assignees only.
- **Draft units 014 and 015 have no production migration numbers** (R1-D-1), and cannot until
  PR-F-001 and PR-F-004 close.
- **Task completion timestamps are still missing** (F-R2B-1) — recorded as a schema gap for
  migration reconciliation.
- **No verified-skill source and no staff language source exist** anywhere in the schema, so
  those gates refuse by design rather than guessing.
- **Team formation** (composing a group) is not implemented.
- **The kernel still does not act.** No executor exists; `may_run_unattended` is computed and inert.
- **No scheduler is registered.** The manual route is the only entrypoint.
- Deployment blockers unchanged: PR-F-004, PR-F-001, PR-F-014/R0-F-007, R0-F-001, PR-F-002/003.
