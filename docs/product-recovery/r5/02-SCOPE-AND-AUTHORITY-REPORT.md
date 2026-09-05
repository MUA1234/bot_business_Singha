# R4/R5 — authority-scoped queue and the two higher authority levels — report

**Local-only.** No hosted contact, no deploy, no merge, no migration numbering, no real data, no
live model, no message sent, no financial effect. Staging and production remain **zero**.

## What changed

Two things, both enforced in the **database** rather than in React — so they hold for a direct API
call, a guessed item id and a hand-written query, not only for the screen.

### 1. R2F-F-003 — the queue is scoped by authority

Draft 007 gave all six R1 tables one SELECT policy: `has_company_access(company_id)`, which requires
an active membership **and nothing else**. Any member could read every management item in the
company and every evidence row attached to it — including the `legal` and `workforce` domains.

Draft 023 replaces those policies with one predicate, used by the item and by its evidence,
transitions, decisions and feedback, so the item and its contents can never disagree about who may
see them. The order is deliberate:

| | rule |
|---|---|
| 1 | no **active** membership in the item's company → nothing (this also covers cross-company) |
| 2 | **sensitive domain** (`legal`, `workforce`) → the domain capability, and no substitute |
| 3 | `management.queue.view_company` → visible |
| 4 | a department this person manages, by an exhaustive map → visible |
| 5 | their own accountable work (`accountable_owner_id` is *their* membership) → visible |
| 6 | otherwise → not visible |

**Step 2 comes before step 3 on purpose.** A company-wide viewer is not thereby entitled to
grievance or compliance evidence. "Separately capability-gated" has to mean separately from the
general permission too, or it means nothing.

`observation_sources` is deliberately **not** scoped. It carries no business content, and every
member needs it to know whether a department was observed at all — hiding it would turn a failed
detector into a silent all-clear, which is the defect the queue exists to avoid.

### 2. R2-F-017 — owner and specialist authority

The decision RPC had been refusing both levels because nothing in the database could establish
either for a user. Under the owner's decision:

**Owner approval** requires `management.decision.approve_owner` — a dedicated capability registered
in the existing `domain.object.verb` convention, granted to `owner_management` and the system
administrator only. Holding `approve` does not satisfy it, and a `project_manager` does not hold it.

**Specialist approval** requires the capability registered for the item's **own domain**, read from
an exhaustive map. Two of the twelve domains have one:

| domain | capability |
|---|---|
| `legal` | `legal.matter.manage` |
| `workforce` | `hr.staff.manage` |
| the other ten | **none** — the decision is unavailable and the refusal names the domain |

**`finance` is deliberately unmapped.** Its candidates are accounting-posting authority, and the
owner's authorisation explicitly does not widen financial or accounting controls.

**An owner does not automatically substitute for a specialist.** The map is consulted, not the role.
Where `owner_management` does pass a specialist gate, it is because migration 0038 *explicitly*
grants it `legal.matter.manage` and `hr.staff.manage` — an existing written authority rule, and the
test asserts that grant exists before relying on it.

**The six unauthorised decision types stay closed.** `dismiss`, `edit`, `delegate`, `postpone`,
`route` and `request_evidence` are refused for an owner exactly as for a manager, and are not
offered in the interface.

### 3. The interface matches the boundary

`viewerMayDecide` is resolved **per item**, because the authority an item needs is a property of the
item. An item requiring owner approval shows controls only to a holder of the owner capability; one
requiring specialist approval only to a holder of that domain's capability; and for the ten
unmapped domains, never — which is the same answer the RPC gives.

## Evidence

`tests/integration/r2-authority-and-scope.test.ts` — **25 passed**, real PostgreSQL 16, every read
as a real `authenticated` session with a real `auth.uid()`:

- staff see only their own accountable work, and **cannot read the evidence** of an item they cannot
  see — asserted as zero rows *and* the row proven physically present, so a policy refusal is not
  confused with an empty table;
- a manager sees the departments they manage and not the others; a multi-department holder sees each;
- an accountant sees finance and not operations;
- an owner sees cross-domain items **through the capability**, not through being an owner;
- sensitive domains are hidden from a company-wide viewer without the domain capability;
- an inactive membership sees nothing; cross-company sees nothing; a **guessed item id** returns
  nothing; a `count(*)` probe of a hidden department returns **0**, so no count, id, action or
  existence leaks;
- permission removed during an open session takes effect on the next read;
- empty and permission-denied are shown to be different facts — the company demonstrably has items
  the viewer cannot see.

