# 2. Original-vision capability matrix

> **UPDATED 2026-09-02 by the Original Vision Reconciliation.** The register now holds
> **110** requirements (was 90) across **27** groups (was 20), and every record carries a
> **deployment axis** — `verified_local` / `verified_staging` / `verified_production`.
> Current truth: **60 local, 0 staging, 0 production.** That axis exists because of this
> document's central finding: `locally_verified` carried no deployment meaning, which is
> how the register could report 60 verified requirements while the owner experienced a
> quotation app. Twenty new requirement IDs preserve the owner's original vision — see
> [14-VISION-RECONCILIATION.md](14-VISION-RECONCILIATION.md) for the full mapping and the
> five-way separation (retained / adapt / missing / future-gated / incidents).
>
> **This is a mapping view, not a new register.**
> `docs/autonomy/ORIGINAL_VISION_REQUIREMENTS.yaml` remains the single requirement
> register and `docs/autonomy/OPEN_FINDINGS_REGISTER.md` the single findings store, as
> `CLAUDE.md` requires. This document maps the owner's twelve target management domains
> and eleven-step management loop onto that register's existing requirement IDs, and
> adds the one axis the register does not carry: **deployment**.

## 2.0 Classification scheme

The owner asked for six classes. Applied here with explicit definitions:

| Class | Definition used |
|---|---|
| **Complete and operational** | Implemented, tested, *and* reachable by a real user on the deployed host |
| **Implemented, not integrated** | Working code and schema exist and are tested, but nothing in the running product invokes them, or they are not deployed |
| **Partially implemented** | Some of the capability works; a named part is missing |
| **UI shell only** | A surface renders but no meaningful logic or data flow sits behind it |
| **Missing** | No implementation |
| **Blocked by external provider** | Implementation cannot complete without a credential, provider or owner-side configuration |

**A deployment caveat governs the whole matrix.** Only `main` is deployed. Everything
introduced by migrations 0070–0109 or by the 234 branch commits is *at best*
"implemented, not integrated", regardless of how well it is tested. The requirement
register's own totals confirm this from the other direction: of 90 requirements,
**60 are `locally_verified`, and 0 are `staging_verified` or `production_verified`.**

## 2.1 The eleven-step management loop

This is the heart of the assessment. The owner's loop, step by step, against reality.

| # | Loop step | Class | Evidence / gap |
|---|---|---|---|
| 1 | Observe signals from **every** authorised source | **Partially implemented** | One source only: `wa_conversations`, swept by `/api/cron/ai-monitor`. Email (COM-004), voice notes (COM-002), images/documents (COM-003), calendar (COM-005) and data connectors (COM-006) are all `absent` in the register. Internal business state (tasks, budgets, invoices, capacity, stock, contracts) is **never observed at all**. See PR-F-006. |
| 2 | Build evidence-grounded understanding | **Implemented, not integrated** | `management_cases` (0028) + atomic persistence RPC (0068) are genuinely good: evidence-linked, idempotent, transactional. But cases are only ever created from the one signal source in step 1. |
| 3 | Compare against objectives, KPIs, policies, budgets, deadlines, commitments | **Partially implemented** | Real comparators exist and are tested: `objective-status.ts`, `forecast.ts`, budget-vs-actual, `renewals.ts`, commitments, ageing. **They render to dashboards; they do not feed the loop.** No comparator emits a signal that reaches `planFromObservation`. |
| 4 | Detect risks, delays, failures, capacity problems, opportunities | **Partially implemented** | `exceptions.ts`, `alerts.ts`, `health.ts`, `priority.ts` exist and are used by the Command Centre. Detection is deterministic and display-bound, not case-generating. |
| 5 | Prioritise what requires attention | **Complete and operational** (deployed) | `priority.ts` + the exception-led Command Centre with critical/decision/watch/on-track lanes. This is a real strength. |
| 6 | Propose evidence-backed actions | **Partially implemented** | `planFromObservation` produces tasks, clarifications and suggested actions with confidence and audit reasons. Reachable only via the two entry points of step 1. |
| 7 | Obtain human approval per authority rules | **Complete and operational** | `src/policy/authority-engine.ts`, `decide_approval` RPC, authority ceilings, delegation ⊆ delegator, fail-closed escalation, SoD. Ten external review loops. Genuinely strong. |
| 8 | Create, allocate, delegate and supervise work | **Partially implemented** | Creation works (`tasks`, `task_assignments`, dedup via 0071/0073). **Allocation does not** — see PR-F-008. |
| 9 | Monitor progress, intervene when work stalls | **Partially implemented** | `/api/cron/follow-ups` with `evaluateFollowUp`, escalation chain (0103), directive escalation (0099), `task_check_ins`, leave/workload awareness. Strong logic — but on the deployed host it is **never scheduled** (§3.4 of the SHA comparison). |
| 10 | Verify outcomes and completion evidence | **Partially implemented** | `task_evidence` table, `requiresEvidence` on planned tasks, `task-lifecycle.ts`. What is missing is verification *of the recommendation's outcome* — whether the proposed action actually helped. |
| 11 | **Learn from performance, outcomes and owner decisions** | **Missing** | See PR-F-007. |

