# Autonomous defect ledger

Rolls up the defect ledgers of each program. Detail lives in
`docs/verification/CAMPAIGN_DEFECT_LEDGER.md`.

## Fixed and verified

| ID | Severity | Defect | Fixed at |
|---|---|---|---|
| D-002/D-003 | Material | Predictable prompt fence on both AI routes, including the customer-facing one | `7669ce1` |
| D-004 | Blocker | The model set its own authority level | `7669ce1`, replaced by the rules engine at `079fbb8` |
| D-005 | Material | A reply recorded as sent when the outbox refused it | `7669ce1` |
| D-006 | Material | A failed persist stamped as analysed | `7669ce1` |
| D-007 | Material | A customer could steer the price of an auto-sent quotation | `7669ce1` |
| D-008 | Latent | Cross-company dead-letter count on the admin health page | `7669ce1` |
| D-013 | Material | `ai-monitor` starvation past 200 conversations | `7669ce1` (ordering), `1ebaa80` (eligibility model) |
| D-019 | Material | No sweeper for unhandled inbound messages | `1ebaa80` |

## Open

| ID | Severity | Defect | Requirement |
|---|---|---|---|
| D-009 | Material | The finance consumer pipeline has no production caller | FOUND-003 |
| D-010 | Material | No task-level deduplication | AIM-002 |
| D-011 | Material | AI-captured tasks are invisible to every attention mechanism | AIM-003 |
| D-012 | Material | `requires_human` has no consumer; the UI claims a routing that does not happen | AIM-003 |
| D-014 | Material | Customer-facing model calls are outside the cost ledger | MOD-002 |
| D-015 | Limitation | AI records attributed to a company id rather than an actor | AIM-003 |
| D-016 | Limitation | Transcript forgery and idempotency collision on analysed conversations | AIM-002 |
| D-017 | Limitation | Non-text WhatsApp messages silently discarded | COM-* (unexpanded) |
| D-020 | Material | No bounded backoff column for a permanently failing analysis | FOUND-001 residual |
| D-001 | Latent | `NEVER_AUTONOMOUS` substring denylist is evadable — no production caller; a tripwire test fails the moment one appears | FOUND-004 |
