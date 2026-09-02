# R2C completion report — collaborative resource routing

**Local-only. No merge, no deploy, no hosted contact, no live AI, no production migration number,
no message sent, no financial effect, no automatic assignment, delegation, engagement or access
grant, no points/bidding, no R2D.** No staging or production readiness is claimed anywhere.

## SHAs

| Checkpoint | SHA |
|---|---|
| 1–2 — dependency audit, verified skills, language, advisors, engagements | **`02c906f`** |
| 3 — role-specific resolvers | **`f1aec63`** |
| 4 — multi-role runtime integration | **`546e9cb`** |
| 5 — spatial presentation | **`3e98ab8`** |
| 6 — adversarial review and corrections | **`b06e4a0`** |

## The finding that matters most

**Three of the twelve domains had loaders reading columns that do not exist.**

R2A reported all twelve managed domains connected. That was true of the **adapters** and false of
three **loaders**:

| Domain | Selected | Actually exists |
|---|---|---|
| **Workforce** | `utilisation_pct`, `captured_at` | `utilization_pct`, `created_at` |
| **Finance** | `customer_invoices.updated_at` | `created_at` only |
| **CRM** | `wa_conversations.last_outbound_at` | *no outbound timestamp at all* |

Each failed on **every real read**, so those three domains were **unobserved at runtime** from
R2A until this fix. No test caught it because the adapter tests call the detectors directly with
fixtures; nothing exercised the production loader against a real row.

Found because R2C-F-001 (below) needed a live workforce condition and none appeared. One instance
of that class meant checking the rest, so I wrote an audit comparing every loader column against
`information_schema` on a real migrated database — it found the other two immediately.
`scripts/r1/check-loader-columns.mjs` is now a **permanent gate in the live campaign**; all 30
distinct selects are verified.

Fixed honestly. Finance uses `created_at`, the real freshness anchor for an invoice. CRM reports
`last_outbound_at` as an **explicit null**: there is no outbound timestamp on the conversation,
the detector already treats an unknown outbound time as "nothing sent" (the safe reading), and
inventing one from `updated_at` would be a guess about whether a customer was actually replied to.

## Defects

| | |
|---|---|
| **R2C-F-001** | **`formTeam` was tested and never called.** Complementary team formation existed, was unit-tested, and nothing on the runtime path invoked it — the cycle produced ordinary assignee snapshots for an action declaring `teamOfAtLeast: 2`. Exactly the shape WRK-007 was held back for, in my own work one phase later. Now wired and proven live |
| **R2C-F-002** | The workforce loader's two non-existent columns (above) |
| **R2C-F-003** | The same class in the finance and CRM loaders |

Also fixed in my own tests: a `describe` block appended as a **sibling**, so it ran after
`afterAll` closed the client; a UI layout switched on the **count** of recommendations, which
silently hid team coverage for a single-role proposal; and an assertion expecting the resolver's
cross-role guard where the fold had already filtered by role first (the stronger outcome).

## Dependency audit — what was reused rather than rebuilt

**Teams already existed.** `organisation_units.type` includes `'team'` and `membership_assignments`
already links people to it, company-scoped. R2C added **no team table**. Delegation, authority,
capacity, leave, providers and provider compliance were all reused unchanged.

Genuinely absent, and only these: verified skills, skill expiry and evidence, staff language,
advisor relationships, and a consultant **engagement** (`service_providers` describes a provider,
not an engagement with a scope, an expiry and an access boundary).

## Verified skills — finding F-R2B-2 closed

**Two axes, deliberately separate.** `provenance` (`self_declared`, `manager_entered`,
`externally_certified`, `evidence_verified`) answers *how do we know*; `status` (`active`,
`expired`, `disputed`, `revoked`) answers *does it still hold*. They are independent — an
externally certified skill can expire, a self-declared one can be disputed — and collapsing them
would make "expired" erase how the claim was ever obtained.

**Only** `externally_certified` **or** `evidence_verified`, **and** `active`, **and** not past
expiry counts as verified. `employee_profiles.skills` remains self-declared for ever. A CHECK
refuses a "verified" provenance with no verifier, time and evidence reference — the exact shape
by which a bare `text[]` would get relabelled as proof. A trigger refuses a protected
characteristic dressed as a skill, matching whole tokens so `payment_processing` survives while
`pay` does not. Every change writes its own append-only history row automatically.

