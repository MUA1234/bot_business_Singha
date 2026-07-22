# EXISTING_SYSTEM_ASSESSMENT.md

**Status:** Phase 0 deliverable — for review
**Scope:** Read-only assessment. No existing code was modified. No secrets or
customer data were copied.

## 1. What was assessed

The existing WhatsApp bot lives in a **separate repository** from this one:

- Existing bot: `~/Documents/GitHub/Automation_Singha_Auctions` — "Sasiri WhatsApp
  AI Agent" (a lead-qualification / sales bot).
- New platform (this repo): `~/Documents/GitHub/bot_business_Singha` — currently
  empty except for the Phase 0 `docs/` set.

> **Decision D-001 (see DECISIONS.md):** The new platform is built in this repo; the
> Sasiri bot is treated as the "existing system" to reuse patterns from and to
> integrate with (Phase 7), not to be re-platformed. Its number and webhook keep
> running unchanged during the pilot.

All file paths below are relative to the Sasiri repo unless noted.

## 2. Technology stack (as found)

| Concern | Technology | Evidence |
|---|---|---|
| Web + API | Next.js 15, React 19, TypeScript 5.7 | `portal/package.json` |
| Hosting | Vercel (serverless, `maxDuration=300`, `after()`) | `portal/app/api/whatsapp/route.ts`, `portal/vercel.json` |
| DB / Auth / Storage | Supabase (`@supabase/supabase-js` ^2.49) + RLS | `supabase/schema*.sql`, `portal/lib/bot/supabaseAdmin.ts` |
| WhatsApp | **Official Meta Cloud API** (`graph.facebook.com`) | `portal/lib/bot/wa.ts` |
| AI | OpenAI, strict JSON structured outputs | `portal/lib/bot/ai.ts` |
| Notifications | Web Push (`web-push`) | `portal/lib/push.ts` |
| Legacy desktop | Electron apps (`apps/agent`, `apps/admin`) | `apps/*/package.json` |

The stack is **already ~80% aligned** with the mandated stack for the new platform
(Next.js + Vercel + Supabase + Meta Cloud API + OpenAI + TypeScript). The two gaps
versus the mandate are **Inngest** (absent) and a **provider-independent AI gateway
with Zod** (AI is called directly with model IDs in business logic).

## 3. Repository layout (as found)

- `portal/` — the live Next.js SaaS panel + cloud bot (`portal/lib/bot/*`). Primary.
- `portal2/` — a near-identical **duplicate** of `portal/` (technical debt; see §7).
- `web/` — an older admin panel (`web/components/*`).
- `apps/agent`, `apps/admin` — legacy Electron desktop bot + admin.
- `supabase/` — 18 `schema_*.sql` files, applied via `scripts/apply-migrations.mjs`.
- `shared/` — `constants.ts`, `phone.ts`, `projectConfig.ts`, `types.ts`.
- `scripts/` — `provision.mjs`, `apply-migrations.mjs`, and manual `test-*.mjs` probes.
- `supabase/functions/wa-webhook/` — a Supabase Edge Function variant of the webhook.

## 4. WhatsApp integration (reusable — strong)

`portal/app/api/whatsapp/route.ts`:

- **GET** handles the Meta verification handshake, accepting a central verify token
  or any connected number's token (`listVerifyTokens()`).
- **POST** reads the raw body, then responds `200 EVENT_RECEIVED` **immediately** and
  processes inside `after(...)` so Meta never times out or re-delivers. This is the
  correct "persist/ack fast, process async" shape the new spec wants — though here
  the async work runs in-process rather than in a durable queue (see §7, risk R-2).
- **HMAC-SHA256 signature validation** (`validSignature`) with constant-time compare
  against `X-Hub-Signature-256`.

`portal/lib/bot/wa.ts`: outbound send (`sendText`), read receipts + typing
(`markReadWithTyping`), and two-step media download (`downloadMedia`) — all against
`graph.facebook.com/{version}/{phone_number_id}/messages` with a per-number bearer
token. **Ban-safe and directly reusable.**

## 5. AI integration (reusable patterns — strong; architecture — needs a gateway)

`portal/lib/bot/ai.ts` is the standout asset:

- **Strict structured outputs.** `buildSchema()` emits a `strict: true` JSON schema;
  every AI turn returns a fixed object (intent, reply, lead_status enum, stage_update,
  handover flags, follow-up, promises, fields). This is exactly the spec's "AI output
  must pass schema validation" principle — already in production.
- **Deterministic gates around the model.** `needsVerification()` / `RISKY_INTENTS`
  force a second STRONG-model verifier pass for money/promise/handover turns;
  `missingRequiredFields()` computes the handover gate **in code, not by the model**
  ("computed HERE, never by the model" — `ai.ts`). This is precisely the
  "AI proposes, deterministic rules decide" pattern the new authority engine needs.
