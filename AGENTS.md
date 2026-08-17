# AGENTS.md

This repository is governed by `CLAUDE.md` and the documents under `docs/`.
Any AI coding agent (Claude Code, Codex, or other) must follow the same rules.

> **V3.1 program (added 2026-08).** A V3.1 senior-management-intelligence evolution is scoped in
> `docs/architecture-v3.1/`. Its compatibility foundation — a default-OFF feature-flag registry
> (`src/config/flags.ts`) and canonical proposal contracts (`src/schemas/v3_1/*`) — is additive,
> consumed by no runtime path (this foundation specifically is zero behaviour change). The
> `0048+` security/accounting correction (pack WP10–WP18) — a **blocking prerequisite** for any V3.1
> finance/RLS/outbox cutover — is now **IMPLEMENTED as a controlled draft PR** (migrations **0048–0067**,
> integration branch `feature/v3-1-phase-1-external-review-fixes`), verified on a disposable PostgreSQL
> 16 (fresh + upgrade), **NOT merged, NOT deployed, hosted DB NOT migrated**, after nine external
> reviews (all CHANGES REQUESTED → corrected; awaiting the final review). It is **not** uniformly
> "inert while flags OFF" — the un-migrated hosted DB is the containment, not the flags. The sixth
> review added migration **0064**: the privileged delivery transitions
> (`ready→queued`/`queued→sent`/`ready→sent`) are RPC-only — a `current_user`-gated lifecycle trigger
> refuses them for direct table writes by authenticated/`service_role`, so they cannot bypass the atomic
> `enqueue_quotation_outbox` (0063) / fenced completion RPCs — plus an EXACT-payload recovery guard
> against stale outbox rows. The seventh review added migration **0065**, closing two residual boundary
> gaps: the scheduled drain `claim_outbox_batch` is now **quotation-aware** (a quotation-delivery outbox
> row is claimable only when its linked quotation is committed `queued`, so a stale `ready` row cannot be
> drained), and a direct-**INSERT** boundary lets a non-trusted writer create a quotation only in the
> initial state (`draft`, `sent_at` null) — enforced by a **positive owner allowlist** (not a role-name
> denylist), so a bespoke custom role is refused both the fabricating INSERT and the privileged UPDATE.
> The eighth review added migration **0066**: `_is_quotation_delivery_owner()` is now **signature-exact**
> (exact 9-arg `enqueue_quotation_outbox` identity + a migration-time fail-closed assertion that the three
> delivery functions exist, are all SECURITY DEFINER, share ONE owner unreachable by anon/authenticated/
> service_role); a BEFORE DELETE trigger refuses a non-trusted delete of a queued/terminal quotation or one
> with any outbox history (closing the claim-then-delete race); and once queued, the quotation and its
> `quotation_items` are a **frozen snapshot** (non-trusted writers may make only a `sent→accepted/rejected`
> decision). The eighth review's own security pass additionally hardened a `search_path`/`pg_temp`
> relation-shadowing class (every 0066 function schema-qualifies relations + pins
> `search_path = pg_catalog, public, pg_temp`; the WP12 delivery RPCs re-pinned via ALTER FUNCTION), froze
> the delivered `message_outbox` content against `service_role`, and added TRUNCATE/DELETE guards — with a
> full-codebase search_path audit of other-domain SECURITY DEFINER functions noted as a systemic follow-up
> out of WP12 scope. Note the `message_outbox` service-only DML boundary originated in migration **0038**
> (not 0048). The ninth review added migration **0067**: it performs that systemic follow-up — a
> catalog-driven audit re-pins EVERY non-extension SECURITY DEFINER + trigger function in `public` to
> `pg_catalog, extensions, public, pg_temp` (bodies unchanged; fails closed if an API role has CREATE —
> direct or SET-ROLE-reachable — on public/extensions; SELF-VERIFIES owner-agnostically, ABORTING if any
> function is left unsafe under a foreign owner; a permanent owner-agnostic integration gate blocks future
> unsafe functions, including a duplicated `pg_temp` not in first-occurrence-last position) — and closes a
> quotation-item vs atomic-enqueue race at a SINGLE linearization lock (the item-freeze guard reads the
> parent FOR UPDATE; enqueue takes NO item-row locks — one lock object cannot deadlock — and requires the
> expected total to equal the live `SUM(line_total)` UNCONDITIONALLY with no item-count exemption, refusing
> unpriced items, returning `stale` on any divergence; the freeze guard FAILS CLOSED on an unclassifiable
> caller such as raw `service_role` without JWT claims). Owner-approved
> hosted search_path check + self-verifying hardening scripts are prepared, not executed. Because the
> already-hosted 0038–0041 functions may be
> `authenticated`-executable, a read-only privilege check + a self-verifying, owner-approval-required
> emergency REVOKE hotfix are **prepared but not executed**
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
