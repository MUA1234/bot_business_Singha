# R2F — operational management-loop integration — audit and slice selection

**Local-only.** No hosted contact, no deploy, no merge, no migration numbering, no real data, no
live model, no message sent, no financial effect.

Baseline: branch `claude/product-recovery-r1`, HEAD `1876133`.

This is steps 1–4 of the owner's own preconditions: map each proposed change to an existing
requirement, register a finding for each missing runtime connection, reject anything without
traceability, and select the smallest complete end-to-end vertical slice.

---

## 0. A naming difference, recorded rather than resolved unilaterally

The owner's instruction names this phase **R2F**. **The approved roadmap
(`09-RECOVERY-ROADMAP.md`) does not contain R2F, or any R2x lettering.** It defines phases
**R0–R7**, and the work the owner describes — "one coherent AI-management loop" — is:

| Owner's R2F bullet | Approved roadmap |
|---|---|
| owner/CEO sees real cross-domain items and business health | **R4** — "Kernel queue surfaces in the Command Centre" |
| managers see recommendations, evidence, approvals, routing, execution status | **R4** + **R5** |
| staff see assigned work and Ask-AI, without wider management evidence | **R5** — AIM-009 |
| completed and verified work feeds the outcome/learning mechanism | **R5** — "Outcome verification by re-observation", learning store |
| all twelve domains visible through truthful summaries and drill-downs | **R6** — "Extend to every domain" |
| honest empty/partial/stale/disabled/denied/failure states | cross-cutting |

Per the owner's instruction — *"If the existing roadmap defines R2F differently, follow the existing
approved roadmap and document the difference. Do not invent a replacement roadmap"* — the work below
is traced to **R4/R5/R6 tasks and to registered requirement ids**. "R2F" is used only as the
session's label for it. No replacement roadmap is created.

One consequence is worth stating plainly: the twelve-domain bullet belongs to **R6**, which the
roadmap places *after* R5 closes the loop. Pulling it forward would widen the surface before the
loop it is meant to display is working.

---

## 1. What is already connected — verified, not assumed

| Capability | State | Evidence |
|---|---|---|
| Management queue reads real items, evidence, transitions | **connected** | `ManagementQueuePanel`, RLS-enforced `supabaseReadClient`, honest "unavailable" on failure |
| Twelve domains admitted by the schema | **connected** | draft 013 widens `management_items_department_check` to all twelve |
| Execution state visible in the queue | **connected (R2E Batch B)** | `management_execution_attempts` read, eight honest states |
| Outcome recording against recommendations | **`locally_verified`** | IMP-001, closed at `75a0010`, proven end to end through `runManagementCycle` |
| Staff Ask-AI with a visibility model | **built (R2D)** | AIM-009; fixture-proven only, not language-verified |
| Cockpit reads real business data | **connected** | `CommandCentrePanel` queries real tables |

Nothing below proposes rebuilding any of these.

---

## 2. Missing runtime connections — one finding each

### R2F-F-001 — the cockpit does not show management items at all

`CommandCentrePanel` reads `tasks`, `capacity_snapshots`, `purchase_orders`, `commitments` and
others. It does **not** read `management_items`. The only reader is `ManagementQueuePanel`.

So the owner/CEO cockpit shows *operational* data and none of the management system's own output:
what the system noticed, what it recommends, and what is waiting on a person are absent from the
screen the owner looks at first.

**Traceability:** roadmap **R4** — "Kernel queue surfaces in the Command Centre". Registered.

### R2F-F-002 — no decision can be recorded (carried from R2E-F-011)

Nothing writes `management_item_decisions`; the table has a read policy and no INSERT policy; item
state moves only through the service-only `r1_draft_transition_item()`. The queue is read-only in
fact.

**Traceability:** roadmap **R4/R5** — a manager acting "within their authority" presupposes a path
by which the action is recorded.

**Status: BLOCKED.** It needs either a service-only decision RPC (a new quarantined draft unit) or
an INSERT policy — both migrations, and this session's containment forbids numbering draft
migrations. Requires owner authorisation, as draft 021 had.

### R2F-F-003 — the queue is not scoped by the viewer's authority

`ManagementQueuePanel` filters by company and by non-terminal state. It does not filter by
department, by accountable owner, or by what the viewer's capabilities let them see. RLS is the only
boundary, and the draft RLS matrix (unit 007) is company-scoped.

The owner's requirement distinguishes three audiences — owner sees everything, managers see their
own domain, staff see assigned work **without** wider management evidence. Today the first two are
one view and the third has no view.

**Traceability:** roadmap **R5**; requirement **AIM-009**'s visibility model, and the standing
permission model.

### R2F-F-004 — verified outcomes are not fed back by RE-OBSERVATION

IMP-001 is `locally_verified`: outcomes are recorded and a later cycle reads that history. What the
roadmap additionally requires for R5 is *outcome verification by re-observation* — a task completed
but whose underlying condition persists must **reopen** the item rather than close it.

`lifecycle.ts` has the `reopened` state and the `verifying → reopened` transition. Nothing drives
it from a re-observation.

**Traceability:** roadmap **R5** — "Outcome verification by re-observation", "one that is completed
but whose condition persists **reopens**".

---

## 3. Rejected for lack of traceability

| Proposed | Why rejected |
|---|---|
| Any new external integration | Explicitly out of scope; no requirement |
| Points, credits, bidding, ranking | **WMP-002**, and the roadmap registers **WMP-003** (fairness and anti-surveillance guardrails) as a *blocker* on it, plus an explicit owner gate. Not startable |
| Work marketplace | **WMP-001**, gated behind WMP-003 |
| People analytics / surveillance-adjacent inference | Gated; WMP-003 unmet |
| Visual redesign of the workspace | No requirement; explicitly excluded |
| Broadening execution beyond `ops.task.create_internal` | The owner's decision authorises exactly one action |

---

## 4. The smallest complete end-to-end vertical slice

**Chosen: R2F-F-001 — surface real management items in the cockpit, scoped honestly.**

It is chosen over the others because it is the only one that is *complete* end to end within the
session's containment:

- **F-002 is blocked** on a migration authorisation this session does not have.
- **F-003** is partly blocked by the same thing: a staff-scoped view without a decision path shows
  people work they cannot act on, and the authority scoping belongs with the write path.
- **F-004** requires a re-observation driver in the cycle — a kernel behaviour change, which is
  larger than a slice and would land unproven at the end of a session.

The slice is: the cockpit reads `management_items` through the **existing RLS-enforced client**,
summarises them by department and state, and reports the same honest states the queue now
does — including "unavailable" when the draft tables are absent, which is their state on any
database where the R1 drafts have not been applied.

**What it must prove locally:** a real read path, real RLS, real empty/partial/unavailable states,
no cross-company leakage, and no new write surface.

**What it explicitly does not do:** add any control, widen execution, or introduce a second
management-item reader with its own query shape — it reuses the panel's contract.

---

## 5. Status

Steps 1–4 complete. Step 5 (prove the slice) is not started; the session's remaining budget is
committed to finishing R2E's verification and reporting. The slice is specified here so it can be
picked up without re-deriving it.
