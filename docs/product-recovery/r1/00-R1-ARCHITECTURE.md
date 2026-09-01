# R1 — Cross-department management kernel: architecture and acceptance specification

**Checkpoint 1 of 7. Design only — no product code, no migration, no database change.**

| | |
|---|---|
| Branch | `claude/product-recovery-r1` |
| Created from | `65ee96a133626556c5279ca87c2dc50031837317` (approved reconciliation checkpoint) |
| Controlling baseline | the **110-requirement** register, `docs/autonomy/ORIGINAL_VISION_REQUIREMENTS.yaml` |
| Status | **awaiting owner and Codex approval — implementation not started** |

## 1. What R1 proves

The smallest **complete** management loop, running across **five departments at once**:

```
observe → understand → prioritise → recommend → approve (where required)
   → assign → monitor → escalate → verify outcome → learn
```

R1 is deliberately **not** a WhatsApp or sales demonstration. Sales/CRM appears as *one
of five* observation sources, at the same altitude as finance, workforce, operations and
system health. If the slice can only be demonstrated through a customer message, R1 has
failed its purpose.

**Design stance: a deterministic kernel with bounded departmental detectors and explicit
action adapters — not one large AI service.** Exactly one step (understand) may call a
model, it is bounded and metered, and the loop completes without it.

## 2. Components retained UNCHANGED

Nothing below is modified by R1. This is the majority of the slice.

| Component | Used for | Why unchanged |
|---|---|---|
| `src/policy/authority-engine.ts` — `resolveRequiredAuthority`, `LADDER`, `actionFloor`, `AuthorityResolution` | step 5 authority | Deterministic, fail-closed, ten review loops. The kernel **consumes** it |
| `src/policy/authority.ts` — `checkAuthority`, `checkSeparationOfDuties`, `evaluatePolicy` | approval boundary | ditto |
| `decide_approval`, `approval_requests`, `approval_actions` | existing approvals | **Untouched.** See §6.3 — the kernel never widens the finance approval contract |
| `src/accounting/*`, all finance RPCs | — | R1 **reads** finance state; it never posts, settles or reverses |
| `src/lib/audit.ts` — `writeAudit`, `writeAuditStrict`, `audit_events` | step 10 audit | Existing schema is sufficient: `company_id, actor_type, actor_id, action, entity_type, entity_id, correlation_id, payload` |
| `src/modules/work/task-lifecycle.ts` — `TaskState`, `TRANSITIONS`, `canTransition`, `assertTransition` | spawned work | The item's *work* is an ordinary task in the existing lifecycle |
| `src/modules/work/availability.ts` — `evaluateAvailability`, `rankAvailableCandidates`, `isOnLeave` | step 6 assignment | Already leave- and workload-aware and tested |
| `src/management/ai-manager/exceptions.ts` — `detectTaskExceptions`, `detectCapacityExceptions`, `sortBySeverity` | detectors | Pure, tested. **Wrapped**, not rewritten |
| `src/management/ai-manager/priority.ts`, `pipeline.ts` (`planFromObservation`, `authorityFloor`, `inferDomain`) | steps 3–4 | Already correct |
| `src/modules/finance/aging.ts` (`ageItems`, `bucketFor`), `budget-vs-actual.ts`, `cash-position.ts` | finance detector | Pure, tested |
| `src/lib/health-signals.ts` — `outboxAgeLevel`, `ledgerIntegrityLevel`, `backlogLevel`, `worstLevel` | health detector | Pure, tested |
| `src/ai/gateway.ts`, model policy router, cost ledger | step 2 understand | The **only** model path; every kernel call metered |
| Spatial workspace: `windowSpecs.ts`, `WindowRegistry`, `WorkspaceProvider`, `reducer`, `SpatialWindow` | presentation | **Extended by one registry entry**, not redesigned |
| RLS policies, capability matrix, composite company FKs | isolation | Untouched |

## 3. Requirement coverage — every R1 behaviour mapped to the register