<a id="pr-f-008"></a>
### PR-F-008 (P1) — Step 8 has no assignment recommender

Register finding **OF-008** (open): *"Nothing proposes an assignee (WRK-002/WRK-005
unbuilt), and there is no queue UI for `needs_routing` work… every capture lands in
`needs_routing`."*

`src/management/routing/route-captured-tasks.ts` routes to a department; it never
selects a person. `WRK-005` (fair assignment and internal/external team formation) is
`absent`. So the loop reliably produces work and then reliably fails to give it to
anyone — the single most damaging break in the chain, because every upstream capability
terminates there.

<a id="pr-f-007"></a>
### PR-F-007 (P1) — Step 11 does not exist

Four register requirements cover learning, and all four are `absent`:

| ID | Title |
|---|---|
| AIM-008 | Outcome measurement and improvement loop |
| IMP-001 | Outcome recording against recommendations |
| IMP-002 | Staff feedback and lessons learned |
| IMP-003 | Versioned playbooks and prompt/evaluation improvement with human approval |

Verified independently: a case-insensitive search for `learning`, `improvement_proposal`
or `feedback_loop` across `src/` returns **one** file — `src/config/flags.ts` — and the
match is the *description string* of a flag that no code reads.

Consequence: the system cannot become more useful over time. It can only repeat its
initial quality. For a product whose premise is an AI that manages a business, this is
the difference between an assistant and an operating system.

## 2.2 The twelve target management domains

"Deployed" means present on `main` and reachable by a user today.

| # | Domain | Class | Deployed | Substance |
|---|---|---|---|---|
| 1 | Owner/CEO command and decision management | **Partially implemented** | partly | `CommandCentrePanel` (458 LOC) is deployed and genuinely good — exception lanes, cash trough forecast, ageing, executive brief. Management **directives** (0096–0099: conflict resolution, escalation) are branch-only and undeployed. |
| 2 | Objectives, KPIs and planning | **Partially implemented** | yes | `objectives` (0018), `objective-status.ts`, admin objectives surface. KPIs are read and displayed; nothing detects objective drift and opens a case. |
| 3 | Projects, tasks, dependencies, operations | **Partially implemented** | partly | Strong: `tasks`, `task_dependencies`, `task_assignments`, `task_progress`, `task_check_ins`, `task_evidence`, capacity, project budget forecast, risks/decisions/scenarios (0107, branch-only). Gap is allocation (PR-F-008). |
| 4 | Staff, skills, workload, leave, performance, coaching | **Partially implemented** | partly | Leave, capacity, availability and workload-aware scheduling exist and are tested. **Skills, performance and coaching are `absent`** (WRK-004). |
| 5 | Finance and accounting | **Complete and operational** | yes | The strongest domain: double-entry core, settlement, reversal, periods, tax, amortization, trial balance, P&L, balance sheet, reconciliation, budgets, forecast, commitments, funding (branch), duplicate review. 31 pages, 17 action files. |
| 6 | CRM, sales, customer identity, follow-ups | **Complete and operational** | yes | Leads, opportunities, accounts, customers, orders, quotations, price confirmations, WhatsApp identity. **Counterparty performance/history is `absent`** (CRM-004). |
| 7 | Marketing and campaigns | **Partially implemented** | yes | `campaigns` + `audiences` + lead scoring are real but thin (352 LOC / 3 pages). No campaign execution, no attribution, no budget linkage. |
| 8 | Procurement, suppliers, inventory | **Partially implemented** | partly | Purchase requests, POs, RFQs, supplier quotations, three-way match, goods receipts, stock movements, inventory. Service-provider registry and counterparty compliance are branch-only. |
| 9 | Assets, fleet and maintenance | **Partially implemented** | partly | Vehicles, drivers, trips, fuel logs, maintenance records, vehicle documents with expiry detection. **AST-001 (asset registry, custody, reservations, utilisation) is `specified` — not built.** |
| 10 | Legal, licences, contracts, compliance | **Partially implemented** | partly | Matters, contracts, licences, obligations, insurances, incidents, risks — 9 pages, 7 action files, expiry detection. Sri Lankan advisory sources + human legal review (RSK-006) `absent`. |
| 11 | External consultants and service providers | **Implemented, not integrated** | **no** | `service_providers` (0101) + counterparty compliance (0102) + UI exist on the branch only. |
| 12 | System health, AI/model budgets, failure recovery | **Partially implemented** | partly | Health signals, ledger integrity report, outbox dead-letter, `/api/health`, admin health. Model gateway with budget policy and failover (0091–0092) is **branch-only**. OPS-003 (backup/restore/rollback drills) and OPS-007 (incident response) are `absent`. |

