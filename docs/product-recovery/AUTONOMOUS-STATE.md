# Autonomous state — resumption record

Updated after every checkpoint and before any unavoidable response.

---

## Position

| | |
|---|---|
| Repository | `MUA1234/bot_business_Singha` |
| Branch | `claude/product-recovery-r1` |
| Phase | **R5** — completion claim, runtime composition, operations slice, learning audit |
| Working tree | clean |
| Staging / production | **zero**. Nothing deployed, nothing merged, no hosted contact |

## What this checkpoint did

Four batches, in the owner's dependency order.

**1. A secure completion-claim runtime boundary.** Draft unit **026** —
`management_completion_claims` and `r1_draft_claim_task_completion`. Only the person currently
assigned the linked task may report that work complete. The claimant is `auth.uid()`; the company
comes from the item; a manager, a company owner, the item's accountable owner, the AI, the cycle
and the service role are all refused. The RPC is granted to `authenticated` only — `service_role`
is explicitly revoked, which is the hole the suite found in my own first version.

**2. `verificationSweep` is a real dependency.** It was optional and `makeCycleDeps` did not
provide it, so the deployed system verified nothing and said so with a summary of zeroes —
indistinguishable from a company with nothing pending. It is now required (omission fails at
compile time), constructed by the real factory, and reports an explicit `unavailableReason` with
`partial: true` when a transport cannot reach the schema. One implementation, two transports
behind a `VerificationStore` port; a parity test compares them field for field.

**3. The operations slice, driven end to end** as far as runtime code permits — and honest about
where it does not.

**4. Learning stays disconnected**, with the precise reasons registered.

## Findings

| Id | Statement | State |
|---|---|---|
| **R2F-F-014** | Four spans of the lifecycle have **no runtime writer**: `observed → understood → prioritised → recommended → awaiting_approval`, `approved → assigned`, `assigned → monitoring`, and `accountable_owner_id` is never set. An item is created in `observed` and stays there, so the decision RPC, the claim RPC and verification are all real, all tested and all **unreachable by a real item**. | **open, blocking** |
| **R2F-F-017** | The executor compares the item's evidence digest against the newest recommendation snapshot's `evidence_refs`, and the cycle fills those with the **candidate's eligibility** evidence. Different record sets, compared for equality — so no cycle-created item can execute an automatic action. The R2E suite passes because its fixture writes the item's refs, a shape nothing produces. | **open, blocking**; refusal asserted live in the slice |
| **R2F-F-015** | `POLARITY.reopened = -1` regardless of source. What keeps a machine `condition_persists` out of a person's record is the **actor discipline**, not the polarity table. | open, pinned by a 12-test gate; unreachable today |
| **R2F-F-016** | The queue's decision-capability checks use the read client, which is the service role by default and has no `auth.uid()`, so `has_capability` answers "no" for everyone. | open; the completion path uses the request-bound client |
| **R2F-F-011** | `completeTask` gates on `requireOps()` and never checks `assigned_to`. | open, out of scope; the claim boundary does not rely on it |
| **R2F-F-005** | Consultant access deliberately fail-closed; the owner has ruled out relaxing `internal_access`. | future original-scope work |
| R2F-F-004 remainder | Eleven domains have no verification rule; each is concluded `unavailable` naming itself. | open by design |
| **R2F-F-008** | Superseded by R2F-F-014, which names the missing hops exactly. | closed |
| `verificationSweep` not wired | Closed by batch 2. | closed |

Also corrected: `r2-decision-boundary` carried an assertion that had **never run green**, because
the campaign at the previous checkpoint was deferred. The previous checkpoint was therefore not
green and nothing said so.

## Verified at this SHA

| Suite | Result |
|---|---|
| `r2-completion-claim` (live) | **37 passed** |
| `r2-cycle-composition` (live) | **7 passed** |
| `r2-operations-slice` (live) | **3 passed** |
| `r2-verification-schedule` (live) | 20 passed |
| `r2-outcome-verification` (live) | 15 passed |
| `r2-decision-boundary` (live) | 31 passed (one assertion corrected) |
| `r2-authority-and-scope`, `r2e-execution-ledger`, `r1-runtime-e2e`, `r1-atomic-create`, `r2b-learning-e2e`, `r2c-role-routing` | 184 passed together |
| `r1-security-baseline`, `r1-adapter-ingest`, `r2b-capability-routing`, `r2b-feedback-runtime` | passed |
| `r1-vertical-slice-campaign`, `r2s-loader-contract` | 71 passed (in isolation) |
| `r2s-p-pagination`, `-cursor-handoff`, `-reconcile-fairness`, `-fence-and-reset` | 67 passed |
| Full unit suite | **2395 passed** / 4 skipped, 224 files |
| typecheck · lint · build | clean · clean · clean |

**Mutations — `claim-mutations.mjs`, 11 applied against a real database, all CAUGHT:** assignee
comparison removed; accountable owner alone sufficient; `service_role` granted EXECUTE; an
unfinished task accepted; the claim time from `tasks.updated_at`; the claim marking the item
verified; the capability check dropped; a conflicting retry answered with the first claim; the
evidence binding dropped; the item lock removed; the item–task link check dropped.

## Host measurements

| | |
|---|---|
| unrelated containers | **16–17** throughout |
| four paging suites | **1488s** — roughly five times a quiet-host baseline |
| six suites in one campaign | four tests **timed out**; every one of them **passed in isolation** |
| canonical complete campaign | **`blocked_environment`** — not attempted at one SHA |

Timeouts were not weakened to get a green result. The combined-run failures are a contention
symptom, and the isolation runs are the evidence for that claim.

```bash
node scripts/r1/run-r1-security-tests.mjs   # the canonical command, for a quieter host
```

Not re-run at this SHA: `r2d-ask-ai`, `r2d-adversarial`, `r2d-non-execution`,
`r2d-saved-answer-access`, `r2d-retention-purge`, `r2s-p-tail-liveness`, `r2s-p-batch-lookup`,
`r2s-p-incremental-highwater`. The five `r2d-*` suites touch nothing changed here.

## Exact next command and next task

```bash
git -C . rev-parse HEAD && git status --porcelain
docker ps -q | wc -l          # run the canonical campaign when this is low
node scripts/r1/run-r1-security-tests.mjs
```

**The next dependency on the existing roadmap is R2F-F-014**: the management loop has no writer
between `observed` and `assigned`. Until an item can be advanced, prioritised, routed and assigned
by the system, the decision boundary, the completion claim and outcome verification are three
correct mechanisms with nothing to operate on. That is a product decision about prioritisation and
routing authority before it is a coding task, and it is **not** authorised by any instruction so
far.

**R2F-F-017 is the smaller and more urgent of the two**, and is a contract question: which digest
should the executor's freshness check compare? It belongs with whoever owns the recommendation
snapshot contract.

## Hard blockers

**Two product decisions** (R2F-F-014, R2F-F-017) and **one environment blocker** (host contention).
Staging and production remain **zero**.
