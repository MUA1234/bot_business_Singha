# Singha Central — AI Business Management System

An event-driven, multi-company business-management platform: a working application, not a
documentation stub. It has an app shell, auth, department dashboards, an admin panel, a live
WhatsApp Cloud API quotation flow, an internally-owned double-entry Accounting Core, event
ingestion, and a large passing test suite.

> **Status supersedes earlier text in this file.** This README described "Phase 0 — documentation
> only, no feature code" and named QuickBooks as the accounting source of truth. Both statements
> are **void** (see `CLAUDE.md` and `docs/DECISIONS.md` D-011). Corrected 2026-09-12.

## Read first
- `CLAUDE.md` — authoritative for any coding agent, including the document-precedence rule.
- `AGENTS.md` — start-of-session checklist and constraints.
- `docs/CURRENT_IMPLEMENTATION_STATUS.md` — what actually exists, written from the code.
- `docs/architecture-v3.1/COMPLETION_LEDGER.md` — live program state and open owner gates.
- `docs/README.md` — the full documentation index.
- `SETUP.md` — manual steps you do yourself; `.env.example` — required env vars.

**Precedence, in short:** the owner's instruction for the task →
`docs/architecture-v2/NEXT_PHASE_DEVELOPER_BRIEF.md` → the Architecture V2 change plan + PlantUML →
the security/permission/authority/test specs → `CLAUDE.md` → older documents (including
`docs/AI_BUSINESS_MANAGER_MASTER_SPEC.md`) only where they do not conflict. The master spec is **no
longer** the always-wins document.

## Stack (mandated — do not substitute)
Next.js on Vercel · Meta WhatsApp Cloud API (**official only**) · Supabase (Postgres + RLS + Auth +
Storage) · Inngest (durable jobs) · OpenAI via a self-built gateway · TypeScript · Zod.

## Non-negotiables
Event-driven core (persist before process; idempotent; no duplicate downstream records) · hard
human-in-the-loop for money, accounting, permissions, employment and surveillance · AI output is
schema-validated, never free text into business logic · company isolation proven by tests · the
internally-owned double-entry **Accounting Core** (`src/accounting/*`) is the accounting source of
truth and **QuickBooks is not used** · official WhatsApp API only · GPS/CCTV/customer-facing agents
are gated behind legal-privacy review and unbuilt.

## Running the gates
```bash
npm run verify            # secret-scan, migration-lint, inventory check, typecheck, unit tests
npm run test:integration  # needs a disposable PostgreSQL 16 (see docs/TEST_STRATEGY.md)
npm run inventory         # refresh the machine-checkable completion inventory
```