- **Prompt-injection awareness.** The system prompt treats bracketed/`[seen: …]`
  content as untrusted and enforces language/handover rules.

Gaps versus the new mandate:
- Model IDs and routing live inside `ai.ts` (`saveResolvedModel`), not a single
  gateway. **No Zod** — validation is via OpenAI strict mode + hand-written parsing.
- No per-call token/cost/latency ledger table (some logging via `activity_logs`).

## 6. Data model & multi-tenancy (partially reusable — wrong tenancy dimension)

`supabase/schema.sql` + `schema_multitenant.sql`:

- Core tables: `app_state` (singleton config), `devices`, `activity_logs`,
  `wa_events`, plus `wa_numbers`, `playbooks`, `leads`, `messages` (in cloud schema).
- **`wa_events`** is a real event table: raw `payload jsonb`, `event_type`,
  `wa_message_id`, `processed_at`, `processed_by`, a **unique index on
  `wa_message_id`** for dedup, and a partial index on unprocessed rows. Good bones
  for the new `events` table, but see risk R-2.
- **Tenancy is single-dimension:** `owner_id uuid references auth.users` on each
  per-user table, with RLS `owner_id = auth.uid()`. The cloud bot uses the
  **service-role key (bypasses RLS)** and sets `owner_id` explicitly.

This is a SaaS "one WhatsApp account owner = one tenant" model. The new platform
needs **multi-company** scope (legal_entity → business → branch → department, plus
roles/authority). The `owner_id` pattern is a useful precedent but must be replaced
by a `company_id` (+ scope hierarchy) model with far richer RBAC. **Rebuild, don't
extend.**

## 7. Technical debt & risks

| ID | Finding | Evidence | Severity |
|---|---|---|---|
| R-1 | `portal/` and `portal2/` are near-duplicate trees | file listing | Medium — maintenance/drift |
| R-2 | Webhook processes in `after()` in-process; no durable queue/retry/dead-letter. A crash or serverless kill after the 200 loses the turn. | `whatsapp/route.ts` | High for the new money-touching platform — Inngest required |
| R-3 | Signature mismatch only `console.warn`s and **still processes** | `whatsapp/route.ts` `validSignature` caller | High — must hard-reject in new webhook |
| R-4 | Hardcoded Supabase project URL fallback committed | `supabaseAdmin.ts` (`https://…supabase.co`) | Low (URL not secret) — but no hardcoding in new code |
| R-5 | No automated test suite; `scripts/test-*.mjs` are manual probes | `scripts/`, no test dep | High vs spec §25 |
| R-6 | Service-role key bypasses RLS across the whole bot | `supabaseAdmin.ts` | Medium — acceptable pattern but the new system needs isolation tests to prove `owner_id`/`company_id` is always set |
| R-7 | Three UIs (`portal`, `portal2`, `web`) + 2 Electron apps | repo | Medium — scope/ownership unclear |

No secrets were found committed beyond the non-secret Supabase URL; `.gitignore`
excludes `.env`.

## 8. Domain fit

The Sasiri bot is a **customer-facing sales/lead bot**. The new platform is an
**internal business-management OS** (employees, tasks, projects, approvals, receipts,
QuickBooks, finance intelligence). There is **almost no domain overlap** — the
business logic is greenfield. What transfers is *infrastructure and patterns*, not
tables. Customer-facing AI agents are explicitly **out of pilot scope** (gated).

## 9. Reuse vs rebuild

See `docs/MIGRATION_FROM_EXISTING_BOTS.md` for the full table. Summary:

- **Reuse (adapt):** Meta Cloud API webhook + sender, HMAC verification, "ack fast /
  process async" shape, strict-schema AI pattern, deterministic gate-around-model
  pattern, Supabase+RLS+service-role deployment know-how, Vercel deployment know-how.
- **Rebuild:** tenancy model (owner_id → multi-company), event pipeline (in-process →
  Inngest durable), AI layer (inline model IDs → Zod gateway), the entire business
  domain, the test suite.
- **Retire from pilot scope:** Electron desktop apps, `portal2` duplicate, sales
  playbook/lead domain (kept running as-is in its own repo; integrated later).

## 10. Missing information / decisions required

See `docs/OPEN_QUESTIONS.md`. Key ones: which legal entity/business is the pilot;
who the ~5–15 staff are and their roles/authority limits; QuickBooks entity(ies) and
whether sandbox is available; whether the pilot WhatsApp number is separate from the
Sasiri sales number; data-retention appetite; and sign-off owners for finance and
(later) privacy/legal.
