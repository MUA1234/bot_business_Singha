# 7. Reusable management-loop specification

> One loop. Every domain runs through it. No department gets its own intelligence.
>
> **APPROVED 2026-09-02 (D-10); implementation NOT authorised — Phase R0 only.**
> Registered as **KRN-001** (the kernel), **KRN-002** (observation sources), **KRN-003**
> (action catalogue).
>
> **Binding autonomy ceiling (D-9).** The kernel may act unattended **only** within
> `automatic` authority, and only on catalogue-registered, low-risk, reversible
> **internal** actions: create an internal task, send an internal reminder, request a
> progress update, route an internal notification, schedule a follow-up, escalate an
> overdue internal task under an approved playbook. **Always human-approved:** customer
> messages or commitments, quotations with unconfirmed prices, payments or transfers,
> material journals, contracts, permission changes, hiring/dismissal/discipline/
> remuneration, external provider commitments, and any irreversible action. **AI
> interpretation never directly executes.**

## 7.1 The loop as a durable state machine

The loop is not a function call — it is a **persisted state machine over a management
case**, so that it survives restarts, can be resumed, can be audited, and can be
supervised while it is in flight. This is the same discipline the repository already
applies to `source_events` and `message_outbox`, applied to management itself.

```
   signal                                                     ┌── reject ──┐
     │                                                        │            ▼
     ▼                                                        │        dismissed
  observed ─► contextualised ─► interpreted ─► classified ─► recommended
                                                                  │
                                                    ┌─────────────┴──────────────┐
                                                    │                            │
                                              within authority            needs approval
                                                    │                            │
                                                    ▼                            ▼
                                                 approved ◄──── decided ──── awaiting_approval
                                                    │                            │
                                                    │                       (timeout) ─► escalated
                                                    ▼
                                                assigned ─► in_progress ─► stalled ─► escalated
                                                                 │            │           │
                                                                 ▼            └───────────┘
                                                            completed
                                                                 │
                                                                 ▼
                                                             verified ─► learned ─► closed
                                                                 │
                                                            (evidence fails)
                                                                 └─► reopened
```

Every transition writes an audit event with actor, actor type, evidence and reason.
Terminal states are `closed` and `dismissed`. Nothing leaves the machine silently.

## 7.2 The eleven steps, specified

### Step 1 — Business signal

**Two intake paths, one contract.**

| Path | Source | Mechanism |
|---|---|---|
| External | WhatsApp, email, uploads, connectors | `source_events` → inbound adapters → dispatch (**exists**, branch line) |
| Internal | Domain state | `ObservationSource.scan()` on a kernel schedule (**new**) |

Both produce an `Observation` (contract A, §6.3). Both are deduplicated by
`identityKey`, reusing the existing task-identity/dedupe machinery (0071, 0073) so a
recurring condition does not spawn a case per scan.

