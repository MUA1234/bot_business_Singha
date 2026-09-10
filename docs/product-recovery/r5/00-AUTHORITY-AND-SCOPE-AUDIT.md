# Roadmap R4/R5 — authority levels and queue scope: audit before implementation

**Local-only.** No hosted contact, no deploy, no merge, no migration numbering, no real data, no
live model, no message sent, no financial effect.

Baseline: `claude/product-recovery-r1`, HEAD `531dbb6`.

Findings are registered here **before** any fix.

---

## R2F-F-003 — every member of a company can read every management item, and all its evidence

Reproduced by reading the applied policy, not inferred.

`R1_DRAFT_007_rls_matrix.up.sql` creates one SELECT policy per R1 table in a loop:

```sql
create policy %I on public.%I for select to authenticated
  using (public.has_company_access(company_id))
```

over `management_items`, `management_item_transitions`, `management_item_evidence`,
`management_item_decisions`, `observation_sources` and `management_item_feedback`.

`has_company_access` requires an **active membership and nothing else**. So:

- an ordinary member of staff can read every management item in the company, in every department;
- and every **evidence row** attached to them, which is where the business content actually is;
- and every decision, transition and piece of feedback.

That includes the two domains the owner names as sensitive: `legal` and `workforce`. A grievance or
a compliance matter observed by the kernel is, today, readable by anyone with a login for that
company.

The interface made this worse rather than better (R2-F-016, fixed): the queue also *offered*
decision controls to those viewers, because the permission flag defaulted to yes.

**Scope of the defect.** Company isolation is intact — `has_company_access` is company-scoped and
the cross-company tests pass. What is missing is scope *within* a company.

**Traceability:** roadmap **R5**; the standing permission model; AIM-009's visibility model.

---

## R2-F-017 — the two authority levels the repository could not establish (owner decision received)

The decision RPC has been failing closed on `specialist_approval` and `owner_approval` because no
database rule could establish either for a user. The owner's decision of this session resolves it,
and the resolution is narrow.

### What already exists, and what does not

| | |
|---|---|
| Capability naming convention | `domain.object.verb` — `operations.task.manage`, `legal.matter.manage`, `finance.journal.post` (migration 0038) |
| Owner classification | the **`owner_management` role** (0023/0038). It is a role, not a capability, and no capability identifies it |
| Ordinary approval | `approve` / `reject`, documented in 0023 as "manager/admin in company" |
| Domain capabilities that could constitute specialist authority | `legal.matter.manage`, `hr.staff.manage` — and, for other domains, **none** |

### Owner approval — implemented as a dedicated capability

`management.decision.approve_owner`, registered in the quarantined draft using the existing
`insert into permissions` pattern, granted to **`owner_management` only** (plus the system
administrator role, which by construction holds every permission).

A `project_manager` does **not** hold it, and a holder of `approve` does **not** satisfy it. That is
asserted directly.

### Specialist approval — an exhaustive domain map, and honest gaps

Specialist authority is read from an **exhaustive** map of the item's `department` to a registered
domain capability. There are twelve departments and only two have one:

| department | specialist capability | note |
|---|---|---|
| `legal` | `legal.matter.manage` | sensitive; separate from operational approval |
| `workforce` | `hr.staff.manage` | sensitive |
| the other ten | **none registered** | specialist approval is **unavailable**, and the refusal says which domain has no registered capability |

**`finance` is deliberately left with no specialist capability.** Candidates such as
`finance.journal.post` are accounting-posting authority, and the owner's authorisation explicitly
does not widen financial or accounting controls. An item requiring finance specialist approval is
therefore refused with a stated reason rather than routed to an accountant's posting permission.

**An owner does not automatically substitute for a specialist.** The map is consulted, not the role.
Where `owner_management` *does* satisfy a specialist gate — it holds `legal.matter.manage` and
`hr.staff.manage` — that is because **migration 0038 explicitly grants it**, which is an existing
written authority rule, not an inference from ownership.

### The six decision types stay closed

`dismiss`, `edit`, `delegate`, `postpone`, `route` and `request_evidence` remain refused. The
existing decision guard anticipates them and requires reasons for them, but no permission authorises
any, and none is invented. They are not offered in the interface.

### What this does not touch

Financial authority, payment approval, accounting controls, delegation ceilings and
separation-of-duties rules are unchanged. Two capabilities are added; nothing existing is widened.