## Language

`membership_languages` carries `en`/`si`/`ta` with proficiency and provenance, at most one
*preferred* language per person. Language gates a task that genuinely requires it and **nothing
else** — three people differing only in language tie exactly when the work does not require one.

> **No claim of multilingual AI guidance is made.** A stored preference is a stored preference.
> LNG-001 and LNG-002 remain untouched.

## Roles

**Required roles come from the catalogue**, as a pure function of a registered action and the
observation's structured facts. There is no parameter through which an interpretation could ask
for a delegate.

**Mandatory versus optional is load-bearing.** An advisor is mandatory only where the action
declares that specialist advice is genuinely required; a delegate is *never* mandatory (requiring
one would stall work unless authority happened to have been lent); a consultant appears only
where the action was opened to them. A missing **optional** role records its own truthful
`needs_routing` and leaves a valid assignee standing.

**Teams are built for coverage, not by taking the top N** — which gives five people good at the
same thing and nobody who can do the rest. It reports what it **cannot** cover, says when a member
adds nothing new rather than padding silently, and proposes **one** accountable lead. Only
someone who *personally* holds the lead capability may lead, and **no lead** is a reported answer
rather than promoting whoever sorted first.

**Outcomes never cross roles.** `SuitabilitySignal` and `OutcomeRecord` both carry a role.
Delivering reliably is not evidence about advice; advising well is not evidence for holding
authority; consultant performance stays provider-specific. The type system enforced this —
making `role` required turned every producer red until it declared which role its outcome
belonged to.

**Role boundaries.** An advisor carries no delegation even when the person holds one, and gains
no approval authority. A delegate recommendation **creates no delegation** — asserted live by
counting rows before and after. A consultant needs an approved engagement on a compliant
provider, receives no capability, and `internal_access` is **forbidden by database CHECK**, so an
engagement granting internal access is unrepresentable.

## UI

One section per role, each headed with the role and whether it is required. A blocking unfilled
role reads differently from a harmless one. Team coverage shows what is **not** covered. A
proposed delegation shows scope and expiry together and states "no delegation exists until a
human creates one"; a consultant states "no internal access, and nobody has been contacted".
Four controls per role — accept, replace, reject and **leave unfilled** — all links; the panel
emits no form, no submit control and no button.

## Test totals at `b06e4a0`

| Suite | Before R2C | After |
|---|---|---|
| Full unit suite | 2005 / 204 files | **2064 passed, 0 failed, 4 skipped / 207 files** |
| Kernel | 483 | **528** |
| Live full-schema | 172 / 8 files | **188 / 9 files** |
| Spatial | 136 | **153** |
| Kernel under the outbound network guard | 483 | **530** |
| Live draft apply + rollback | 31 | 31 |

`verify` exit 0 · typecheck clean · lint 0 errors · build compiled · browser-check passed ·
accessibility passed · quarantine 28 · secret-scan clean · migration-lint 109 sequential ·
IP boundary clean · autonomy audit consistent · **loader-column audit: 30/30**.

## Requirement status

| ID | From | To | Why |
|---|---|---|---|
| **WRK-007** Advisor, delegate and consultant recommendation | `implementation_in_progress` | **`locally_verified`** | All three now pass through the **actual runtime path** with live behavioural evidence — the condition the owner set |
| **KRN-002** | *(unchanged)* | *(unchanged)* | **Corrected**: the record now states that R2A's twelve-domain claim was true of the adapters and false of three loaders, and names the fix and the permanent gate |

**`locally_verified` 66 → 67. `absent` unchanged at 22. Staging and production remain ZERO.**

## Remaining limitations

- **Local only.** No staging, no production, no readiness claim.
- **Draft units 014, 016 and 017 carry no production migration numbers** (R1-D-1), and cannot
  until PR-F-001 and PR-F-004 close.
- **A recommendation still grants nothing.** Creating a delegation, assigning a person, and
  engaging or granting access to a consultant all remain separate human acts R2C does not perform.
- **Task completion timestamps are still missing** (F-R2B-1) — an open schema gap.
- **No multilingual guidance** — only a stored preference.
- **The kernel still does not act.** No executor exists; no scheduler is registered.
- Deployment blockers unchanged: PR-F-004, PR-F-001, PR-F-014/R0-F-007, R0-F-001, PR-F-002/003.
