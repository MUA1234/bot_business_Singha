# Autonomous state — resumption record

Updated after every checkpoint and before any unavoidable response.

---

## Position

| | |
|---|---|
| Repository | `MUA1234/bot_business_Singha` |
| Branch | `claude/product-recovery-r1` |
| Phase | **R5** — evidence contracts, the lifecycle orchestrator, assignment, learning identities |
| Staging / production | **zero**. Nothing deployed, nothing merged, no hosted contact |

## What this checkpoint did

**The management loop now runs end to end**, from a detector observing a real condition to a
verification recording a truthful outcome — with every human boundary held by a person and every
service boundary held by the service.

1. **R2F-F-017 closed.** The executor compared the item's CONDITION evidence against the
   recommendation's CANDIDATE-ELIGIBILITY evidence. Two record sets about two different subjects,
   compared for equality, so no cycle-created item could ever execute. Draft **027** records both
   separately and each is now checked where it means something: condition at execution, eligibility
   at assignment.
2. **R2F-F-014 closed.** `src/kernel/orchestrator.ts` is the one place that decides the next
   transition. One step per item per cycle, every write through `r1_draft_transition_item()`.
3. **Assignment is a human act.** Draft **028**'s `r1_draft_assign_management_item` writes the
   task's assignee and the item's accountable owner in one act from one resolved membership.
4. **Learning knows who is who.** `OutcomeRecord` carries six distinct identities instead of one
   standing in for all of them, and five new admissibility rules — every one a tightening.

## The lifecycle actor matrix

| Transition | Actor | Enforced by |
|---|---|---|
| → `observed` | service | service-only create RPC |
| `observed` → `understood` → `prioritised` → `recommended` | service | orchestrator + DB map |
| `recommended` → `awaiting_approval` | service | orchestrator |
| `recommended` → `approved` | service, **automatic authority only** | draft 028 gate on the item's own columns |
| `awaiting_approval` → `approved`/`rejected` | **human** | decision RPC, `auth.uid()`, service revoked |
| execute `ops.task.create_internal` | service | two boundaries + policy + authority + freshness |
| `approved` → `needs_routing` | service | orchestrator, after the effect exists |
| → `assigned` | **human manager** | assignment RPC, `operations.task.manage`, service revoked |
| `assigned` → `monitoring` | service | only when owner and assignee agree |
| `monitoring` → `verifying` | **staff assignee only** | claim RPC, `auth.uid()` = `tasks.assigned_to` |
| `verifying` → `verified`/`reopened` | service verifier | `actor_type='system'`, null actor |

A language model appears nowhere in it.

## Findings

| Id | Statement | State |
|---|---|---|
| **R2F-F-014** | four spans of the lifecycle had no runtime writer | **closed** |
| **R2F-F-017** | condition evidence compared against candidate-eligibility evidence | **closed** |
| **R2F-F-018** | an automatically-authorised item could not reach `approved` | **closed** (draft 028) |
| **R2F-F-021** | the executor read approver capabilities from the legacy table only | **closed** |
| **R2F-F-019** | no server path provides the execution SQL transport; the executor needs direct SQL and the request path speaks PostgREST | **open**; the factory reports it explicitly and marks the cycle partial |
| **R2F-F-020** | the authority engine fails closed on a null actor membership, so no cycle-created item resolves to `automatic` | **open, deliberately unrepaired** — lowering it would weaken an authority control |
| **R2F-F-015** | `POLARITY.reopened = -1` regardless of source | open, pinned by a permanent gate |
| **R2F-F-016** | the queue reads through the service-role client unless `RLS_READS=on` | open |
| **R2F-F-011** | `completeTask` never checks `assigned_to` | open, out of scope |
| **R2F-F-005** | consultant access deliberately fail-closed | future original-scope work |

## Verified at this SHA

