# R2B completion report — people intelligence, capability routing and safe outcome learning

**Local-only. Supabase access still deferred; hosted migration state still unknown.**
No merge, no deploy, no hosted contact, no migration renumbering, no live AI, no message sent,
no financial action, no points/auction, no staff discipline or remuneration, no R2C.
**No claim of staging or production readiness is made anywhere in this report.**

## The one thing to read first

The capability is **built, tested and adversarially reviewed. It is NOT on a runtime path.**

`runManagementCycle` creates management items with a proposed action and **never calls
`resolveCandidates`**. Nothing in production writes `management_item_feedback` either. So no
requirement moved to `locally_verified`, because the register requires a runtime entrypoint and
this does not have one. Wiring it is the first thing the next phase should do, and it needs its
own owner decision because it changes what the cycle persists.

## SHAs

| | |
|---|---|
| Branch | `claude/product-recovery-r1` |
| Tested SHA (all evidence below) | **`bab7ad6`** |
| Checkpoints | `f61725d` (1–2) · `92eed92` (3) · `c294f01` (4) · `be38113` (5) · `828d874` (6) · `bab7ad6` (adversarial fixes) |
| Preceded by | `abb09c9` — the owner's KRN-002 scope restriction |

## Checkpoint 1 — dependency audit

All fourteen inputs classified by reading the schema. Full table:
[00-DEPENDENCY-AUDIT.md](00-DEPENDENCY-AUDIT.md). What it found:

| Class | Inputs |
|---|---|
| **verified** | memberships, roles, capabilities, authority rules, approved leave, department/company, previous assignments, management-item transitions |
| **inferred** | availability, workload/capacity — and capacity is weekly, so routinely **stale** |
| **self-declared / manager-entered** | `employee_profiles.skills` — a bare `text[]` |
| **ABSENT** | staff language, coaching/development, task-level required skills, counterparty performance |

**F-R2B-1 — task-level deadline performance is not computable.** `tasks` has no `completed_at`,
no `verified_at`, no `verified_by`. Status reaches `completed` but never records *when*, so
on-time performance cannot be measured against `due_date`. Learning therefore derives it only
from `management_item_transitions`. It is **not** approximated from `updated_at`, which any edit
moves.

**F-R2B-2 — no skill in this system is verified.** So work that *mandates* a verified skill
yields `needs_routing`, not a person chosen on an unchecked claim. When a verification source is
added, data changes and the logic does not.

Also: the only person-level expiring credential anywhere is `drivers.licence_expiry`, and
`drivers` has **no foreign key to `memberships` or `profiles`**, so it cannot be joined to a
candidate at all.

## Checkpoints 2–3 — the shared resolver and the four roles

One service, `src/kernel/people/`. `selectAssignee` delegates to it, so there is one definition
of "eligible" rather than two. Its contract is unchanged and all 58 existing `recommend` tests
still pass.

**The fairness model is structural, not aspirational:**

| Rule | How it is made true |
|---|---|
| Provenance never lost | Every input is a `Fact<T>`; there is no way to pass a bare `string[]` of skills in |
| No protected attribute | A positive **allowlist**, refused **at construction**. A denylist must anticipate every proxy; an allowlist refuses `postcodeCluster` without having heard of it |
| Leave/overload/missing data never penalise | Exclusions are marked **neutral** — excluded from *this* request, never a mark against a person, never a learning signal |
| Missing data never penalises | Everyone starts at a neutral baseline; evidence lifts, absence moves nobody. A cold-start candidate ranks **equal** to one with average history, differing only in reported confidence |
| No universal rank | Signals keyed on `(membership, taskKind)`; a signal earned on other work is explicitly ignored |
| Fail closed | Every gate; and **all** gates run, so a human sees "no capability AND on leave", not just the first |
| Nobody suitable | `needs_routing` to the **department**, with a precise reason code that distinguishes "nobody can" from "nobody can right now". Nothing can name an administrator or the owner (R1-D-3) |

**The four roles stay distinct**, enforced by assertions that throw rather than filters that
silently correct: an advisor carries no delegation even when the person holds one; an external
consultant can never be the accountable assignee, receives no internal capability, and carries
`internalAccess: false` by type *and* by runtime assertion — **recommendation is not
authorisation**; a delegate without scope, start and expiry is not a delegate.

### R2B-F-001 — a real defect in existing code

`delegationPermits` checks a delegation against its *own* ceiling and window, and
`src/policy/authority.ts` trusts that answer. **Neither checks the delegation against the
DELEGATOR's authority.** A manager whose own ceiling is LKR 50,000 can write a delegation
granting LKR 5,000,000, and it is honoured — authority manufactured from nothing by the person
with the least of it.

