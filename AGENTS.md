# AGENTS.md

This repository is governed by `CLAUDE.md` and the documents under `docs/`.
Any AI coding agent (Claude Code, Codex, or other) must follow the same rules.

## Start here, every session

1. Read `CLAUDE.md`.
2. Read `docs/AI_BUSINESS_MANAGER_MASTER_SPEC.md` (authoritative — wins on conflict).
3. Read the approved documents for the current phase (`docs/PHASED_IMPLEMENTATION_PLAN.md`).
4. Confirm which phase is approved. **Never build ahead of the approved phase.**

## Current state

- **Phase 0 (assessment & architecture) — in review.** Documentation only.
- No application code has been written. The `docs/` set is the deliverable.
- The existing WhatsApp bot being assessed lives in a **separate** repository:
  `Automation_Singha_Auctions` ("Sasiri WhatsApp AI Agent"). This repo
  (`bot_business_Singha`) is where the new platform is built. See
  `docs/EXISTING_SYSTEM_ASSESSMENT.md` and `docs/MIGRATION_FROM_EXISTING_BOTS.md`.

## Non-negotiable constraints (summary — see CLAUDE.md for full text)

1. Event-driven core: persist every event before processing; idempotent, deduped,
   retryable, auditable. No duplicate downstream records, ever.
2. Hard human-in-the-loop for money, accounting posts, permissions, employment,
   legal notices and surveillance. AI proposes; humans approve.
3. AI output never flows as free text into business logic. Always:
   Zod schema → deterministic authority rules → permission check → audit log.
4. Company isolation is a critical security boundary at every layer.
5. Fixed sources of truth: QuickBooks = accounting; operational Postgres =
   tasks/staff/approvals; WhatsApp/GPS/CCTV = inputs and evidence.
6. Preserve the existing bot; reuse where sound; do not re-platform for preference.
7. Privacy gates: no facial recognition; no GPS/CCTV until legal review. Build last.

## Tooling

- Package manager: npm. Language: TypeScript. Validation: Zod.
- WhatsApp: Meta Cloud API only (never `whatsapp-web.js` / Baileys / `venom-bot`).
- Durable/scheduled/money-touching work: Inngest functions at `/api/inngest`.
- Never add a paid managed service; document the trade-off in `docs/DECISIONS.md`.

## Reporting

At the end of every implementation phase, report using the 12-point template in
`docs/CLAUDE_DEVELOPER_PROMPT_PACK.md` (Prompt 4) and stop for approval.