| R1 behaviour | Requirement IDs |
|---|---|
| One domain-agnostic kernel running the loop | **KRN-001** |
| Typed observation sources across five departments | **KRN-002** |
| Registered action catalogue; AI selects, never invents | **KRN-003**, FOUND-005 |
| Evidence-grounded case with provenance | AIM-001, MEM-001 |
| Deduplication of repeated observations | AIM-002 |
| Deterministic company-scoped authority | FOUND-004 |
| Approval, rejection, editing, delegation | GOV-005, FOUND-004 |
| Assignment proposal with availability and workload | **WRK-005** (partial — proposal only) |
| Monitoring, reminders, escalation | SCH-002, SCH-004, SCH-003 |
| Outcome verification by re-observation | loop step 10b, precursor to **AIM-008** |
| Feedback captured for later learning | **IMP-001** (capture only — no learning applied in R1) |
| Finance exception detector | FIN-002, FIN-006, CTL-001 |
| Staff/workload detector | WRK-002, WRK-001 |
| Project/operational task detector | PRJ-001, SCH-006 |
| Customer/CRM follow-up detector | CRM-001, SCH-002 |
| System-health / provider-failure detector | OPS-001, CTL-003, MOD-003 |
| Owner cockpit — one evidence-grounded queue | CTL-001, **UX-001** |
| Audit trail from observation to outcome | GOV-006, OPS-002 |

**Explicitly OUT of R1 scope:** WMP-001/002/003 (marketplace and points — guardrails
first, and both are owner-gated), AIM-009 (Ask-AI), LNG-002, CSA-001/002, GTD-001/002/003,
IMP-002/003 (applying learning), WRK-006/007. R1 **captures** learning feedback; it does
not act on it.

## 4. The management-item lifecycle

### 4.1 States

Mirrors the proven `task-lifecycle.ts` pattern — an explicit transition map, a pure
`canTransition`, and an `assertTransition` that throws. Not a new invention.

| State | Meaning |
|---|---|
| `observed` | A detector emitted an observation; evidence captured |
| `understood` | Interpretation attached (model or deterministic fallback) |
| `prioritised` | Severity, urgency, confidence assigned |
| `recommended` | A catalogue action proposed with cited evidence |
| `awaiting_approval` | Authority above `automatic`; a human decision is required |
| `approved` | Human approved (possibly an edited or delegated variant) |
| `rejected` | Human rejected — terminal, with a recorded reason |
| `assigned` | An accountable owner holds it; a task exists |
| `monitoring` | Work in flight; deadline tracked |
| `escalated` | Stalled or overdue; escalation path engaged |
| `verifying` | Work reported complete; re-observation pending |
| `verified` | Re-observation confirms the condition is resolved — terminal |
| `reopened` | Re-observation shows the condition persists |
| `dismissed` | Not a real issue — terminal, with a recorded reason |
| `expired` | Source record became stale/irrelevant — terminal |

### 4.2 Allowed transitions

```
observed        → understood, dismissed, expired
understood      → prioritised, dismissed, expired
prioritised     → recommended, dismissed, expired
recommended     → awaiting_approval, assigned, dismissed, expired
awaiting_approval → approved, rejected, expired
approved        → assigned, expired
assigned        → monitoring, escalated, dismissed
monitoring      → verifying, escalated, dismissed
escalated       → monitoring, verifying, dismissed
verifying       → verified, reopened
reopened        → prioritised, assigned, dismissed
verified        → (terminal)
rejected        → (terminal)
dismissed       → (terminal)
expired         → (terminal)
```

`recommended → assigned` skips approval **only** when the resolved authority is
`automatic` **and** the action is catalogue-registered as low-risk and reversible (D-9).
Every other path must pass `awaiting_approval`.

### 4.3 Transition rules

1. Every transition is **append-only** to `management_item_transitions`, with actor,
   actor type, reason and evidence.
2. An **illegal transition throws** — it is never silently ignored.
3. Terminal states accept no further transitions.
4. Concurrency: a transition takes `FOR UPDATE` on the item row and asserts the expected
   `from` state, so two concurrent writers cannot both advance it (see §8 tests).