Closed for capability routing in `delegation-scope.ts`: the effective ceiling is the **lower** of
the delegation and the delegator; an uncapped grant needs a genuinely uncapped delegator; a
delegator with no money authority has none to lend; nobody may delegate a level above their own;
borrowed authority may not be delegated onward; an unscoped delegation is refused outright.

> **⚠️ OWNER DECISION NEEDED.** The fix is a **new** function, not an edit to `delegationPermits`.
> **The financial-approval path still has the gap.** Silently changing what approves a payment is
> outside R2B's authorisation, so it was left alone and is reported instead.

## Checkpoint 4 — safe outcome learning

**No new table and no R2B draft migration.** The authorisation was conditional on durable
structure being *genuinely necessary*, and it is not: `management_item_transitions` and
`management_item_feedback` are already append-only at the database, and a derived signal is a
**pure fold** over them. Storing the fold would add a cache that can silently disagree with the
truth it came from; recomputing is what "reproducible and rebuildable" means.

**The owner's bar is met by a deterministic test**, not by reading feedback: two candidates
identical to every gate rank equal with no history; the one with four confirmed outcomes from
three decision-makers is ordered first — with a reason naming the count, the deciders and the
rule version.

| Guard | Setting |
|---|---|
| Promote / **demote** thresholds | 3 outcomes / **5** — adverse claims need more evidence |
| Distinct deciders | ≥ 2, or no adjustment (one-manager bias) |
| Anti-poisoning | ≤ 1 outcome per decider per person per day; the **earliest** of a burst is kept, so writing more cannot displace genuine history. 200 fabricated records count as one |
| One-manager weight cap | 3 weight-units, scaled proportionally so reordering never changes which outcomes count |
| Recency / obsolescence | 90-day half-life; past 540 days **excluded**, not merely faded |
| Contradiction | No adjustment at all; asks for a human instead of picking a side |
| Corrections | Supersede what they correct **entirely**, never sit alongside it |
| Influence ceiling | 0.15 of an ordering value a human then overrides |

**Excluded as evidence about a person: `rejected` and `dismissed`.** They judge the *kernel* — a
bad proposal, a noisy detector — and counting them would penalise people for the system's own
mistakes, turning a manager's dismissal of a false alarm into a mark against whoever was named.

**Learning never touches authority.** Asserted: a perfect record does not lift anyone over an
authority gate or make an ineligible person eligible, and no emitted field could carry a pay,
discipline or rating meaning.

## Checkpoint 5 — the spatial explanation UI

Added to the **existing** management-item window using existing primitives. `recommendation` is
optional, so all 38 existing panel tests are unaffected.

**Two deliberate omissions, and they are the design.** There is **no numeric suitability score
beside a person** and no percentage next to a name: printed beside a face, an ordering value
becomes a rating, and a rating becomes the universal rank the owner forbade. **Confidence *is*
shown**, labelled "evidence confidence", because it describes the evidence and not the person.

Three states, never collapsed: *no resolution run* / *no suitable candidate* (with the precise
reason and the department it queued to) / *candidates*. The human override is on **every** state,
and is a link — the panel emits no form and no submit control.

## Checkpoint 6 — adversarial campaign on a live database

Registered with the existing disposable-PostgreSQL runner. **Live suite 116 → 135.** Every
candidate is built from evidence **loaded from the database**, so a pass proves the production
loader shape works, not just the fixture.

- **Permission removal between recommendation and commit** — resolved eligible; role revoked; the
  database refuses to treat the stale recommendation as authorisation; re-resolving refuses on
  the same code path.
- **Owner loses authority in flight** — the item returns to `needs_routing` with a reason naming
  the revocation; asserted to name no administrator and no owner fallback.
- **Concurrent assignment** — two connections, one row: the second blocks on the row lock and
  then matches zero rows. No lost update.
- **Cross-company** — refused by the resolver, made loud by `assertSingleCompany`, and made
  **unrepresentable** by the composite foreign key.
- **No authority expanded** — no capability gained, still refused as an owner, and resolution
  writes nothing at all.
- **Learning from real append-only history** — and `UPDATE`/`DELETE` on it are both refused.

A **permanent outbound-network guard** was added (`vitest.no-network.config.ts`): `fetch`,
`http` and `https` all throw. 365 kernel tests pass under it, so "no hosted service was
contacted" is proven rather than asserted — including by code we merely imported.

## Defects found and fixed

**In existing code:** R2B-F-001 (above) — fixed for routing, **still open on the financial path**.

**In my own R2B code**, each reproduced before being fixed, each with a regression test:

