# R2E — controlled approval-to-execution engine — report

**Local-only.** No hosted contact, no deploy, no merge, no production migration number, no live or
paid model, no real data, no message sent, no financial effect. Staging and production verification
remain **zero**.

## SHAs

| | |
|---|---|
| Phase start | `bda274b` |
| Batch 1 — audit | `5dc63c2` |
| Batches 2–11 | *(filled at commit)* |

## What was built

One approval-to-execution mechanism. It is easier to describe by what it refuses, because refusing
is what it mostly does: of the 15 registered actions, **13 are draft-only, one is prohibited, and
one may produce an effect** — and that one still needs six further conditions to hold.

Nothing executes in this build. `EXECUTION_GLOBALLY_ENABLED` is `false as const`.

## The findings that shaped it

### R2E-F-001 — the automatic tier was unreachable, and no test would have noticed

The authority engine classifies actions against `ACTION_FLOORS`, a closed list matched by **exact**
membership on a normalised key. Every catalogue id was absent from it — the two lists were written
in different vocabularies (`opstaskcreate` versus `ops.task.create_internal` →
`opstaskcreateinternal`). All 15 actions therefore resolved as unknown, escalated, and set
`failedClosed`.

`mayRunUnattended` requires `required === "automatic"` **and** `!failedClosed`. Both were
independently false for every input, so it was a constant.

It failed safe. What made it a finding is that it was invisible: replacing `mayRunUnattended` with a
hard-coded `false` **survived the entire 2196-test unit suite**, because all eleven existing
assertions on that field assert `false` and none asserts `true`. One string added to `ACTION_FLOORS`
would have switched on unattended execution for five actions with nothing failing.

**Not repaired by widening the matcher.** The owner's direction rules out fuzzy matching, prefix
matching, normalised aliases, fallback tiers, and any mapping that covers several actions at once —
all of which share the property that an action can acquire an authority it was never individually
granted, because it resembles one that was.

Instead there is one exact table, `Record<CatalogueActionId, ActionExecutionPolicy>`, keyed on the
literal union derived from `ACTION_CATALOGUE` itself. Removing a single entry produces:

```
src/kernel/execution/policy.ts(45,7): error TS2741:
  Property '"system.health.investigate_internal"' is missing in type … but required in type
  'Record<"ops.task.create_internal" | … , ActionExecutionPolicy>'
```

A catalogue action without a policy **does not compile**. There is no second list to forget.

Unattended execution stays fail-closed, as directed: no policy carries an `automatic` floor, and a
dedicated expected-policy test fails if one ever does.

### R2E-F-002 — the only candidate write path swallowed its own failure

`createTask` contained `if (error) return;` — a failed insert returned normally, so a caller could
not distinguish "created" from "silently did nothing", and a person saw the form clear with no task
and nothing recorded anywhere.

The business implementation now lives in `createInternalTask`: typed parameters, Zod-validated, and
a **discriminated** result. The UI action is a wrapper that converts `FormData` and nothing else.

**The two callers differ, and the difference is stated rather than hidden.** R2E injects a transport
backed by an atomic RPC and is exactly-once. The UI injects a direct-insert transport with no
deduplication, because supplying one would require an idempotency column on `tasks` — a hosted
production table this phase may not alter. What the UI *does* gain is the end of the silent failure.

The command **cannot assign a person**. There is no `assignedTo` parameter and the RPC accepts no
such argument: an argument a function does not take is an authority it cannot be talked into
exercising.

### R2E-F-003 / F-004 — the ledger and the second switch

`management_item_decisions` records approve/reject/edit/delegate. It has no `execute` value and no
attempt, result or failure columns — nowhere to record that an approved action was *tried*, which is
exactly the record duplicate-prevention depends on.

Draft **021** (quarantined, disposable databases only) adds `management_execution_attempts`, claimed
**before** the handler runs under a unique `(company_id, idempotency_key)` index, append-only once
terminal, with a check constraint that a terminal row must say what happened.

`management_execution_enablement` is a **separate table** from `management_kernel_enablement`,
defaulting to false. Being observed and being acted upon are different powers granted at different
moments; reusing one row would make the more dangerous one a silent consequence of the safer one.

## The ordering of the checks is the safety property

```
global boundary → company enablement → registered & internal-only → exact policy →
classification → handler exists → authority RESOLVED NOW → approval still current →
approver still capable → item state & evidence → durable idempotency key
```

Nothing is written until the second step passes. A globally disabled system performs **no query
about the company it was asked about** — it does not reveal whether that company exists.

Authority is resolved again at execution time rather than read from the recommendation, because
approval and execution are different moments: a capability can be revoked, a delegation can lapse,
and the evidence can stop being true in between.

## Why a crash cannot duplicate an effect

The idempotency key is claimed **before the task exists**. The task id is generated first, the key
row is inserted first, and the unique index arbitrates: one caller's insert survives, that caller
creates the task under the id it already claimed, and everyone else reads the winner's.

