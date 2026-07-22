# MIGRATION_FROM_EXISTING_BOTS.md

**Status:** Phase 0 deliverable — for review. Master spec §21, §28(23).

## 1. Position

The existing **Sasiri WhatsApp AI Agent** (`~/Documents/GitHub/Automation_Singha_Auctions`)
is a customer-facing **sales/lead** bot. The new platform is an **internal
business-management OS**. Domain overlap is minimal; **infrastructure and patterns**
transfer, not data or tables. The Sasiri bot keeps running unchanged in its own repo
during the pilot (Decision D-001).

## 2. Reuse vs rebuild vs retire

| Area | Existing (Sasiri) | Decision | Notes |
|---|---|---|---|
| WhatsApp webhook + sender | `portal/app/api/whatsapp/route.ts`, `lib/bot/wa.ts` | **Reuse (adapt)** | Meta Cloud API, HMAC verify, fast-200-then-async. Adapt to persist-then-**enqueue (Inngest)** and **hard-reject** bad signatures |
| AI strict-schema pattern | `lib/bot/ai.ts` `buildSchema()` | **Reuse (generalise)** | → Zod-validated gateway |
| Deterministic gates around model | `needsVerification`, `missingRequiredFields` | **Reuse (generalise)** | → authority engine + verify policy |
| Supabase + RLS + service-role | `supabase/schema*.sql`, `supabaseAdmin.ts` | **Reuse (know-how)** | Rebuild schema for multi-company |
| Vercel deploy know-how | `vercel.json`, `maxDuration`, `after()` | **Reuse** | |
| Web-push notifications | `lib/push.ts` | **Reuse (later)** | For dashboards/alerts |
| Tenancy model (`owner_id`) | `schema_multitenant.sql` | **Rebuild** | → `company_id` + org hierarchy + RBAC |
| Event handling | `wa_events` + in-process `after()` | **Rebuild** | → durable Inngest pipeline + dead-letter |
| AI model IDs inline | `lib/bot/ai.ts` | **Rebuild** | → single gateway, no IDs elsewhere |
| Business domain (leads/playbooks) | whole app | **Retire from pilot scope** | Greenfield internal domain instead |
| `portal2` duplicate, Electron apps | repo | **Retire from pilot scope** | Not carried into new repo |
| Test suite | none | **Build new** | Vitest + isolation/idempotency/authority |

## 3. Data migration

**None for the pilot.** No lead/customer data is copied into the new platform. If, in
a later phase (12+), sales/customer context is wanted here, it arrives via an **event
adapter** (read/handoff), never a bulk table copy, and under company scope + consent.

## 4. Risks carried from the existing bot (remediate in new build)

- R-2: in-process `after()` processing → replace with durable Inngest (Phase 2).
- R-3: signature mismatch warns but still processes → **hard-reject** (Phase 8).
- R-4: hardcoded Supabase URL fallback → env-only config (Phase 1).
- R-5: no tests → Vitest suites from Phase 1.
- R-6: service-role bypasses RLS → allowed only in scoped jobs + isolation tests.

## 5. Integration point (Phase 7/8)

The pilot's only WhatsApp need is **staff updates**. It reuses Sasiri's Cloud API
patterns on (preferably) a **separate** WhatsApp Business number so staff-ops traffic
and customer-sales traffic don't mix. Confirm number strategy in OPEN_QUESTIONS.
