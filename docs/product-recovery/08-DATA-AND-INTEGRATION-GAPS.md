# 8. Data and integration gap analysis

## 8.1 Summary

The data model is **not** the binding constraint. 146 tables already cover almost every
target domain, including ones with no product surface at all. The binding constraints
are, in order:

1. **Observation** — nothing scans internal state (loop step 1).
2. **Allocation** — nothing proposes an assignee (step 8).
3. **Outcome and learning** — no tables, no code (steps 10b and 11).
4. **Channel breadth** — one inbound channel of six.
5. **Access seam** — no domain service layer for the kernel to read or write through.

## 8.2 Data gaps

| Gap | Impact | Existing foundation |
|---|---|---|
| **No observation store** | The loop cannot be triggered by business state — only by a WhatsApp message or a button | `source_events` proves the durable-intake pattern; reuse it |
| **No case state machine** | A case is a record, not a supervised process; cannot resume, stall, or reopen | `management_cases` (0028) + atomic persistence (0068) |
| **No outcome record** | Cannot tell whether a recommendation helped; step 10b impossible | `task_evidence` covers "was it done", not "did it work" |
| **No learning store** | Step 11 absent entirely (PR-F-007) | none |
| **No skills / competency model** | Allocation cannot judge suitability; coaching impossible (WRK-004 `absent`) | `employee_profiles`, capacity, availability |
| **No assignment proposal record** | Cannot learn from overrides — the richest signal available | `task_routing`, `task_routing_events` (0072, 0078) |
| **No counterparty performance history** | Cannot rate suppliers or customers (CRM-004 `absent`) | `counterparty_compliance` (0102), three-way match |
| **No asset registry beyond fleet** | AST-001 `specified`, not built | vehicles, maintenance, documents |
| **No detector precision metric** | Cannot tell signal from noise; risks training the owner to ignore alerts | `ai_runs`, eval harness |
| **Duplicate near-miss detection has no producer** | `task_duplicate_suggestions` exists, nothing writes it (OF-010) | table + dedupe machinery |

## 8.3 Integration gaps

| Channel / integration | Register ID | Status | Note |
|---|---|---|---|
| WhatsApp Cloud API | — | **operational** | Official API, signature-verified, 24-hour window respected, templates for out-of-window. The only working channel. |
| Email intake and send | COM-004 | `absent` | `/api/webhooks/email` route exists as a stub entry point |
| Voice-note intake | COM-002 | `absent` | Requires transcription provider — owner decision |
| Image / document intake with evidence preservation | COM-003 | `absent` | `documents` table and storage paths exist |
| Calendar and meeting events | COM-005 | `absent` | `/app/calendar` aggregates 8 internal sources but has no external calendar link |
| Approved data connectors (Sheets and similar) | COM-006 | `absent` | `connectors`, `integrations`, `integration_command_contracts` tables exist (0095) — **schema without implementation** |
| Handover / meeting-action extraction | SCH-005 | `absent` | depends on COM-005 |
| Live voice | COM-008 | `deliberately_deferred` | future |
| Model providers (OpenAI, Anthropic) | MOD-001 | `blocked_owner` | Gateway, router, budget policy and failover implemented; live evaluation blocked on credentials |
| Finance intent classification | OF-003 | `blocked_owner` | Processor works on deterministic fixtures; no live classifier |
| Push notifications | MOB-003 | `locally_verified` | Subscriptions persisted; **nothing sends** — deliberately |
| Inngest | — | configured, unused | Keys intentionally unset; `WHATSAPP_ASYNC` OFF. The in-process scheduler covers current needs at zero cost |

**The single most valuable integration to add is email intake (COM-004)**, because it is
the channel through which most B2B business obligations actually arrive — invoices,
statutory notices, supplier confirmations, contracts — and because the inbound adapter
contract (OF-006 foundation) was explicitly built to accept a second channel.

## 8.4 The internal integration gap — quantified

This is the gap that matters most, and it is not about external providers.

| Domain | Tables it owns (approx.) | Detectors that exist | Detectors wired into the loop |
|---|---|---|---|
| finance | 30+ | ageing, budget-vs-actual, forecast, cash position, three-way match, duplicate detection, reconciliation | **0** |
| work / projects | 12 | overdue, stalled, blocked, capacity, dependency, budget forecast | **0** |
| legal / compliance | 8 | expiry, renewal, obligation due | **0** |
| fleet / assets | 6 | document expiry, service due, fuel efficiency | **0** |
| procurement | 10 | three-way match variance, RFQ ageing, stock levels | **0** |
| workforce | 6 | leave conflicts, capacity, availability | **0** |
| crm / sales | 10 | lead scoring, pipeline value, follow-up due | **0** |
| governance | 6 | directive conflict, escalation due | **0** |
| **communications** | 3 | conversation analysis | **1** |

**Every detector in the system already exists as a tested pure function, and exactly one
of them reaches the management loop.** The work is not to invent intelligence; it is to
connect intelligence that is already written and already tested to a loop that is
already written and already tested.

That is a genuinely encouraging finding, and it is the reason the recovery roadmap can
be measured in phases rather than a rewrite.

## 8.5 Provider and cost constraints to respect

- **Free-tier rule.** Railway is already an owner-authorised deviation (D-021, paid,
  no free tier). No further paid infrastructure. The kernel must run on Postgres + the
  in-process scheduler + the existing outbox.
- **Model cost is the real recurring cost.** Only step 3 calls a model. Scans, context
  assembly, classification, authority, allocation and verification are deterministic.
  Budget policy (0092) already exists and must gate every kernel call.
- **Detector cadence is a cost lever.** Daily scans for expiry-class detectors, hourly
  for money-class, minutes only for delivery. `DEFAULT_JOBS` in `scheduler.ts` already
  demonstrates this reasoning.
- **WhatsApp policy.** 24-hour window and approved templates — already respected and
  must remain so for any kernel-initiated outbound message.
