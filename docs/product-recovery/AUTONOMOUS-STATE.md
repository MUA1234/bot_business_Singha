# Autonomous state — resumption record

Updated after every checkpoint and before any unavoidable response.

---

## Position

| | |
|---|---|
| Repository | `MUA1234/bot_business_Singha` |
| Branch | `claude/product-recovery-r1` |
| HEAD | `e5b55524444443f797b9f3c0f2a4e53cfa3d2c8f` — pushed, in sync |
| Working tree | **dirty**, deliberately: TD-002 + R2D await the four separated commits |
| Phase | **R2D**, batches 1–8 implemented; verification campaign running |

## Completed since HEAD

**TD-002 — incremental high-water mark** (product defect). A caught-up `keyset_updated` lane
committed `next = null`, so the next cycle re-read the oldest rows and a change made moments ago
waited behind the whole table. Now parks at its compound `(updated_at, id)` mark; an empty page
never erases a valid position. Bound corrected: sentinel is row 601, page 100, so earliest forward
discovery is **cycle 7**. Reconciliation reads carry a `lane` marker — two earlier tail-liveness
"passes" had been satisfied by the wrong lane.

**Performance** — queries/cycle 2074 → 581; identity lookups 494 → 7. Cause was the test shim
re-deriving RPC signatures per call (42%) and the per-observation N+1 (46%), not the dual lanes
(+14%).

**R2D** — audit + contracts (`r2d/00-AUDIT-AND-CONTRACTS.md`, findings F-001…004); draft unit
**020** (threads, turns, citations, suggested actions, coded safety events; RLS own-membership +
`management.ask_ai.review`; safety events own-membership-only; no write policy; retention 30 days
default, 90-day ceiling, `expires_at` NOT NULL); capability registered default-deny in the existing
`permissions` catalogue; `src/kernel/ask-ai/{contract,sensitive,retrieval,ask,fixtures,review,
identity}.ts`; `src/app/api/ask-ai/route.ts`; `AskAiWindow` + registry entry.

**Defects found and fixed this phase**
- retrieval selected `assignee_membership_id` — no such column; real one is `assigned_to`
  → `profiles(id)` → a USER. Same class as R2C-F-002.
- `asUser` test helper omitted the transaction, so `SET LOCAL ROLE` was a no-op and six RLS
  assertions ran as the table owner. Failed **open**, which is why it was caught.
- draft 020 granted no `SELECT` to `authenticated` — refusal by table privilege would have looked
  like isolation while also denying a person their own guidance.
- `expires_at > created_at` forbade early expiry, which purge and revocation both need.

**Identity brands** (owner decision): `UserId`/`MembershipId`/`CompanyId` are branded, so the
transposition that caused the retrieval defect is now a compile error, mutation-verified by
`@ts-expect-error`.

## Test counts

Kernel + spatial units **≈823 passing** (Ask-AI 35, multilingual 9, UI 22, disclosure 14,
identity 8). Live campaign: running.

## Running now

`node scripts/r1/run-r1-security-tests.mjs` → `/tmp/r2d3.log` — 20 suites including
r2d-ask-ai, r2d-adversarial, r2d-non-execution, r2d-saved-answer-access.

## Next exact action

```
# 1. read the campaign
grep -aE "FAILED |Test Files|Tests |FAIL " /tmp/r2d3.log | tail

# 2. mutation-check the high-water invariant
node <scratchpad>/mutate-hw.mjs break && node scripts/r1/run-r1-security-tests.mjs
node <scratchpad>/mutate-hw.mjs restore

# 3. full gates, diff review, then FOUR separated commits:
#    (1) TD-002 high-water/lane/reconciliation + tests  [carries the shared runner file]
#    (2) R2D contracts, persistence, backend, security
#    (3) R2D spatial/mobile UI + tests
#    (4) R2D report/evidence
# 4. push, verify local == remote, then continue into R2E
```

## Unresolved findings

- **R2D-F-002** production retention duration — owner/legal gate; local 30 days, 90-day ceiling
- **R2D-F-003** `membership_languages` is quarantined draft 016 — deployment blocked by 0069
- Sinhala/Tamil classifier coverage thin — handled by the `unverified` mode, which answers but
  does not file to reviewable history and never infers a grievance; native-speaker review is a
  staging gate
- **TD-001** `loadFor` positional `(source, companyId)` pair, 47 call sites — deferred
- Pixel layout and assistive-technology behaviour — staging/human gates; the disclosure tests are
  structural DOM evidence only

## Hard blockers

**None.** Staging and production remain zero. No hosted contact, no live model, no migration
numbering, no real data.

---

# R2E — controlled approval-to-execution engine — COMPLETE (2026-09-04)

**Commits:** `5dc63c2` (Batch 1 audit) · `7dd9d70` (Batches 2–11)
**Report:** `docs/product-recovery/r2e/01-R2E-REPORT.md`
**Audit:** `docs/product-recovery/r2e/00-AUDIT.md`

## State