5. **Dismiss and reject require a reason.** A blank reason is refused — the reason is the
   learning signal.

## 5. Departmental observation adapters

Five bounded detectors. Each implements one contract; none calls a model; none creates a
case. All are `company_id`-scoped.

| # | Adapter | Reads | Wraps (existing, unchanged) | Emits |
|---|---|---|---|---|
| 1 | `finance.receivable_overdue` | `customer_invoices` | `ageItems`, `bucketFor` | invoice overdue past its ageing bucket with amount outstanding |
| 2 | `workforce.capacity_overload` | `capacity_snapshots`, `leave_requests` | `detectCapacityExceptions`, `evaluateAvailability` | a person overloaded, or work assigned to someone on approved leave |
| 3 | `operations.task_stalled` | `tasks`, `task_check_ins` | `detectTaskExceptions` | overdue, blocked, or stale check-in |
| 4 | `crm.followup_due` | `wa_conversations`, `leads`, `opportunities` | follow-up evaluation | a customer awaiting a response past the agreed window |
| 5 | `system.health_degraded` | `message_outbox`, `ai_model_attempts`, ledger integrity | `outboxAgeLevel`, `ledgerIntegrityLevel`, `worstLevel` | failed outbox rows, provider failure, ledger integrity issue |

### 5.1 The observation contract

```ts
interface Observation {
  companyId: string;          // never crosses companies
  department: string;         // finance | workforce | operations | crm | system
  kind: string;               // e.g. "receivable_overdue"
  subjectRef: { table: string; id: string };
  evidence: EvidenceRef[];    // references to real rows — never copied prose
  facts: Record<string, JsonValue>;  // STRUCTURED and deterministic
  detectedAt: string;
  identityKey: string;        // company + kind + subject + occurrence window
}
```

**`facts` is structured, never prose.** The detector states *"invoice 123 is 47 days
overdue, LKR 480,000, 3 prior reminders"*. It does not state *"this looks bad"*.
Interpretation belongs to the kernel; keeping it there is what prevents five
intelligences re-emerging.

**Fail-closed:** a detector that throws does **not** return an empty list. It records a
scan failure and the cockpit reports that department as **unobserved** — never as "all
clear". This mirrors the Command Centre's existing honest degradation.

## 6. Authority, approval and safety boundaries

### 6.1 The AI cannot invent facts

- `facts` come from **detectors reading real rows**, never from a model.
- The model sees a bounded context pack and returns a **Zod-validated**
  `ManagementObservation`. Invalid, timed-out or over-budget output ⇒ the item proceeds
  with `interpretation: none`, reduced confidence, and a recorded reason.
- **Every recommendation cites `evidence_refs`.** An item that reaches `recommended`
  with zero evidence references is refused by an invariant, not by convention.
- Untrusted content (customer messages, documents) is fenced and labelled; it can never
  set identity, company scope or authority (FOUND-005).

### 6.2 The action catalogue

The kernel may only propose **registered** actions. R1 registers a deliberately small,
low-risk set:

| Action | Authority floor | Reversible |
|---|---|---|
| `ops.task.create_internal` | `automatic` | yes |
| `ops.task.reminder_internal` | `automatic` | yes |
| `ops.task.request_progress_update` | `automatic` | yes |
| `ops.task.escalate_internal` | `automatic` (approved playbook) | yes |
| `finance.invoice.flag_for_review` | `policy_controlled` | yes |
| `crm.followup.draft_for_human` | `manager_approval` | yes — **drafts only, never sends** |

**No action in R1 sends a customer message, moves money, posts a journal, changes a
permission, or touches an external system.** Anything above the ceiling is proposed and
handed to the existing human path.

### 6.3 Existing controls stay untouched

`approval_requests` is bound to `financial_event_id` — a finance-shaped contract. R1
**does not widen it**. The kernel records its own decisions in an append-only
`management_item_decisions` table. Where a recommendation implies a controlled action
(posting, settling, paying, sending), the kernel **never performs it**: it produces a
task for the existing human-operated surface, which retains its own controls unchanged.