| | |
|---|---|
| **R2B-F-002** | Supplied evidence could **override the authorised identity** — identity keys are legitimately on the allowlist, and the spread order let a loader replace them. The company check was never the real damage; a replaced `membershipId` would make the history lookup fetch **a different person's record**. Identity is now applied last |
| **R2B-F-003** | Two roles for one person ordered by input, not deterministically — they share a membership id, so the tie-break did not separate them |
| **R2B-F-004** | An **undated** workload reading was silently trusted as fresh, forever, contradicting the module's own documentation. It is still used (refusing it would penalise a loader's omission) but its unknown age is now reported |
| **R2B-F-005** | A **reopened** outcome was rendered to managers as "5 verified outcome(s)" — praise, inside the sentence explaining why someone ranked *down*. Renamed to *confirmed* throughout |
| **R2B-F-006** | The challenge explanation **disagreed with the fold**: a manager could be told "10 counted" when 3 were used, with obsolete, future-dated and burst-suppressed records invisible. Since learning must "support correction and challenge", an explanation that overstates the evidence is worse than none |

**Test defects of my own**, all fixed rather than worked around: assertions compared against raw
SSR output (React inserts `<!-- -->` between interpolations); a protected-attribute check used
substrings and matched "healthy" and "manage"; a per-decider-cap threshold derived from the very
constant it was testing, so it passed with the cap removed (found by mutation-testing both
anti-poisoning guards); and my copy said "Ranking rule", which is exactly the word this surface
should not put near people.

**Five live-fixture defects, every one caught by a real constraint doing its job** — invented
role keys, missing `base_currency`/`username`/`department`, an unseeded `auth.users`, a direct
`state` write that draft 010 correctly refused, and items with **no evidence** that draft 003
correctly refused (INV-1 enforced at the database). A fixture-first file that had passed on the
first run would have proven far less.

## Test totals

| Suite | Before | After |
|---|---|---|
| Full unit suite | 1681 / 194 files | **1825 passed, 0 failed, 4 skipped / 200 files** |
| Kernel (incl. people) | 261 | **365** |
| Live full-schema | 116 / 5 files | **135 / 6 files** |
| Spatial | 104 | **126** |
| Kernel under the outbound network guard | — | **365, no external call** |
| Live draft apply + rollback | 31 | 31 |

`verify` exit 0 · typecheck clean · lint 0 errors · build compiled · browser-check passed ·
secret-scan, migration-lint (109 sequential, no gaps), autonomy audit and IP boundary all pass.

## Requirement status

| ID | From | To | Why |
|---|---|---|---|
| **WRK-005** Fair assignment and team formation | `absent` | **`implementation_in_progress`** | The resolver exists and is tested; **not wired**; team *formation* still absent |
| **WRK-007** Advisor, delegate, consultant recommendation | `absent` | **`implementation_in_progress`** | The three roles are implemented and enforced; **not wired** |
| **IMP-002** Staff feedback and lessons learned | `absent` | **`implementation_in_progress`** | The fold exists and meets the owner's bar by test; **not wired**, and nothing writes the feedback it folds |

**`locally_verified` is UNCHANGED at 63.** `absent` 26 → 23. **Staging and production remain
ZERO.** KRN-002 keeps the narrowed scope the owner set on 2026-09-02.

## Remaining work

**First, and blocking everything else in this area: wire the resolver into the management
cycle.** It needs an owner decision because it changes what the cycle persists — the natural
target is the existing `recommended_resource_type` / `recommended_resource_id` columns (a
*recommendation*, never an assignment), and the atomic create RPC would have to carry them, which
means a new quarantined draft unit.

Then: nothing writes `management_item_feedback` at runtime, so the learning fold has no input in
production; team *formation*; a verified-skill source (F-R2B-2); a task completion timestamp
(F-R2B-1); a staff language source; coaching/development records; and the wider original-vision
gaps unchanged from R2A — work marketplace, Ask-AI, multilingual, people analytics,
customer-facing agents, GPS/CCTV, email/Sheets/calendar/voice, AST-001, CRM-004, marketing
attribution, and an executor for approved actions.

## Supabase and deployment blockers — unchanged

PR-F-004 (hosted migration state unknown — **still the only gate answerable from a dashboard**),
PR-F-001 (duplicate `0069`), PR-F-014 / R0-F-007 (the active Railway deployment has no commit
identity), R0-F-001 (Vercel `402`; inbound WhatsApp unverified), PR-F-002 / PR-F-003, and R1-D-1
(draft units cannot take migration numbers until PR-F-001 and PR-F-004 close).

The thirteen R1 draft units remain quarantined and **R2B added none**. Nothing was applied to any
hosted database.

## Honest limits

- **Local only.** No staging, no production, no readiness claim.
- **The resolver is not called by the runtime.** This is the headline limitation.
- **R2B-F-001 is fixed for routing only**; the financial-approval path still carries it.
- **No skill is verified and no staff language exists**, so those gates refuse by design rather
  than guessing — which is correct, and also means less is usable today than the code suggests.
- **The kernel still observes and recommends; it does not act.** No executor exists.
