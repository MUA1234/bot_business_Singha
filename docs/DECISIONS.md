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

| D-010 | The new platform is a fully standalone fresh build. It must NOT reuse the Sasiri auction bot's (`Automation_Singha_Auctions`) APIs, WhatsApp number, credentials, database, or code. The Sasiri bot is a pattern reference only. This platform provisions its own WhatsApp number, Supabase project, OpenAI gateway, and all other services. | User instruction 2026-07-27: this should be a new fresh thing, not built on the existing auction bot's APIs. Avoids coupling live sales traffic and keeps clean isolation. | Adopted |
| D-011 | **Remove QuickBooks entirely.** Build an internally-owned double-entry **Accounting Core v0** as the accounting source of truth, per `Claude_Interim_Accounting_Development_Guide.md`. This supersedes D-002/D-009's QuickBooks-as-truth stance and Phase 11 of the phased plan. | User instruction 2026-07-30: QuickBooks is too pricey; we own the financial system. The guide's executive decision is to replace the planned QuickBooks dependency. | Adopted — supersedes QuickBooks-as-truth in D-002/D-009 |
| D-012 | Invoices/statements are generated from **our own HTML templates** (self-contained, no external assets) and rendered to PDF for free (headless browser / "Save as PDF"); ledgers/logs export to **Excel-compatible CSV** (UTF-8 BOM). No paid invoicing/PDF service. Google Sheets/Excel remain a view + import/export surface, never the ledger. | User instruction 2026-07-30: "add details to a template created by our own… save logs in excel and use a generated pdf template… make this work for free." Honours the cost rule. | Adopted |
| D-013 | Add `decimal.js` (fixed-precision money — guide invariant #11) and `@supabase/supabase-js`, `inngest`, `zod`, `next` as production deps. All free/OSS; none is a paid managed service. Money is never a JS `number`. | Guide bans floating-point money; the mandated stack needs these clients. Cost rule satisfied (all free tiers/OSS). | Adopted |
| D-015 | **AI model = `gpt-5.6-sol` for all routes, via the OpenAI Responses API** (`/v1/responses`), not Chat Completions. The transport maps system→`instructions`, user→`input`, maxTokens→`max_output_tokens`, and uses `text.format=json_object` (which requires the word "json" in the input, so the transport appends a JSON directive). Model ids stay confined to the gateway routing table (D-006). | User instruction 2026-08-02: "use gpt-5.6-sol only." The key's project has the gpt-5.x family but **not** gpt-4o/4o-mini; and `gpt-5.6-sol` is served on the Responses API (Chat Completions 403s for it). **Caveat:** this project's access to `gpt-5.6-sol` was observed to be intermittent (1 of 3 calls 200, the rest 403 `model_not_found`) — an OpenAI account/project-side issue (enable model access / org verification / tier), not a code issue. A 403 is treated as a retryable `transport_error`, so Inngest's retries partially absorb the flakiness. | Adopted — resolve model access on the OpenAI side before go-live |
| D-014 | **Consumer pipeline wired past the webhook boundary** (2026-08-02): `src/inngest/processing.ts` runs extract→detect-missing→dedup→draft→policy→approval/clarification→audit as pure orchestration over ports; the live Inngest function binds Supabase + the gateway. Approval policy is stored per company as validated JSONB in a new `approval_policies` table (migration `0006`). The live OpenAI transport (`src/ai/openai-transport.ts`) uses the global `fetch` — **no OpenAI SDK dependency added** (cost/dependency rule). Model ids stay confined to the gateway routing table + this transport. | User instruction 2026-08-02: "decide on your own so you can fully complete it." The pure logic was already built + tested; wiring it end-to-end completes the phase without needing live keys (keys only *activate* it). `fetch` avoids a new dependency; a policy table makes deterministic auto-approve reachable in production, not just tests. Auto-approve still never posts a journal or moves money (financial controls). | Adopted |
