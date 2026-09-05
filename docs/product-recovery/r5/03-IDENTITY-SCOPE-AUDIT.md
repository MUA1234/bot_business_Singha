# Batch 1 — advisor, delegate and consultant scope: audit before implementation

**Local-only.** No hosted contact, no deploy, no merge, no migration numbering, no real data, no
live model, no message sent, no financial effect.

Baseline: `claude/product-recovery-r1`, HEAD `e9d80ba`.

**Status correction accepted.** R2F-F-003 is `implementation_in_progress`, not complete. Owner,
manager and staff scoping is implemented and proven; the three remaining identity classes are
audited here and each is either implemented from what the model can prove, or left unavailable with
the precise missing fact recorded.

---

## What each identity class can actually prove

| | authenticated as | company relationship | active / expired / revoked | scope | capability |
|---|---|---|---|---|---|
| **Advisor** | a real membership (`advisor_relationships.membership_id`) | `company_id` on the relationship | `status in (active, suspended, ended)` **and** `starts_at`/`ends_at` window | `domain`, one per row, unique per `(company, membership, domain)` | whatever their membership's roles grant |
| **Delegate** | a real membership (`delegations.to_membership`) | `company_id` on the delegation | `now() between starts_at and ends_at` — both **NOT NULL** | `domain` (nullable), `division_id`, `is_company_wide` | the delegator's, within the delegation |
| **Consultant** | **nothing** — see below | `consultant_engagements.company_id` | `status in (proposed, approved, suspended, ended)` + window | `scope_domains[]`, `scope_skills[]` | **none** |

---

## R2F-F-005 — a consultant cannot be an authenticated viewer, and must stay unavailable

Two independent facts make consultant scoping unrepresentable, and neither is a gap I can close by
writing code:

1. **`consultant_engagements.provider_id` references `service_providers`, which has no user or
   membership column at all.** A consultant is an *organisation*, not a person with a login. There
   is no `auth.uid()` that resolves to a consultant, so there is nothing for a policy to match.

2. **`consultant_engagements` carries a check constraint that forbids it:**

   ```sql
   constraint consultant_engagements_no_internal_access check (internal_access = false)
   ```

   Internal access is not merely absent — the schema refuses to represent it.

**Decision: fail closed.** Consultants get no management-queue visibility, and the reason is
recorded rather than worked around. Granting it would require a user identity for a provider *and*
removing a check constraint that exists precisely to prevent this, which is a business decision
about external access to internal management data, not a scoping detail.

**What would be needed to change it:** a person-level identity for a provider contact (a membership,
or a provider-user join), an owner decision to relax `internal_access`, and a registered capability
for external queue visibility. None exists.

---

## Advisor — implementable, and implemented

`advisor_relationships` proves everything the invariant requires: an active membership, a company,
a status, a time window and a **domain**. Visibility is granted only when all of:

- the row's `status = 'active'`;
- `now()` is inside `[starts_at, ends_at)` — an ended or future relationship is not a relationship;
- `company_id` matches the item's company;
- `domain` matches the item's `department` exactly;
- the advisor's membership is itself `active`;
- they hold `operations.task.work` — the registered baseline capability for internal work.

A **suspended** or **ended** relationship, an expired window, a different domain or a different
company all fail closed.

## Delegate — implementable, and deliberately narrowed

`delegations` proves an active, time-bounded, company-scoped membership-to-membership grant with an
optional `domain`. The repository already has a written rule for reading it, in
`authority_ceiling` (migration 0038):

```sql
join memberships tm on tm.id = d.to_membership and tm.user_id = auth.uid() and tm.status = 'active'
where d.company_id = target_company and now() between d.starts_at and d.ends_at
  and (d.domain = target_domain or d.domain is null)
```

That shape is reused rather than reinvented, with **one deliberate narrowing**: a delegation whose
`domain` is NULL does **not** confer queue visibility.

`authority_ceiling` treats a NULL domain as "all domains" *for an amount ceiling*. An amount ceiling
is not a visibility grant, and reading one as the other would hand company-wide management
visibility to anyone holding a company-wide spending delegation. The domain must match the item's
department **explicitly**. That is the fail-closed reading, and it is recorded as a narrowing rather
than presented as the only possible one.

## Accountable ownership — tightened

The previous implementation granted visibility to the item's accountable owner on the strength of an
active membership in the right company. The owner's correction is right: that is a relationship and
a company, but no capability. Own-work visibility now additionally requires `operations.task.work`,
the registered capability for working assigned tasks — which every staff role already holds, so it
excludes nobody who should see their own work and stops a bare membership from being enough.

---

