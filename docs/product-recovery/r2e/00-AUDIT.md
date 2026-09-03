# R2E Batch 1 — audit of the existing approval-to-execution surface

**Local-only.** No hosted contact, no deploy, no merge, no migration number, no live or paid
model, no real data, no message sent, no financial effect.

Baseline: branch `claude/product-recovery-r1`, HEAD `bda274b5cf4bbdb7ed4f3247119557d4ca14f59f`,
`origin/claude/product-recovery-r1` identical, working tree clean.

Findings are registered here **before** any fix, as required.

---

## 1. The headline: there is no execution engine, and the automatic tier is unreachable

Two independent facts, both established by running code rather than by reading it.

**(a) No catalogue action has a handler.** A repository-wide search for the 15 registered action
ids outside `src/kernel/catalogue.ts` returns **nothing**. There is no dispatcher, no handler map,
no execution ledger table, and no `executed` state anywhere in the lifecycle or the schema. The
catalogue is today a *proposal vocabulary* only.

**(b) `mayRunUnattended` is a constant `false`.** Not by policy — by a vocabulary mismatch nobody
recorded. See R2E-F-001.

R2E therefore builds the mechanism; it does not wire up an existing one.

---

## 2. Findings

### R2E-F-001 — the automatic authority tier is unreachable, and no test would notice

`resolveRequiredAuthority` classifies actions against `ACTION_FLOORS`, a **closed list** matched by
exact membership on a normalised key (`src/policy/authority-engine.ts:98`). Unknown actions escalate
to `manager_approval` and set `failedClosed = true`.

Every catalogue id normalises to a key that is **not in that list**. The two lists were written in
different vocabularies: the engine knows `opstaskcreate`; the catalogue registers
`ops.task.create_internal`, which normalises to `opstaskcreateinternal`. Membership is exact, so
nothing matches.

Measured for all 15 actions (`tests/r2e-authority-probe.test.ts`):

| | result |
|---|---|
| `actionFloor(id)` | `null` — **15 of 15** |
| `failedClosed` | `true` — **15 of 15** |
| resolved level | `manager_approval` (13) / `specialist_approval` (2) — never `automatic` |

`recommend.ts:129` computes:

```
mayRunUnattended = required === "automatic" && automaticSafe && reversible
                   && !resolution.failedClosed && evidenceQuality === "sufficient"
```

The first and fourth conjuncts are each independently false for every action. **`mayRunUnattended`
cannot be `true` for any input.** Consequently `assertTransition`'s D-9 bypass
(`recommended → assigned`) is also unreachable from the real pipeline.

**This fails in the safe direction.** It is registered as a finding for three reasons:

1. The catalogue advertises 5 actions as `automatic` + `automaticSafe`
   (`ops.task.create_internal`, `ops.task.reminder_internal`, `ops.task.request_progress_update`,
   `ops.task.escalate_internal`, `system.health.investigate_internal`). That claim is not true of
   the running system. A reader auditing the catalogue would conclude five actions may run
   unattended. None may.
2. **Adding one string to `ACTION_FLOORS` would silently enable unattended execution** for up to
   five actions, with no test failing and no reviewer signal. That is a one-line change with a
   large blast radius.
3. It sets up a false pass for R2E itself: an executor test that *stubs* authority would show the
   allowlisted-action path working, while the same path does nothing in the real pipeline.

**Mutation evidence — the tests do not discriminate.** `mayRunUnattended` was replaced with a
hard-coded `false` and the suite re-run:

| | |
|---|---|
| baseline, `tests/kernel/recommend.test.ts` + `adapters-r2a.test.ts` | 89 passed |
| mutated (`mayRunUnattended: false && (…)`) | 89 passed |
| mutated, **full unit suite** | **2196 passed / 0 failed / 4 skipped, 215 files** |

**SURVIVED.** All 11 existing assertions on this field assert `.toBe(false)`; not one asserts
`true`. The suite is exactly as consistent with a correct computation as with a hardcoded constant.
`src/kernel/cycle-deps.ts:593` persists this always-false value to the database.

Disposition: **not fixed in Batch 1.** Correcting the catalogue/engine vocabulary is an authority
change and belongs to Batch 6 (approval and authority), with the discriminating tests that must
accompany it. A permanent gate pinning the *current* behaviour is added first, so any future change
to it is deliberate and visible.

### R2E-F-002 — the only candidate write path is a form action that swallows its own failure

`ops.task.create_internal` is the one catalogue action whose *effect* already exists in the product,
via `createTask` (`src/app/app/operations/tasks/actions.ts:38`). It is not usable as an execution
handler:

- it takes `FormData`, not typed parameters;
- it derives identity from the **session** (`requireOps()`), so it cannot act for an approved
  request on behalf of another actor;
- **`if (error) return;`** — a failed insert returns normally. An executor calling this would record
  a successful execution while nothing was written. The comment explains it as pre-migration
  tolerance; on an execution path it is a silent-success defect;
- it calls `revalidatePath`, so it is bound to a Next.js request context;
- it audits with the soft `writeAudit`, not `writeAuditStrict`, so a lost audit row does not fail
  the operation.

R2E must not call it. A separate, typed, transactional command is required — and per the standing
instruction, no handler is to be invented for the other 14 merely to fill the matrix.

### R2E-F-003 — no execution ledger, and `management_item_decisions` cannot express an attempt

`management_item_decisions` (draft 004) is append-only and records `approve | reject | edit |
delegate` with `authority_level` and actor. It has **no `execute` value and no attempt, result or
failure columns**. `management_cycle_runs` (draft 011) records cycles, not actions.

There is nowhere to record *"this approved action was attempted, at this time, with this outcome"* —
which is the requirement that prevents duplicate business effects. A new draft unit is needed.

