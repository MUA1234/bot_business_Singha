# DECISIONS.md

Decision log. When the spec is silent or two inputs conflict, the resolution is
recorded here with the **safer** reading preferred (per the build prompt).

| ID | Decision | Rationale | Status |
|---|---|---|---|
| D-001 | Build the new platform in `bot_business_Singha`; treat the Sasiri bot (`Automation_Singha_Auctions`) as an existing system to reuse patterns from and integrate later, not to re-platform. | Sasiri is a customer sales bot with minimal domain overlap; re-platforming it risks its live traffic. Preserves existing bot behaviour (constraint #6). | Adopted |
| D-002 | Use Inngest for all money-touching, long-running and scheduled work; keep simple request/response in API routes. | Vercel Cron gives no exactly-once, durable retry/dead-letter, or long jobs; a doubled QuickBooks post costs real money (build-prompt §2). Free tier. | Adopted |
| D-003 | `company_id` on every table references the operating `businesses` row; the org hierarchy (legal_entity/branch/department) is modelled separately; cross-company reporting via authorised views only. | Makes isolation a single, testable key while still supporting the full hierarchy (spec §6). Safer than multi-key RLS in the pilot. | Adopted |
| D-004 | Test runner = Vitest. | TS-native, fast, no extra infra/paid service (cost rule). | Adopted |
| D-005 | Order Authority (7) before WhatsApp (8), reconciling the build-prompt order with spec §29. | WhatsApp-driven actions must route through the authority engine, so it must exist first. Spec wins where it conflicts; here both are compatible. | Adopted |
| D-006 | No model IDs outside the AI gateway routing table; enforced by a grep test. | Provider independence (spec §20); removes existing-bot inline-model-ID debt. | Adopted |
| D-007 | Webhook signature mismatch is a **hard reject**, not a warning. | Fixes existing-bot risk R-3; security §23. Safer reading. | Adopted |
| D-008 | GPS/CCTV/agents/multi-country are not even schema-migrated until their gate clears. | Privacy gate (constraint #7); avoids dormant sensitive tables. | Adopted |
| D-009 | Money movement (bank payment execution) is entirely out of pilot scope; pilot only records purpose + prepares QuickBooks drafts. | Human-in-the-loop (constraint #2, spec §13/§16). | Adopted |

## Open decisions (need management/finance input)

See `OPEN_QUESTIONS.md`. These will become D-0xx entries once answered:
pilot entity/business identity; staff roster & authority thresholds; QuickBooks
entity + sandbox availability; WhatsApp number strategy; retention appetite; approval
owners for finance and (later) privacy/legal.

## How to add a decision

Append a row with the next `D-0xx` id, the decision, the rationale (why the safer
reading), and status. If it reverses an earlier decision, mark the old one
`Superseded by D-0xx`.