The obvious ordering — create the task, then record the key — cannot be made correct. Two concurrent
callers both insert a task before either records a key, so the effect has already happened twice by
the time the database is asked to arbitrate.

## Runtime evidence — real PostgreSQL 16, disposable, no network

```
tests/integration/r2e-execution-ledger.test.ts   18 passed   (4.2s)
```

Including:

| Property | How it was shown |
|---|---|
| Exactly-once under concurrency | **10 concurrent callers on 10 separate connections**, one key → 1 distinct task id, exactly 1 reporting `created=true`, 1 row physically present |
| Crash recovery | handler succeeded, `resolveExecuted` threw — the retry under the same key produced **no second task** |
| A refusal does not consume the key | refused for a missing approval, then approved and executed **under the same key** |
| Disabled writes nothing | zero new rows in `management_execution_attempts` **and** `tasks` |
| Draft-only produces nothing | four draft-only/prohibited actions attempted; `Should never exist` appears **0** times |
| Append-only ledger | terminal rows refuse update, identity rewrite and delete — and the delete is shown not to have happened, by presence rather than by absence of an error |
| Keys are company-scoped | the same key in two companies is two tasks |
| Tasks are unassigned | `assigned_to` is null |

Every storage assertion reads through a **privileged connection with RLS bypassed**. R2D-F-006 is
why: a policy that hides a row makes "deleted" and "hidden" indistinguishable.

## Mutation evidence — the tests discriminate

| Mutation | Result |
|---|---|
| `mayRunUnattended` → hard-coded `false` | **SURVIVED** the full 2196-test suite — this is R2E-F-001, and the gate added in Batch 1 now catches it |
| remove one action's policy entry | **CAUGHT** at compile time (TS2741), naming the action |
| teach `ACTION_FLOORS` a catalogue id | **CAUGHT** — 3 assertions fail, naming the action |
| RPC uses naive check-then-act ordering | **CAUGHT** — 1 failed / 17 passed; **only** the 10-way concurrency test detects it |
| global boundary always allows | **CAUGHT** — 1 failed / 17 passed; **only** the "writes NOTHING" test detects it |

The last two matter most: in each case exactly one test failed, which is the right discrimination
profile. A mutation that fails everything proves the suite is coupled; a mutation that fails the one
test written for it proves that test earns its place.

## Totals

| Gate | Result |
|---|---|
| Unit suite | **2253 passed**, 4 skipped, 218 files |
| R2E live campaign | **18 passed / 0 failed**, real PostgreSQL 16 |
| Typecheck | 0 errors |
| Lint | unchanged from baseline (2 pre-existing `<img>` warnings in `Brand.tsx`) |

## Requirement status

**Nothing is advanced to `locally_verified` by this phase.**

The mechanism is exercised end to end against a real database, but every execution in this campaign
required a token that only a test file can supply. That proves the engine's behaviour; it proves
nothing about a deployment, because there is no deployment on which it can run.

## Gates that remain open

- **The catalogue/engine vocabulary mismatch (R2E-F-001) is recorded, not fixed.** Repairing it is
  an authority change requiring the owner's decision on which — if any — actions should ever run
  unattended, and it must arrive with tests that discriminate the new behaviour.
- **Draft 021 is quarantined**, like every other R1 draft, and is deployment-blocked behind the same
  0069 reconciliation.
- **The UI task path has no durable idempotency.** Giving it one requires altering `tasks`, which
  needs a numbered migration and owner approval.
- **13 actions have no handler**, deliberately. Writing one to complete a table would be a business
  effect nobody specified.
- **The operator window is not wired to a route.** Its data shapes are defined and its presentation
  is tested; the page that supplies real rows is not built, because doing so would put an execution
  surface in the app while execution is off.
- **No staging or production verification.** Zero, by construction.

---

# R2E continuation — 2026-09-05 session

## SHAs

| | |
|---|---|
| Session start | `d4c9b76` |
| Batch A — owner's automatic authority + F-005…F-009 | `c81df97` |
| F-010 — the executor read a column nothing writes | `32d7e36` |
| Batch B — execution state in the queue (F-012) | `28135ec` |
| F-013 — the exact-action gate was untested | `1876133` |
| Batch D — R2F audit and slice selection | `01968a5` |
| R2F slice — cockpit shows management items | `b9c64cb` |

## The owner's decision, implemented narrowly

Exactly one canonical action is automatic: **`ops.task.create_internal`**.

It is an exact literal comparison, not a widening of the legacy `ACTION_FLOORS` list. That list
matches on a **normalised** key — case-folded, unicode-folded, separators stripped — so teaching it
`opstaskcreateinternal` would also have admitted `OPS-TASK-CREATE-INTERNAL`, the fullwidth spelling,
and every other variant that folds to the same thing. The legacy list is untouched and the
R2E-F-001 gate still asserts that no catalogue id appears in it.