| Suite | Result |
|---|---|
| `r2-evidence-contracts` (live) | **8 passed** — every item created by the real cycle |
| `r2-lifecycle-orchestrator` (live) | **14 passed** — through `makeCycleDeps` with the real defaults |
| `r2-assignment-boundary` (live) | **17 passed** |
| `management-queue-assignment` (unit) | 14 passed |
| `r2e-execution-ledger` (live) | 26 passed (fixture corrected to the production shape) |
| `r2-operations-slice` (live) | 3 passed |
| `r2-completion-claim`, `r2-cycle-composition` | 37 + 7 passed (earlier SHA) |
| Full unit suite | **2425 passed** / 4 skipped, 225 files |
| typecheck · lint | clean · clean |

Two substitutions are stated in the orchestrator suite rather than glossed: the HTTP transport
(`pgSupabase`, the repository's established substitution), and the execution SQL transport, which is
injected because **no server path has one** (R2F-F-019).

Execution stays off at the global boundary. The deployed-shaped graph reaches `approved` and records
`global_boundary_disabled`; only a graph handed the deterministic local token creates the effect.

## Mutations

`scripts/r1/mutations/lifecycle-assignment-mutations.mjs` encodes **19** mutations from the
owner's adversarial list. Each runs against the suite that should catch it; a subset may be named
on the command line.

| Verdict | Mutation |
|---|---|
| CAUGHT | L1 the orchestrator records its advances as a person's act |
| CAUGHT | L2 the automatic path is opened to every catalogue action *(after strengthening — see below)* |
| CAUGHT | L6 `assigned → monitoring` ignores the assignee/owner mismatch *(after a missing test was added)* |
| CAUGHT | A1 the assigner's capability is not checked |
| INCONCLUSIVE | A5, A7, A11 — the harness could not start a database under host contention |
| not run | L3, L4, L5, L7, A2, A3, A4, A6, A8, A9, A10, A12 |

**Two survived, and both were worth finding.**

*L6* survived because draft 028 writes the item's owner and the task's assignee in one act, so no
test had ever made them disagree — a guard defending a state the tests never construct. A test now
constructs it and requires an explicit HOLD.

*L2* survived **correctly**: `hasPlan` already gates the branch, because `planAction` returns null
for every action but the authorised one. The action test alone is redundant; the PAIR is the guard.
The mutation was strengthened to remove both, a test was added that approves a DRAFT-ONLY action and
requires the system does not even attempt it, and it is now CAUGHT.

Three commits captured a mutated source file mid-campaign — a deliberately disabled guard. Each was
corrected in place, and a campaign now takes `.r1-mutation-campaign.lock` with a `.githooks`
pre-commit hook that refuses while it is held.

```bash
node scripts/r1/mutations/lifecycle-assignment-mutations.mjs                     # all nineteen
node scripts/r1/mutations/lifecycle-assignment-mutations.mjs L3,L4,L5,L7         # the rest of L
node scripts/r1/mutations/evidence-contract-mutations.mjs                        # R2F-F-017, 10 more
```

## Host measurements

| | |
|---|---|
| unrelated containers | **15–18** throughout |
| one two-suite campaign | **665–960s** — roughly five times a quiet-host baseline |
| one campaign | failed with **"database never became ready"** and passed on retry, unchanged |
| canonical complete campaign | **`blocked_environment`** — not attempted at one SHA |

No timeout was weakened and no test was skipped.

```bash
node scripts/r1/run-r1-security-tests.mjs   # the canonical command, for a quieter host
```

## Exact next command and next task

```bash
git -C . rev-parse HEAD && git status --porcelain
docker ps -q | wc -l          # run the canonical campaign when this is low
node scripts/r1/run-r1-security-tests.mjs
```

**The next dependency on the existing roadmap is R2F-F-019**: a PostgREST transport for the
execution ledger and its four loaders, so the deployed request path can carry out the one action it
is registered to carry out. It is the same shape as the verification store's Supabase adapter and
needs no new owner decision.

**R2F-F-020 needs an owner decision**, not code: whether an unattended cycle may resolve `automatic`
authority when there is no actor membership by construction. Today it cannot, and the manual
approval path covers the gap.

## Hard blockers

**One product decision** (R2F-F-020), **one piece of registered engineering** (R2F-F-019) and **one
environment blocker** (host contention). Staging and production remain **zero**.