Nothing executes. `EXECUTION_GLOBALLY_ENABLED = false as const` — a compile-time constant, not an
environment variable, so no deployment configuration can turn it on. A real effect additionally
requires a `LOCAL_EXECUTION_TOKEN` that only a test file can supply.

Of 15 catalogue actions: **1 locally executable, 13 draft-only, 1 prohibited.** The one executable
action creates an unassigned internal task and nothing else.

## What exists now

| | |
|---|---|
| `src/kernel/execution/contract.ts` | typed request, closed refusal union, discriminated outcome |
| `src/kernel/execution/policy.ts` | exact `Record<CatalogueActionId, …>` — a missing policy does not compile |
| `src/kernel/execution/boundary.ts` | both switches; global is `false as const` |
| `src/kernel/execution/executor.ts` | the ordered checks; authority resolved at execution time |
| `src/kernel/execution/ledger.ts` | claim-before-handler over SQL |
| `src/kernel/execution/transports.ts` | idempotent RPC (R2E) and direct insert (UI) |
| `src/modules/work/create-internal-task.ts` | the shared typed command |
| `src/db/draft-migrations-r1/R1_DRAFT_021_*` | ledger + separate execution enablement + atomic RPC (QUARANTINED) |
| `src/components/spatial/windows/ExecutionControlWindow.tsx` | operator window, not wired to a route |

## Verified

- Unit **2253 passed** / 4 skipped, 218 files
- R2E live campaign **18 passed / 0 failed** on real PostgreSQL 16
- 10 concurrent callers, one key → **one** task
- Crash between effect and ledger → **no second** task on retry
- Disabled → **zero** rows written to `management_execution_attempts` or `tasks`
- Four mutations, each caught by exactly one test (two caught at compile time / by the F-001 gate)
- secret-scan · migration-lint · inventory · IP-boundary · requirements audit · typecheck: pass

## Unresolved findings (added by R2E)

- **R2E-F-001** catalogue/engine vocabulary mismatch — recorded and GATED, deliberately not fixed;
  needs an owner decision on which actions may ever run unattended
- **R2E-F-002** UI task path has no durable idempotency — needs a numbered migration on `tasks`
- 13 actions have no handler, deliberately
- Draft 021 is quarantined, deployment-blocked behind the same 0069 reconciliation
- The operator window has no route supplying it real rows

## Next

**STOP.** Owner and Codex review of R2E. Do not begin R2F, the task marketplace, points, people
analytics, external integrations or further visual redesign.

## Hard blockers

**None.** Staging and production remain zero. No hosted contact, no live model, no migration
numbering, no real data, no message sent, no financial effect.

---

# Session 2026-09-05 — R2E continuation + R2F audit and first slice

**Branch:** `claude/product-recovery-r1` · **HEAD at handoff:** see final commit below
**Dirty files:** none · **Running processes:** none · **Containers:** none (all disposable
containers removed by the runner)

## Commits this session

| SHA | What |
|---|---|
| `c81df97` | Batch A — owner's narrow automatic authority; F-005…F-009 |
| `32d7e36` | F-010 — executor read a column nothing writes |
| `28135ec` | Batch B — execution state in the management queue (F-012) |
| `1876133` | F-013 — the exact-action gate was untested (found by mutation) |
| `01968a5` | Batch D — R2F audit, requirement traceability, slice selection |
| `b9c64cb` | R2F slice — cockpit shows management items (F-001) |

## Verification completed

- Complete live campaign **426 passed / 0 failed**, 23 files, 1192s, real PostgreSQL 16
- R2E live suite re-run at final HEAD **26 passed**
- Unit **2304 passed** / 4 skipped · network guard **686 passed**
- typecheck 0 · lint clean · build exit 0 · secret-scan · migration-lint · inventory ·
  IP-boundary · requirements audit — all pass