`isGenuinelyAutomatic` requires **six** independent facts to agree: the canonical policy floor, the
exact authorised id, the catalogue's `automaticSafe`, `reversible` and `internalOnly`, and the
`locally_executable` classification. A policy floor of `automatic` that the others do not support
resolves to `manager_approval` with `failedClosed`.

## Findings this session, each reproduced before being fixed

| Id | Finding | How it was found |
|---|---|---|
| **F-005** | the idempotency key was caller-supplied | reading the contract against condition 9 |
| **F-006** | nothing checked the evidence was still the evidence approved | reading condition 4 |
| **F-007** | parameters reached the handler unvalidated | `parameters` did not appear in `executor.ts` at all |
| **F-008** | no runtime entrypoint existed | `executeApprovedAction` imported by nothing outside its own directory |
| **F-009** | an automatic action has no human creator, but the schema demanded one | **running the real service** |
| **F-010** | the executor read `proposed_action`, which **nothing writes** | the existing panel read the other column |
| **F-011** | no decision can be recorded through any runtime path | searching for writers; **BLOCKED** |
| **F-012** | the queue showed no execution state | reading the panel's queries |
| **F-013** | the exact-action check in the automatic gate was untested | **mutation testing** |

### F-010 deserves its own note: it was a false pass I introduced

The integration fixture seeded `proposed_action` — the same wrong column the reader read — so the
test and the code agreed with each other and neither agreed with the product. Every item the kernel
actually creates would have refused with `stale_state`.

It is now pinned by a test that creates the item through the **real**
`r1_draft_create_management_item` RPC. Reaching that RPC required satisfying four guards the
fixtures had been bypassing: a service-role **JWT claim** (not merely the database role), an actor
with an **active membership**, an observation source on the RPC's **closed allowlist**, and its
jsonb return envelope. Each is the product working, and each had been invisible while tests wrote
rows directly.

### F-013 is what mutation testing is for

Deleting `actionId === AUTOMATIC_ACTION_ID` broke no test. The remaining conjuncts masked it,
because the only action with an `automatic` floor is already the authorised one — so the guard that
stops a *second* action inheriting automatic execution had nothing watching it. The predicate is now
extracted and asked about synthetic inputs the live table cannot produce.

## Mutation results

| Mutation | Result |
|---|---|
| naive check-then-act ordering in the task RPC | **CAUGHT** — only the 10-way concurrency test |
| global boundary always allows | **CAUGHT** — only the "writes NOTHING" test |
| a policy entry removed | **CAUGHT** at compile time |
| `ACTION_FLOORS` taught a catalogue id | **CAUGHT** — 3 assertions |
| executor reads the dead `proposed_action` column | **CAUGHT** — 7 tests |
| evidence-generation check removed | **CAUGHT** — 2 tests |
| parameter schema made permissive | **CAUGHT** — 1 test |
| identity packing loses its length prefix | **CAUGHT** — 1 test |
| exact-action check removed from the automatic gate | **SURVIVED → F-013 → now CAUGHT** |
| cockpit's unavailable branch disabled | **SURVIVED → fixed → now CAUGHT** (2 tests) |

Two mutations survived. Both were real gaps in the tests, both are recorded as findings, and both
are now caught.

## Limitations, stated

- **The human-approval branch has no live path.** The one executable action is automatic, so
  `loadApproval`, `approval_superseded` and `approver_lacks_capability` are exercised only through
  injected snapshots. F-011 is why: nothing can record a decision.
- **The UI task path still has no durable idempotency** (F-002) — it needs a column on `tasks`.
- **13 actions have no handler**, deliberately.
- **Draft 021 is quarantined** and deployment-blocked behind the same 0069 reconciliation.
- **No route exposes execution.** The service is the only entrypoint and is not wired to HTTP while
  the boundary is closed.

## Requirement status

**Nothing is advanced to `locally_verified` by this session.** Every execution required a token only
a test file can supply. That proves the engine; it proves nothing about a deployment, because there
is no deployment on which it can run.

## Staging and production

**Zero.** Unchanged, by construction.

## Totals — 2026-09-05 session

| Gate | Result |
|---|---|
| **Complete live integration campaign** | **426 passed / 0 failed**, 23 files, 1192s, real PostgreSQL 16 |
| R2E live suite, re-run at final HEAD | **26 passed / 0 failed** |
| Unit suite | **2304 passed**, 4 skipped, 220 files |
| Outbound-network guard | **686 passed**, 25 files |
| Typecheck · lint · build | 0 errors · clean · exit 0 |
| secret-scan | no tracked secrets |
| migration-lint | 109 migrations, sequential 0001–0109, no gaps |
| completion-inventory · IP-boundary · requirements audit | pass · `supabaseAdmin` confined · pass |

The campaign was run with the hardened uniquely-labelled disposable-container runner. No timeout was
raised to obtain a green result, and no unrelated container was touched.
