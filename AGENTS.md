# AGENTS.md

This repository is governed by `CLAUDE.md` and the documents under `docs/`.
Any AI coding agent (Claude Code, Codex, or other) must follow the same rules.

## Start here, every session

1. Read `CLAUDE.md`.
2. Read `docs/architecture-v2/NEXT_PHASE_DEVELOPER_BRIEF.md` (the current approved
   phase — the Production Control Foundation, work packages WP0–WP6 in order).
3. Read the target architecture: `docs/architecture-v2/CHANGE_PLAN.md` +
   `docs/architecture-v2/Singha_AI_Management_Architecture_V2.puml`.
4. Read `docs/CURRENT_IMPLEMENTATION_STATUS.md` for what actually exists.
5. Follow the document precedence in `CLAUDE.md`. **Never build ahead of the approved
   work package. Do exactly one work package at a time.**

## Current state

- **This is a WORKING application**, not a Phase-0 documentation stub. It has an app
  shell, Supabase auth, department dashboards, an admin panel, a live official Meta
  WhatsApp Cloud API quotation flow, an internally-owned double-entry Accounting Core,
  event ingestion, and **195 passing unit tests (46 files)**. TypeScript checks pass.
- **Current approved phase:** Production Control Foundation
  (`docs/architecture-v2/NEXT_PHASE_DEVELOPER_BRIEF.md`). It is a foundation-hardening
  phase (identity/RLS, accounting controls, staff progress, durable WhatsApp, AI-manager
  loop, reliability/CI) — **not** a new-feature expansion phase.
- The original WhatsApp bot that patterns were referenced from lives in a **separate**
  repository: `Automation_Singha_Auctions` ("Sasiri WhatsApp AI Agent"). This repo
  (`bot_business_Singha`) is a standalone build. See
  `docs/EXISTING_SYSTEM_ASSESSMENT.md` and `docs/MIGRATION_FROM_EXISTING_BOTS.md`.

## Non-negotiable constraints (summary — see CLAUDE.md for full text)

1. Event-driven core: persist every event before processing; idempotent, deduped,
   retryable, auditable. No duplicate downstream records, ever.
2. Hard human-in-the-loop for money, accounting posts, permissions, employment,
   legal notices and surveillance. AI proposes; humans approve.
3. AI output never flows as free text into business logic. Always:
   Zod schema → deterministic authority rules → permission check → audit log.
4. Company isolation is a critical security boundary at every layer.
5. Fixed sources of truth: the internally-owned double-entry **Accounting Core**
   (`src/accounting/*`) = accounting (QuickBooks is **not** used — D-011); operational
   Postgres = tasks/staff/approvals; WhatsApp/GPS/CCTV = inputs and evidence.
6. Preserve the existing bot; reuse where sound; do not re-platform for preference.
7. Privacy gates: no facial recognition; no GPS/CCTV until legal review. Build last.

## Tooling

- Package manager: npm. Language: TypeScript. Validation: Zod.
- WhatsApp: Meta Cloud API only (never `whatsapp-web.js` / Baileys / `venom-bot`).
- Durable/scheduled/money-touching work: Inngest functions at `/api/inngest`.
- Never add a paid managed service; document the trade-off in `docs/DECISIONS.md`.

## Reporting

At the end of every work package, report using the 11-point completion template in
`docs/architecture-v2/NEXT_PHASE_DEVELOPER_BRIEF.md` (§6, "REQUIRED COMPLETION REPORT")
and stop for approval before the next work package.