### R2E-F-004 — enablement exists per company, but the kernel switch is global and env-driven

`management_kernel_enablement` (draft 011) is per-company, `enabled boolean not null default false`,
RLS-protected, revoked from `public`/`anon`. That is the right shape and R2E should reuse it.

The kernel's own switch is `kernelGloballyEnabled()` — `MANAGEMENT_KERNEL === "on"`
(`src/kernel/cycle.ts:849`). An environment variable is deployment configuration, which the standing
constraints treat as an owner-approved production boundary. R2E's execution switch must follow
`worker-boundary.ts` instead, not this pattern.

---

## 3. Mechanisms R2E reuses rather than reinvents

| Mechanism | Where | Why it is the right one |
|---|---|---|
| `WORKER_ENABLED = false as const` | `src/kernel/worker-boundary.ts:18` | Hard-coded, **not** an env var, so no deployment configuration can turn it on; refuses loudly with `WorkerDisabledError`; scope comes from the server's enablement table and cannot be passed in by a caller. Precisely the posture R2E requires. |
| `management_kernel_enablement` | draft 011 | Per-company, default false, RLS. |
| `assertTransition` | `src/kernel/lifecycle.ts:161` | Illegal transitions **throw**; terminal states are closed; reason and evidence requirements enforced. |
| `writeAuditStrict` | `src/lib/audit.ts:85` | Fail-closed: throws `AuditError`, so an unaudited mutation is never reported as done. Execution attempts must use this, never `writeAudit`. |
| `resolveRequiredAuthority` + `higherOf` | `authority-engine.ts` / `recommend.ts:101` | Max-of-all-rules; the catalogue floor can only raise, never lower. |
| Outbox lease pattern | `0040_durable_messaging.sql` | `FOR UPDATE SKIP LOCKED`, lease expiry, recovery, dead-lettering. |
| `assertActionRegistered` / `assertInternalOnly` | `src/kernel/invariants.ts` | Already re-checked at proposal time; must be re-checked again at execution time. |

---

## 4. Action matrix

Every catalogue action, as the system stands. **"Existing command/handler" records what is there —
not what could be written.**

| # | Action id | Intended effect | Existing command/handler | Capability | Approval required *today* | Risk | Rev. | Int/Ext | Idempotency | R2E disposition | Evidence | Stale check | Audit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `ops.task.create_internal` | create an internal task | **partial** — `createTask(FormData)`, unusable (F-002) | `operations.task.manage` | `manager_approval` | low | yes | internal | none | **candidate** for local execution via a new typed command | ≥1 ref | task not already created | `task.created` (soft) |
| 2 | `ops.task.reminder_internal` | internal reminder | **none** | `operations.task.work` | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | task still open | none |
| 3 | `ops.task.request_progress_update` | ask for progress | **none** | `operations.task.work` | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | task still open | none |
| 4 | `ops.task.escalate_internal` | escalate overdue work | **none** — `modules/work/follow-up.ts` computes a target, does not act | `operations.task.manage` | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | still overdue | none |
| 5 | `finance.invoice.flag_for_review` | flag invoice for a human | **none** | finance | `specialist_approval` | med | yes | internal | none | draft-only | ≥1 ref | invoice still unpaid | none |
| 6 | `crm.followup.draft_for_human` | draft a follow-up *for a person* | **none** | crm | `manager_approval` | med | yes | internal | none | draft-only | ≥1 ref | conversation still open | none |
| 7 | `workforce.capacity.review_allocation` | request allocation review | **none** | workforce | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | overload persists | none |
| 8 | `governance.directive.chase_internal` | chase a directive | **none** | governance | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | directive open | none |
| 9 | `objectives.objective.review_internal` | request objective review | **none** | objectives | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | objective off-track | none |
| 10 | `marketing.campaign.review_internal` | request campaign review | **none** | marketing | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | campaign live | none |
| 11 | `procurement.stock.review_internal` | request stock review | **none** | procurement | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | stock still low | none |
| 12 | `assets.document.schedule_renewal_internal` | schedule a renewal | **none** | assets | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | not yet renewed | none |
| 13 | `legal.obligation.escalate_internal` | escalate an obligation | **none** | legal | `specialist_approval` | high | yes | internal | none | **prohibited** locally | ≥1 ref | obligation open | none |
| 14 | `providers.provider.review_internal` | request provider review | **none** | providers | `manager_approval` | med | yes | internal | none | draft-only | ≥1 ref | engagement active | none |
| 15 | `system.health.investigate_internal` | raise an internal investigation | **none** | system | `manager_approval` | low | yes | internal | none | draft-only | ≥1 ref | signal still failing | none |

Notes on the columns that matter:

- **"Approval required *today*"** is the *measured* resolution, not the catalogue's `authorityFloor`.
  For rows 1–4 and 15 the catalogue says `automatic`; the engine says `manager_approval` with
  `failedClosed`. Where they disagree, the measured value is what the system does (R2E-F-001).
- **Idempotency: none.** Not one catalogue action has an idempotency key, a natural unique
  constraint, or a dedupe path. The accounting core has `unique (company_id, idempotency_key)`
  (`0002`, `0003`); the kernel has no equivalent. R2E must supply it.
- **Audit: none**, for 14 of 15. Only row 1's underlying form action writes an audit event, and it
  writes it softly.
- **Evidence** is already enforced upstream — `recommend.ts` throws `InvariantViolation`
  (`zero_evidence`) before an action can be proposed at all. R2E must re-check at execution time,
  because approval and execution are separated in time.

---

## 5. What Batch 1 changes

Nothing in product behaviour. One test is added (`tests/r2e-authority-probe.test.ts`) pinning the
measured authority classification of all 15 actions, so that R2E-F-001 cannot change silently.