This is the single most important design decision in R1: **the kernel is additive. It
grants no new power to anyone.**

### 6.4 Company isolation

Every kernel table carries `company_id` with RLS and composite company FKs, matching the
existing pattern. A detector scans one company at a time. An evidence reference whose
`company_id` differs from the item's is an invariant violation, refused at write time.

## 7. Presentation — existing spatial workspace only

**No independent UI/UX design.** One new entry in the existing `WINDOW_SPECS` registry:

```ts
{ type: "management-queue", label: "Management Queue", icon: "inbox",
  requiredCapabilities: [], singleton: true,
  defaultWidth: 780, defaultHeight: 620, defaultPriority: "critical" }
```

It renders through the existing `WindowRegistry` → `RENDERERS` map, inside the existing
`SpatialWindow`, using existing `Card`/`Badge`/`DataTable`/`EmptyState` primitives, and
inherits the flat 2D fallback, reduced-motion mode and mobile stacked mode required by
UX-001/D-5. The Command Centre gains one queue summary section reusing its existing lane
pattern.

Each queue row shows the owner's required fields: company and department, source record
and evidence, detected issue, priority and confidence, proposed next action, recommended
resource, authority requirement, accountable owner, deadline and monitoring state,
escalation path, outcome, audit history, feedback.

## 8. Acceptance scenarios (measurable, behavioural)

Behavioural assertions only — **no source-text appearance assertions** (safeguard 5).

### Cross-department completeness
| # | Scenario | Pass condition |
|---|---|---|
| A1 | Seed one condition in each of the five departments | Five items appear in one queue, each with correct department, evidence and priority |
| A2 | Full loop on a finance item | `observed → … → verified`, every transition audited |
| A3 | Re-observation still failing | `verifying → reopened`, not `verified` |
| A4 | Model unavailable | Loop completes deterministically; confidence lowered; reason recorded |

### Isolation and authority
| # | Scenario | Pass condition |
|---|---|---|
| B1 | Two companies with identical conditions | Neither queue shows the other's item; evidence never crosses |
| B2 | Action above `automatic` | Cannot reach `assigned` without a recorded human decision |
| B3 | Unauthorised user attempts approval | Refused and audited; state unchanged |
| B4 | Permission removed while item is open | Item becomes non-actionable for that user immediately; no orphan authority |
| B5 | Delegated approval outside delegator's authority | Refused (delegation is a subset, never an expansion) |
| B6 | Approver edits the recommendation before approving | Edited variant is what gets assigned; original and edit both retained |

### Evidence integrity
| # | Scenario | Pass condition |
|---|---|---|
| C1 | Recommendation with zero evidence refs | Refused by invariant |
| C2 | Contradictory evidence | Item raises a clarification, does not recommend |
| C3 | Missing evidence (row deleted) | Item → `expired`, reason recorded; no crash |
| C4 | Model returns a fact absent from evidence | Rejected at validation; recorded as malformed output |

### Duplication, staleness, concurrency
| # | Scenario | Pass condition |
|---|---|---|
| D1 | Same condition scanned twice | One item (identity key); no duplicate |
| D2 | Condition recurs in a new occurrence window | A new item is correct |
| D3 | Source record changes after observation | Item detects staleness and re-observes before acting |
| D4 | Two concurrent transitions on one item | Exactly one succeeds; the other fails on the expected-state assertion |
| D5 | Two concurrent approvals | One decision recorded; the second refused as a conflict |

### Truthful states
| # | Scenario | Pass condition |
|---|---|---|
| E1 | No items | "Nothing needs attention" — an **empty** state, not an error |
| E2 | One detector throws | That department shows **unobserved**; no all-clear is given |
| E3 | Blocked by missing approval | Blocked state names the required authority |
| E4 | Retry after failure | Retry succeeds without duplicating the item |

### Audit
| # | Scenario | Pass condition |
|---|---|---|
| F1 | Completed item | Audit reconstructs observation → evidence → interpretation → recommendation → decision → assignment → monitoring → verification, with actor and actor type on every step |
| F2 | Rejected item | Rejection reason present and attributable |