- **10 mutations run.** 8 caught immediately; 2 survived, were recorded as findings (F-013 and the
  cockpit's unavailable branch), fixed, and are now caught.

## Open defects and blockers

| Id | State |
|---|---|
| **R2E-F-011 / R2F-F-002** | **BLOCKED** — recording a decision needs a service-only decision RPC or an INSERT policy; both are migrations, and this session's containment forbids numbering draft units. Needs owner authorisation, as draft 021 had |
| R2E-F-001 | recorded and gated; the legacy `ACTION_FLOORS` vocabulary is untouched by design |
| R2E-F-002 | UI task path has no durable idempotency — needs a column on the hosted `tasks` table |
| R2F-F-003 | queue is not scoped by viewer authority; partly blocked by F-002 |
| R2F-F-004 | no re-observation driver, so a completed task whose condition persists does not reopen |

## Exact next command and next task

```bash
# 1. confirm state
git -C . rev-parse HEAD && git status --porcelain

# 2. next task — R2F-F-003 and F-004 are the remaining unblocked loop work.
#    F-004 (outcome verification by re-observation) is the roadmap R5 item and is
#    the larger of the two; start by locating where a cycle could compare a
#    completed task against its item's still-standing condition:
grep -rn "verifying\|reopened" src/kernel/lifecycle.ts src/kernel/cycle.ts
```

**Do not** begin the decision write path (F-002) without owner authorisation for a further
quarantined draft unit.

## Hard blockers

**One:** R2E-F-011 / R2F-F-002, above. Everything else remains local-only. Staging and production
remain **zero**. No hosted contact, no live model, no migration numbering, no real data, no message
sent, no financial effect.

---

# Session 2026-09-05 (second) — the management decision boundary (roadmap R4/R5)

**Branch:** `claude/product-recovery-r1` · **Started from:** `4e5c184`
**Dirty files:** none · **Running processes:** none · **Containers:** none left behind

## Commits

| SHA | What |
|---|---|
| `5198c1f` | draft 022 decision RPC, runtime path, controls; R2-F-014/015/016 |
| `4f31446` | audit corrections; service-role-gate and server-action build fixes |

## What now exists

A human can approve or reject a management item, through the interface and through the API, and the
decision is bound to exactly what they saw.

| Piece | Where |
|---|---|
| Decision RPC (SECURITY DEFINER, `authenticated` only) | `R1_DRAFT_022_decision_rpc.up.sql` |
| Evidence digest, defined once in SQL | `r1_draft_evidence_digest` |
| Authenticated runtime path | `src/app/app/_actions/management-decision.ts` |
| Refusal wording | `src/app/app/_actions/decision-messages.ts` |
| Real connected controls | `src/components/spatial/panels/DecisionControls.tsx` |
| TS digest, kept in step with the SQL by test | `src/components/spatial/panels/evidence-digest.ts` |
| Mutation harness | `scripts/r1/mutations/decision-mutations.mjs` |

## Verified

- Decision boundary live suite **31 passed** on real PostgreSQL 16, every call as a real
  `authenticated` session with a real `auth.uid()`
- **All six required mutations CAUGHT**, each with a parsed `Tests N failed` line
- Unit **2331 passed** / 4 skipped · network guard **687 passed**
- typecheck 0 · lint clean · build exit 0 · browser-check pass
- secret-scan · migration-lint · inventory · IP-boundary · requirements audit — all pass

## Open

| Id | State |
|---|---|
| **R2-F-017** | OPEN — `specialist_approval`/`owner_approval` and six decision types have no rule in this repository. The RPC FAILS CLOSED on both. Needs an owner decision |
| R2F-F-003 | queue not scoped by viewer authority (owner vs manager vs staff) |
| R2F-F-004 | no re-observation driver, so a completed task whose condition persists does not reopen |
| R2E-F-001 | legacy `ACTION_FLOORS` vocabulary untouched by design; canonical policy is the authority for catalogue actions |
| R2E-F-002 | UI task path has no durable idempotency — needs a column on the hosted `tasks` table |

## Exact next command and next task

```bash
git -C . rev-parse HEAD && git status --porcelain

# Next dependency-ready item: R2F-F-003 — scope the queue by the viewer's authority.
# It is now unblocked: the decision path exists, so a staff-scoped view no longer shows
# people work they cannot act on. Start from the capability already resolved server-side:
grep -n "viewerMayDecide" src/components/spatial/panels/ManagementQueuePanel.tsx
```

R2F-F-004 (outcome verification by re-observation, roadmap R5) is the larger next piece and should
follow F-003.

## Hard blockers

**One, and it is an owner decision, not a technical one:** R2-F-017. Everything else remains
local-only. Staging and production remain **zero**.

## Full-campaign result, stated exactly

The complete live campaign at `4f31446` ran **457 tests across 24 files in 4453s** and **FAILED with
one test**: `r1-security-baseline > a MANAGER may record a decision`.

That failure was **caused by this session's work and is correct**. The test recorded a decision by
**direct INSERT** under `management_item_decisions_ins` — the policy R2-F-014 identified as a way
past every check, and which draft 022 drops. The test had codified the defect.

It is migrated to the RPC, following the precedent already in that file (the feedback test made the
same move for the same reason). The old version also asserted `expect(true).toBe(true)` — it
required only that the insert not throw. The replacement checks the outcome, and a second test
asserts the direct insert now writes nothing.

**Verified after the fix:** `r1-security-baseline` + `r2-decision-boundary` together —
**69 passed / 0 failed**, 321s, real PostgreSQL 16.

**Not re-run:** the complete 24-file campaign at the final SHA. The single failure is fixed and
verified in a targeted run; the other 23 files were untouched by that fix and passed at `4f31446`.
The exact command is below.

```bash
node scripts/r1/run-r1-security-tests.mjs      # ~20 min on an idle machine
```

**On the 4453s duration** — the baseline for this campaign is ~1200s. The run was slowed by my own
concurrent load (a production build, two full unit suites and a Chromium browser check) and by 13
unrelated containers running on this machine. Progress was measured, not assumed: committed row
counts advanced 216,348 → 221,552 in 60 seconds and the executing query changed between samples.
Two subsequent runs failed at `database never became ready` under the same contention and succeeded
on retry. No timeout was raised, and no unrelated container was touched.