## 2.3 Register status roll-up (existing register, unmodified)

| Status | Before (90) | **After reconciliation (110)** |
|---|---|---|
| `locally_verified` | 60 | **60** |
| `absent` | 18 | **29** |
| `specified` | 5 | **5** |
| `blocked_owner` | 4 | **6** |
| `deliberately_deferred` | 1 | **4** |
| `implementation_in_progress` | 1 | **2** |
| `foundation_only` | 1 | **2** |
| `implemented_unverified` | 0 | **2** |
| **`staging_verified` / `production_verified`** | **0** | **0** |

The verified count did not move. Twenty requirements were **added**, not completed —
nineteen of them describing work that does not exist, and two (`PRC-001` procurement,
`FIN-009` accounting core) describing substantial shipped code that had **never held a
requirement record** and is therefore `implemented_unverified` until behavioural evidence
is assembled against those records.

The register is unusually honest — it explicitly refuses a completion status without
runtime, test and SHA evidence, and it records that "a schema contract, a feature flag,
a type, a doc, a prompt or a fixture is NOT implementation." That discipline is worth
preserving. Its one blind spot is that `locally_verified` carries no deployment
meaning, which is exactly how a system can be 60-requirements-verified and still
present to its owner as a quotation app.

### Blocked by an external provider or owner configuration

| ID | Status | Blocker |
|---|---|---|
| FOUND-003 | `blocked_owner` | Production-reachable staff/finance intake — needs a live finance classifier model (OF-003) |
| MOD-001 | `blocked_owner` | Live-model evaluation path — needs provider credentials |
| OPS-004 | `blocked_owner` | Staging UAT and browser role testing — needs a staging environment |
| OPS-008 | `blocked_owner` | Monitored production pilot — needs owner authorisation |
| OF-003 | open | Finance classification has no model provider |
| OF-004 / OF-005 | open | Channel-account mapping values and the `operations.inbound.review` capability grant are owner actions |
| COM-008 | `deliberately_deferred` | Live voice — future |

<a id="pr-f-010"></a>
### PR-F-010 (P1) — The V3.1 management-intelligence flags are declared but unwired

`src/config/flags.ts` declares eight owner-gated capability flags. Runtime searches show
only **one** is read by application code:

| Flag | Read by runtime code? |
|---|---|
| `aiGuide` (`V3_1_AI_GUIDE`) | **yes** — `operations/tasks/[id]/page.tsx`, `operations/tasks/actions.ts` |
| `taskDetection` | no |
| `decisionPaths` | no |
| `teamFormation` | no |
| `improvementLoop` | no |
| `managerControlTower` | no |
| `multilingual` | no |
| (remainder) | no |

The only other importer is `/api/health`, which reports the flag snapshot. The file's
own header is candid — "read by NO business logic (shadow only)" — but the effect is
that the six flags corresponding most directly to the owner's stated product
(task detection, decision paths, team formation, improvement loop, manager control
tower) are **specification, not capability.** The register agrees: AIM-004, AIM-005,
AIM-006 are `specified`; AIM-008 is `absent`.

<a id="pr-f-013"></a>
### PR-F-013 (P2) — A failing test on the required HEAD, and a weak test pattern

Measured on `abc7767e`:

```
Test Files  1 failed | 183 passed (184)
     Tests  1 failed | 1362 passed | 2 skipped (1365)
```

`npm run typecheck` is clean.

The failure is `tests/campaign/sch-003-leave-workload-aware-scheduling.test.ts`,
asserting that `src/app/api/cron/follow-ups/route.ts` *contains a multi-line string of
its own source code*. The file has CRLF terminators (confirmed) and the repository has
**no `.gitattributes`**, so the assertion's `\n` never matches on a Windows checkout.

The narrow fix is trivial. The finding worth recording is the pattern: **12 test files
assert on source text.** A source-text assertion verifies that code *looks* a certain
way, not that it *behaves* a certain way — it passes when the behaviour is broken and
fails when the formatting changes, as here. Some of the register's `locally_verified`
evidence rests on this pattern.

<a id="pr-f-015"></a>
### PR-F-015 (P2) — `CLAUDE.md` is materially stale

`CLAUDE.md` is declared authoritative for any coding agent. It currently states that
migrations 0048–0067 are *"NOT merged, NOT deployed, hosted DB NOT migrated"* and sit on
`feature/v3-1-phase-1-external-review-fixes` awaiting external approval. In fact
**0048–0067 are on `main`**, which is the deployed branch. It also cites *"unit 419
(79 files); integration 41 files / 321 tests"* against a measured 1365 tests / 184 unit
files and 75 integration files.

An agent following `CLAUDE.md` literally would reason from a repository state that has
not existed for weeks. Correcting it is a prerequisite of any autonomous continuation.