**Fail-closed rule:** a scan that throws does not silently return zero observations. It
records a scan failure and the health surface reports the domain as unobserved — the
same honesty rule the Command Centre already applies ("Data degraded — no all-clear can
be given").

### Step 2 — Evidence and context

The kernel assembles a bounded context pack for the observation: the subject row, its
recent history, related open cases, applicable policy, budget/authority facts, and the
responsible people. Every element carries a reference so the case can prove what it saw.

**Constraints:** bounded size (model cost is metered); untrusted content is fenced and
labelled; no cross-company data ever enters a pack.

### Step 3 — AI interpretation

The **only** step that calls a model, via the existing AI gateway with the model-policy
router, budget policy and cost ledger. Output is a Zod-validated
`ManagementObservation` — the schema that already exists and is already used by
`runManagerObservation`.

If the model is unavailable, over budget, or returns invalid output, the loop does not
stop: it proceeds on the deterministic facts with `interpretation: none` and a lowered
confidence. **The OS degrades to a rules engine rather than going blind.**

### Step 4 — Risk / opportunity classification

Deterministic, not model-driven: severity, urgency, domain impact (financial, legal,
safety, reputational), and confidence. Reuses `priority.ts`, `exceptions.ts` and
`inferDomain`/`authorityFloor` from the existing `pipeline.ts`.

### Step 5 — Recommendation

`planFromObservation` — **which already exists and already does this correctly** —
produces proposed tasks, required authority, clarifications and suggested actions, with
explicit `authorityReasons` and an `authorityFailedClosed` flag.

Extension required: recommendations must resolve to entries in the **domain action
catalogue** (contract B), not to free text. A recommendation the catalogue cannot
express becomes a clarification for a human, never an improvised action.

### Step 6 — Authority and approval check

`src/policy/authority-engine.ts`, unchanged: ladder, delegation ⊆ delegator, currency
and money validation, domain capability whitelist, duplicate-action conflict, fail-closed
on unknown or conflicting policy. Approvals are decided through the existing
`decide_approval` RPC with maker/checker separation.

**Invariant:** the kernel cannot execute anything the ladder classifies above
`policy_controlled` without a recorded human decision.

### Step 7 — Task / action creation

Atomic. The existing `create_management_case_atomic` RPC (0068) already persists the
case, its tasks and the audit event in one transaction, keyed by a company-scoped
idempotency key, with task status forced at the boundary. This is the right primitive
and should be extended rather than replaced.

### Step 8 — Assignment to a suitable human or bot

**The largest genuine gap (PR-F-008, OF-008, WRK-005).** Required:

- **Candidate set** from capability, department, company scope.
- **Availability** — `availability.ts` and leave already exist.
- **Workload** — `capacity_snapshots` and `rankAvailableCandidates` already exist.
- **Suitability** — skills and past performance. **WRK-004 is `absent`**; this needs a
  skills model.
- **Fairness** — no repeated allocation to the same person; explicit rotation.
- **Bot vs human** — a bot may take an action only if it is in the catalogue, reversible
  or low-risk, and within `automatic` authority.

Output is a *proposal with reasons*, not a silent assignment. Rejecting a proposal is a
first-class learning signal (step 11).

**Registered requirements for this step** (added by the Original Vision Reconciliation,
2026-09-02):

| ID | Adds |
|---|---|
| **WRK-005** | fair assignment; external providers where internal capacity is absent |
| **WRK-007** | advisor, delegate and external-consultant recommendation — a recommended delegate must already be **within the delegator's own authority**; delegation is a subset, never an expansion |
| **WMP-001** | a **work marketplace**: open work discoverable and claimable by authorised staff, permitted AI bots and approved external consultants, scoped by company, capability and authority |
| **WMP-002** | a time-boxed **opportunity/bidding and ranking window** using points or credits over verified skills, availability, authority and past performance |
| **WMP-003** | the **fairness and anti-surveillance guardrails** that must be satisfied **before** WMP-002 is built |
| **WRK-006** | explainability and fairness for every people inference feeding allocation |

**The guardrails are not optional, and they come first.** Points, credits, ranks and
marketplace history may **never** automatically drive discipline, dismissal, remuneration
or permission changes. No public leaderboard, no peer visibility, no covert or continuous
behavioural measurement; measurement is limited to declared work outcomes; every person
can view and contest their own record; retention is bounded and stated. A ranking system
built before its guardrails becomes the social-credit outcome the owner explicitly
prohibited — so WMP-003 is a **blocker on** WMP-002 in the register, not a sibling.

Ranking **proposes**; a human with the relevant authority allocates.

### Step 9 — Monitoring, reminders, escalation

Exists and is good: `evaluateFollowUp`, `selectEscalationTarget`, the escalation chain
(0103), directive escalation (0099), leave-aware target selection, daily dedupe buckets
so reminders cannot spam. Reminders are delivered through the outbox using approved
templates, respecting the 24-hour window.

Required change: it must run **on the host that receives traffic** (PR-F-005), and must
cover kernel cases, not only tasks.

### Step 10 — Verified outcome

Two distinct verifications, and today only the first is modelled:

1. **Was the work done?** `task_evidence`, `requiresEvidence`, completion evidence.
   Exists.
2. **Did it achieve the intended effect?** Re-run the originating observation. If the
   invoice is still overdue, the case is not verified — it is **reopened**. *This is
   the step that makes the loop a control system rather than a task generator.*

### Step 11 — Learning and audit history

**Entirely new (PR-F-007).** Four durable records:

| Record | Content |
|---|---|
| Recommendation outcome | proposed → decided → executed → verified/failed, with elapsed time |
| Owner/approver decisions | accepted, modified, rejected — **and the reason**, which is the highest-value training signal in the system |
| Assignment outcomes | who was proposed, who was chosen, was it completed on time |
| Detector precision | how often a detector's cases were dismissed as noise |

Learning is applied under three hard constraints:

- **Proposals, never self-modification.** The system proposes a threshold change, a
  playbook revision or a prompt version; a human approves it. IMP-003 says exactly this.
- **Versioned and reversible.** Every playbook and prompt version is recorded, and any
  change can be rolled back.
- **Evidence-bound.** A learning candidate must cite the cases that justify it.

## 7.3 Data model additions (design, not migration)

Deliberately small, and additive to what exists.

| Table | Purpose |
|---|---|
| `observation_sources` | registry: domain, kind, cadence, enabled, last scan, last failure |
| `observations` | emitted observations, `identityKey`-deduped, evidence-linked |
| `management_cases` | **exists** — extend with the state machine column and transitions |
| `case_transitions` | append-only state history with actor, reason, evidence |
| `domain_actions` | registered action catalogue with capability and authority floor |
| `case_recommendations` | proposed actions, chosen action, authority outcome |
| `assignment_proposals` | candidates, scores, reasons, chosen assignee, override reason |
| `case_outcomes` | verification result, re-observation result, elapsed time |
| `learning_candidates` | evidence-cited proposals, status, approver, applied version |

Every one is company-scoped with RLS, composite company FKs, and append-only where it
is history.

## 7.4 The rules that keep this one loop

Without these, twelve intelligences reappear within a quarter:

1. **No domain module may import the AI gateway.** Only the kernel calls models. (Today
   this is nearly true: 2 of 105 surfaces import `@/ai`.) Enforce with a lint rule and
   a test, the way `search-path-safety.test.ts` permanently enforces its invariant.
2. **No domain module may create a case or a task directly.** It emits observations; the
   kernel decides.
3. **No page may query a domain table directly** once that domain has a service. The
   existing `completion-inventory` / allowlist mechanism can enforce this incrementally.
4. **Every kernel model call is metered** through the cost ledger — no exceptions
   (closes OF-011).
5. **Every new detector ships with a precision measurement.** A detector that mostly
   produces dismissed cases is worse than none, because it trains the owner to ignore
   the system.

## 7.5 Worked example — the same loop, three domains

| | Overdue invoice | Expiring vehicle licence | Customer message |
|---|---|---|---|
| 1. Signal | `finance.invoice_overdue` scan | `fleet.document_expiring` scan (`renewals.ts`) | `source_events` → WhatsApp adapter |
| 2. Context | invoice, customer, 3 prior reminders, ageing | vehicle, document, current trips assigned | thread, customer, open quotations |
| 3. Interpret | recoverability, relationship risk | operational impact if grounded | intent, commitment, sentiment |
| 4. Classify | financial, high, 92% | legal + safety, critical, deterministic | commercial, medium |
| 5. Recommend | `finance.invoice.send_reminder` | `fleet.document.schedule_renewal` | `sales.quotation.prepare` |
| 6. Authority | `policy_controlled` | `manager_approval` | `automatic` |
| 7. Create | reminder task + case | renewal task + case | quotation task + case |
| 8. Assign | finance officer, least loaded, available | fleet coordinator | sales rep on the account |
| 9. Monitor | 7-day follow-up, escalate to manager | escalate as expiry nears | 24-hour window rules |
| 10. Verify | **re-observe: is it still overdue?** | **re-observe: is the document renewed?** | quotation sent and acknowledged |
| 11. Learn | do reminders at 47 days work better than at 60? | is the lead time long enough? | which quotation patterns convert? |

**The kernel code is identical in all three columns.** Only the registered detector and
the registered action differ. That is the test of whether this architecture has actually
been achieved: if adding "monitor supplier delivery performance" requires touching the
kernel, it has not.
