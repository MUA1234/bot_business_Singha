# AGENTS.md

This repository is governed by `CLAUDE.md` and the documents under `docs/`.
Any AI coding agent (Claude Code, Codex, or other) must follow the same rules.

> **V3.1 program (added 2026-08).** A V3.1 senior-management-intelligence evolution is scoped in
> `docs/architecture-v3.1/`. Its compatibility foundation — a default-OFF feature-flag registry
> (`src/config/flags.ts`) and canonical proposal contracts (`src/schemas/v3_1/*`) — is additive,
> consumed by no runtime path (this foundation specifically is zero behaviour change). The
> `0048+` security/accounting correction (pack WP10–WP18) — a **blocking prerequisite** for any V3.1
> finance/RLS/outbox cutover — is now **IMPLEMENTED as a controlled draft PR** (migrations **0048–0063**,
> integration branch `feature/v3-1-phase-1-external-review-fixes`), verified on a disposable PostgreSQL
> 16 (fresh + upgrade), **NOT merged, NOT deployed, hosted DB NOT migrated**, after five external
> reviews (all CHANGES REQUESTED → corrected; awaiting the final review). It is **not** uniformly
> "inert while flags OFF" — the un-migrated hosted DB is the containment, not the flags. The latest
> (fifth) review added migration **0063**: an atomic service-only `enqueue_quotation_outbox` RPC that
> locks the quotation row and couples the outbox insert with ready→queued in one transaction (closing
> the enqueue race), plus a DB-boundary quotation-lifecycle trigger; the fourth added **0062** (lock
> every service-only SECURITY DEFINER function to `service_role`). Because the already-hosted 0038–0041
> functions may be `authenticated`-executable, a read-only privilege check + a self-verifying
> owner-approval-required emergency REVOKE hotfix are **prepared but not executed**
> (`docs/architecture-v2/HOSTED_SECDEF_PRIVILEGE_HOTFIX.md`). See
> `docs/architecture-v3.1/PHASE1_CONSOLIDATION_REPORT.md`. Start with
> `docs/architecture-v3.1/00_BASELINE_ASSESSMENT.md`.

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
  event ingestion, and a large passing unit + integration test suite (current counts in
  `docs/CURRENT_IMPLEMENTATION_STATUS.md`). TypeScript checks pass.
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