## 9. Planned migrations

**None applied.** Designed for a later checkpoint, additive only, no change to any
existing table's semantics:

| Table | Purpose |
|---|---|
| `management_items` | the loop instance: company, department, kind, subject ref, state, priority, confidence, authority, accountable owner, deadline, monitoring state, outcome, `identity_key` unique per company |
| `management_item_transitions` | append-only state history: from, to, actor, actor type, reason, evidence |
| `management_item_evidence` | evidence references with source table, row id and captured facts |
| `management_item_decisions` | approve / reject / edit / delegate, with reason and actor — **kernel-owned; does not touch `approval_requests`** |
| `observation_sources` | registry: department, kind, cadence, enabled, last scan, last failure |
| `management_item_feedback` | outcome and decision-reason capture for later learning (IMP-001) |

Extends rather than replaces `management_cases`: an item **links** to a case where one
exists. Migration numbers must be assigned **above the deployed high-water mark** once
PR-F-001 is resolved — R1 must not add to the `0069` collision.

## 10. Unresolved owner decisions

Recorded before implementing around them, as instructed.

| # | Decision needed | R1 assumption if unanswered | Risk |
|---|---|---|---|
| **R1-D-1** | Migration numbering, given the unresolved `0069` collision (PR-F-001) and unknown hosted state (PR-F-004) | Author migrations **unnumbered** in a staging folder; assign numbers only after R2 reconciliation | Blocks checkpoint 2 from being applied anywhere; design and tests proceed on disposable local PostgreSQL |
| **R1-D-2** | Does the kernel write to `management_cases` or only link to it? | **Link only.** R1 does not alter the atomic-case RPC or its service-only boundary | Low |
| **R1-D-3** | Who is the default accountable owner when no assignee can be proposed (WRK-005 is only partial in R1)? | The **department head**, else the company admin; never unassigned | An always-admin fallback could swamp the owner — needs confirmation |
| **R1-D-4** | Deadline defaults per department | Finance 3 days, workforce 5, operations from the task's own due date, CRM 1 day, system health 4 hours | Wrong defaults create noise; owner should set these |
| **R1-D-5** | Detector cadence (cost lever) | Finance/CRM hourly, workforce/operations daily, system health every 15 min — deterministic, no model calls | Confirm against D-6 budget |
| **R1-D-6** | May R1 call a paid model at all? | **No.** D-6 forbids paid model calls during R0–R3, so R1 runs the deterministic path with a fixture adapter and proves the model path by contract test only | If a live model is wanted, D-6 must be amended |
| **R1-D-7** | Should `crm.followup.draft_for_human` exist in R1 at all, given it touches customer-adjacent content? | Included as **draft-only, never sends**, requiring `manager_approval` | If the owner prefers zero customer-adjacent actions in R1, drop it — the slice stays complete with four |

## 11. Checkpoint plan

| # | Checkpoint | Status |
|---|---|---|
| 1 | **R1 architecture and acceptance specification** | **this document — awaiting approval** |
| 2 | Management kernel and lifecycle | blocked on approval |
| 3 | Departmental observation adapters | blocked |
| 4 | Authority-aware recommendation and approval flow | blocked |
| 5 | Spatial owner/staff presentation | blocked |
| 6 | Deterministic cross-department scenario tests | blocked |
| 7 | Independent adversarial review and corrections | blocked |

## 12. Constraints honoured

- No Meta, Railway, Supabase, Vercel or production change; no hosted migration.
- Synthetic local data and deterministic provider adapters only.
- Existing finance controls, RLS, tenant isolation and API contracts unchanged.
- Customer-facing agents remain a separate subsystem; R1 builds no agent.
- Points/ranking not built — guardrails (WMP-003) come first, and both are owner-gated.
- Every locally verified capability preserved; no defect correction attempted in R1.
- No independent UI/UX redesign — one registry entry in the completed spatial workspace.
- The pre-existing CRLF source-text test defect (PR-F-013) is **left untouched**; R1 does
  not require that file.
