# AI Business Management System (Pilot)

An event-driven, multi-company AI business-management platform. Currently at
**Phase 0 — assessment & architecture (documentation only).** No feature code yet.

## Read first
- `CLAUDE.md` — rules every coding agent follows (authoritative for this repo).
- `AGENTS.md` — start-of-session checklist and constraints.
- `docs/README.md` — the full documentation index.
- `docs/AI_BUSINESS_MANAGER_MASTER_SPEC.md` — the product spec (wins on conflict).
- `SETUP.md` — manual steps you do yourself; `.env.example` — required env vars.

## Stack (mandated)
Next.js on Vercel · Meta WhatsApp Cloud API (official only) · Supabase
(Postgres + RLS + Auth + Storage) · Inngest (durable jobs) · OpenAI via a self-built
gateway · TypeScript · Zod.

## Non-negotiables
Event-driven core (persist before process; idempotent; no duplicate downstream
records) · hard human-in-the-loop for money/accounting/permissions/employment/
surveillance · AI output is schema-validated, never free text into business logic ·
company isolation proven by tests · QuickBooks = accounting truth, operational
Postgres = ops truth · official WhatsApp API only · GPS/CCTV/agents are gated and
built last.

## Status
Phase 0 docs are in `docs/` for review. Feature code begins only after approval,
one phase at a time (`docs/PHASED_IMPLEMENTATION_PLAN.md`).
