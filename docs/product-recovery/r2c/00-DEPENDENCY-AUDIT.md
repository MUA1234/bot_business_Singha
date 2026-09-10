# R2C checkpoint 1 — dependency audit and architecture

**Local-only.** No hosted contact, no deploy, no merge, no production migration number, no live
AI. Read before implementation, as the owner required.

## 1. What exists, and what genuinely does not

| Input | Where it lives | Verdict |
|---|---|---|
| **Team membership** | `organisation_units` (`type` includes **`'team'`**) + `membership_assignments` (`membership_id`, `org_unit_id`, `is_primary`) | **REUSE AS IS.** Teams are already representable and already company-scoped. R2C adds no team table. |
| Department | `organisation_units` (`type='department'`), same join | **REUSE** |
| Workload and availability | `capacity_snapshots` (weekly, inferred), `leave_requests` (approved, verified) | **REUSE** — as R2B |
| Authority and approval scope | `authority_rules`, `approval_policies`, `src/policy/authority-engine.ts` | **REUSE** |
| Delegation | `delegations` (0010 + 0023 ceilings), `src/modules/identity/delegation-authority.ts` | **REUSE** — R2B-F-001 already closed on both paths |
| External consultants / providers | `service_providers` — `status`, `capabilities text[]`, `service_areas`, `compliance_status`, `insurance_status`, `insurance_expiry` | **REUSE for the provider itself** |
| Provider compliance | `counterpartyHealth`, `providerHealth` | **REUSE** |
| Task requirements | `tasks`, `task_routing.required_capability`; the action catalogue | **REUSE**, extended per action (below) |
| **Verified skills and qualifications** | `employee_profiles.skills text[]` only — no verifier, no evidence, no expiry, no status | **ABSENT.** Draft unit 016. |
| **Skill expiry and evidence** | — | **ABSENT.** Same unit. |
| **Staff language preference** | — (`communication_preferences` is a *customer* channel/opt-out record) | **ABSENT.** Same unit. |
| **Advisor relationships** | — nothing anywhere names an advisor | **ABSENT.** Draft unit 017. |
| **Consultant engagement scope** | — `service_providers` describes the provider, not an engagement with a scope, an expiry and an explicit access boundary | **ABSENT.** Same unit. |

Two findings from R2B stand unchanged and still shape this phase:

- **F-R2B-1** — `tasks` has no `completed_at` / `verified_at` / `verified_by`, so task-level
  deadline performance is not computable. Still recorded as a schema gap, still not worked around.
- **F-R2B-2** — no skill in this system is verified. **R2C closes this**, which is the point of
  draft unit 016.

## 2. Minimum new structures (quarantined drafts only, no production numbers)

### Unit 016 — verified skills and language

`skill_records` carries the seven states the owner named as a **provenance** and a **status**,
deliberately separated:

| provenance | meaning |
|---|---|
| `self_declared` | the person said so |
| `manager_entered` | a manager typed it; nobody checked a document |
| `externally_certified` | an issuing authority certified it |
| `evidence_verified` | someone in the company checked evidence and recorded it |

| status | meaning |
|---|---|
| `active` · `expired` · `disputed` · `revoked` | |

They are two axes because they answer different questions. *"How do we know?"* and *"does it
still hold?"* are independent: an externally certified skill can expire, and a self-declared one
can be disputed. Collapsing them into one enum would make "expired" erase how the claim was ever
obtained.

**Only `externally_certified` or `evidence_verified` AND `status='active'` AND not past expiry
counts as VERIFIED.** Everything else is present-but-unverified, and can never satisfy a
mandatory requirement — `employee_profiles.skills` remains self-declared for ever.

Each record retains company, subject, skill, evidence reference, verifier, verification time,
expiry, status, and an append-only `skill_record_events` history. Protected characteristics are
refused by a trigger, exactly as on the recommendation snapshot.

`membership_languages` stores `en` / `si` / `ta` with a proficiency and a provenance.

> **Language may gate a task that genuinely requires it, and may not influence ranking anywhere
> else.** That rule already exists in `gateLanguage` and is unchanged; unit 016 only supplies the
> data it has been asking for since R2B.

### Unit 017 — advisor relationships and consultant engagements

`advisor_relationships` records who may advise on what, with evidenced experience and a validity
window. `consultant_engagements` records an approved engagement: provider, scope domains, start,
expiry, and `internal_access boolean NOT NULL DEFAULT false` with a **CHECK forbidding true** —
so an engagement that grants internal access is unrepresentable rather than merely unusual.

## 3. Architecture

`resolveCandidates` already supports four roles and enforces their boundaries. R2C adds:

```
src/kernel/people/
  roles-required.ts   which roles this ACTION needs — from the catalogue, never from a model
  team.ts             complementary team formation: coverage, gaps, one accountable lead
  loaders.ts          verified skills, languages, advisors, engagements (server-side reads)
  learning.ts         EXTENDED: signals keyed by (membership, taskKind, ROLE)
```

**Role-specific learning.** The signal key gains the role. Delivery performance as an assignee is
not advisor performance; advisor success is not evidence for delegated authority; consultant
performance stays provider-specific. A team outcome is **not** divided equally among members —
only the accountable lead carries it, because "everyone on that team gets a mark" is precisely
the blind attribution the owner forbade.

**Required roles come from the catalogue action**, extended with an optional
`requiresAdvisorFor` / `teamOfAtLeast` declaration. A model never chooses which roles are needed.

## 4. Explicitly out of scope

Creating an actual delegation, assigning anyone, contacting a consultant, granting access, task
points/bidding, unattended actions, live AI, hosted contact, deployment, R2D.