## R2F-F-006 — `observation_sources` exposes a free-text failure reason to every member

The earlier rationale for leaving this table outside the scoped predicate was that it "carries no
business content". Re-examined against the owner's five questions, that is **not true of one
column**.

| question | answer |
|---|---|
| company-isolated? | company rows yes; rows with `company_id IS NULL` are the deliberate cross-company default registrations |
| exposes credentials, connection info or record content? | **`last_failure_reason text` is free text**, world-readable within the company |
| can staff infer restricted legal/HR activity? | department-level health only — that a legal detector exists and whether it is failing. No case, party or content |
| can NULL/default rows cross companies? | yes, by design — but they carry only `department`, `kind` and cadence, no company data |
| required for truthful health reporting? | **yes** — the queue's `unobservedDepartments` comes from here, and hiding it would turn a failed detector into a silent all-clear |

`last_failure_reason` is currently written by **nothing** — like `proposed_action` before it, it is a
declared column with no writer. That makes this a **latent** exposure rather than an active one, and
exactly the kind that becomes real the first time someone stores a driver error containing a query
fragment or a constraint message quoting values.

**Decision:** ordinary members no longer read the raw table. A derived health projection returns
`department` and whether it is currently unobserved — which is everything truthful health reporting
needs and nothing else. The raw table stays readable by the server-side roles that maintain it.

---

# Implementation result

## R2F-F-007 — I wrote a weaker parallel rule beside a stronger existing one

The delegate branch I first added to the predicate matched on **domain alone**. It never asked
whether the delegator held anything.

`has_capability` (migration 0038) already resolves delegated capabilities, and its written rule is
stricter than mine:

> *(b) an active, in-window delegation TO the user, where the **DELEGATOR actually holds the
> capability** (a delegate never exceeds the delegator) … null domain = all domains.*

So my branch would have granted a delegate visibility their delegator did not have — a *widening*,
dressed as an additional safeguard. Two paths to one grant, the laxer of them newer, is how a
boundary quietly loosens.

**Found by a failing test I initially assumed was wrong.** The NULL-domain case failed; a diagnostic
added to the assertion reported `{"wide":false,"dept":true,...}` — the delegate held
`procurement.po.approve` without any branch of mine granting it. That pointed at `has_capability`
itself, not at my code.

**Fixed:** the branch and its helper are deleted. Delegation is left to the existing rule, and the
deletion is recorded in the migration so the mistake is not repeated.

**And my test asserted the opposite of the repository's rule.** It claimed a NULL-domain delegation
conveys nothing, on my reasoning that "an amount ceiling is not a visibility grant". That reasoning
was mine; the rule was already written. The test now asserts the real behaviour, plus the part that
matters most and that my branch would have missed: **a delegation from a staff member conveys
nothing**, because staff hold no department capability to pass on.

## Final scope, per identity class

| class | status | how |
|---|---|---|
| Owner | implemented | `management.queue.view_company`, sensitive domains still gated separately |
| Manager | implemented | exhaustive department→capability map |
| Staff | implemented | own accountable work **and** `operations.task.work` |
| **Advisor** | **implemented** | active, in-window, domain-matched `advisor_relationships` **and** `operations.task.work` |
| **Delegate** | **implemented, by the existing rule** | `has_capability`'s delegation clause — in-window, active both sides, never exceeding the delegator |
| **Consultant** | **fail-closed, blocked** | no user/membership identity exists for a provider, and `check (internal_access = false)` refuses to represent it (R2F-F-005) |

## Evidence

`tests/integration/r2-authority-and-scope.test.ts` — **44 passed**, real PostgreSQL 16, every read
as a real authenticated session.

Advisor: sees only the advised domain; suspended and ended confer nothing; expired and not-yet-started
windows confer nothing; advising `legal` does **not** admit them to legal material.

Delegate: an in-window delegation conveys the delegator's capabilities; **a delegation from a staff
member conveys nothing**; expired and not-yet-started confer nothing; revocation takes effect on the
next read; a delegation in another company grants nothing here.

Consultant: `service_providers` has no `user_id`, `membership_id`, `auth_user_id` or
`contact_user_id`; the `internal_access = false` constraint exists **and is enforced** — an insert
attempting `true` is rejected; and the predicate's own source text mentions neither
`consultant_engagements` nor `service_providers`.

Own work: a bare member who **is** the accountable owner, active, in the right company, still sees
nothing without `operations.task.work`.

Source health: the raw table is no longer readable by a session (`permission denied`); the
projection returns exactly `department` and `unobserved`; its source text contains no
`last_failure_reason`, `cadence_seconds` or `last_scan_duration_ms`; and a non-member gets nothing.