Authority: an owner may decide an owner-approval item; an ordinary approver may not, and no decision
row is written; a transformed capability id (trailing space, uppercase, prefix, separator-stripped)
satisfies nothing; the wrong domain's specialist capability satisfies nothing; an unmapped domain is
refused by name.

## Limitations, stated

- **Advisor, delegate and consultant scopes are not implemented.** They are visible only where the
  person is the item's accountable owner. Engagement- and delegation-scoped visibility needs the
  recommendation-snapshot roles and is not attempted here. Recorded, not worked around.
- **The `management.queue.view_company` capability is granted only to `owner_management`.** No
  existing role gains anything it did not have.
- Nothing here widens financial authority, payment approval, accounting controls, delegation
  ceilings or separation-of-duties rules.

---

## A defect in my own mutation harness, found by disbelieving its answer

The first scope mutation run reported **all seven mutations SURVIVED**. That was not a result about
the tests — it was a defect in the harness, and it is worth recording because a mutation harness
that lies is worse than none: it certifies exactly the thing it was built to disprove.

**What gave it away** was the shape of the answer, not any single verdict. Seven independent
invariants do not all fail to be tested at once, and the reported pass counts *varied* between runs
(52, 53, 54, 55) while the failure count was always zero. Real suites do not change size.

**Reproduced before fixing.** Mutation S5 — owner approval satisfied by ordinary `approve` — was
applied by hand and the suite run with visible output:

```
× R2-F-017 — owner approval > an ordinary approver may NOT — holding `approve` is not owner authority
  → expected true to be false
Tests  1 failed | 24 passed (25)
```

So the test caught it. The harness said otherwise.

**The cause.** The harness stripped ANSI colour with `/\[[0-9;]*m/g`, which removes `[31m` but
leaves the **ESC byte** in front of it. The summary line then reads
`…Tests·ESC··ESC·ESC·1 failed…`, and `/Tests\s+(\d+)\s+failed/` cannot match, because `\s` does not
match ESC. The permissive counterpart `/Tests[^\n]*?(\d+)\s+passed/` matched happily, because
`[^\n]*?` crosses ESC without complaint.

So the "failed" branch could never fire, and every run fell through to SURVIVED with whatever number
the loose pattern latched onto — which is also why the counts varied.

**The fix.** Strip the whole escape sequence including ESC, find the summary line explicitly, and
read both numbers from that line. Both harnesses now do this, and a run with no summary line is
INCONCLUSIVE rather than either verdict.

**Why the earlier decision-boundary run was not affected:** its six CAUGHT verdicts required the
`failed` pattern to match, which it can only do when the output carries no colour. A false CAUGHT is
not producible by this defect — it can only manufacture false SURVIVED — so those six stand.

---

## Mutation evidence — corrected harness

Seven mutations, re-run after the harness defect above was fixed. Verdicts are parsed from the
summary line of a real campaign against a fresh disposable database.

| Mutation | Verdict |
|---|---|
| S1 sensitive-domain gate removed | **CAUGHT** — 1 failed |
| S2 own-work check ignores WHOSE membership it is | **CAUGHT** — 4 failed |
| S3 active-membership check dropped | **CAUGHT** — 1 failed |
| S4 evidence policy left company-wide while the item is scoped | **CAUGHT** — 3 failed |
| S5 owner approval satisfied by ordinary `approve` | **CAUGHT** — 2 failed |
| S6 specialist gate ignores the item's domain | **CAUGHT** — 3 failed |
| S7 unmapped domain falls back instead of refusing | **CAUGHT** — 3 failed |

### S1 needed a new test before it could be caught

On the corrected run S1 came back **INCONCLUSIVE** — the campaign had not executed the suite. Re-run
alone, it revealed a genuine gap rather than a flake: **no seeded role can demonstrate that the
sensitive gate does anything.** `owner_management` holds `management.queue.view_company` *and*
`legal.matter.manage` *and* `hr.staff.manage`, and everyone else is excluded by the department map
anyway — so deleting the gate changed nothing any fixture could see.

A bespoke test-only role was added: company-wide view, no sensitive-domain capability. With it, the
new test asserts that such a viewer sees an ordinary domain company-wide and **stops** at `legal`
and `workforce`. Re-running S1 against it:

```
× a COMPANY-WIDE viewer without the domain capability still cannot see sensitive items
  → legal is separately gated: expected [ …(25) ] to not include '6380b2ce…'
Tests  1 failed | 25 passed (26)
```

One test failed — the one written for it. That is the right discrimination profile: a mutation that
fails everything shows the suite is coupled; a mutation that fails only its own test shows that test
earns its place.
