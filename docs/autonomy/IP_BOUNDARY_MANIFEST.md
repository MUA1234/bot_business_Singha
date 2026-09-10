# IP boundary manifest

> **The repository is public. Treat that as permanent.** Technical controls cannot stop someone
> copying a screen. The defensible advantage is server-side intelligence, organizational memory,
> proprietary playbooks, accumulated outcomes, integrations and company data — not the UI.

## Classification

| Class | Examples | Public? |
|---|---|---|
| Safe public contracts | Zod schemas, TypeScript types, event/command shapes | ✅ yes |
| Safe public schema | Migrations, RLS policies, constraints | ✅ yes — the security model must be reviewable |
| Public UI | Components, layout, styling | ✅ yes |
| Server-only code | `supabase/server`, `config/env`, provider transports | ✅ source public, but must never reach a client bundle |
| Proprietary configuration | Ranking weights, optimization thresholds, scoring cut-offs | ❌ no — none committed today |
| Proprietary prompts | System prompts encoding decision logic | ⚠️ **currently public** — see Open Risk below |
| Evaluation datasets | Private scenario packs, scored expectations | ❌ no — the committed pack is synthetic and deliberately public |
| Company playbooks | Per-company SOPs, escalation rules | ❌ no — belongs in the database, per company, never in the repo |
| Business strategy rules | Pricing strategy, margin rules | ❌ no |
| Model-routing strategy | Which model for which decision, budgets | ⚠️ route table is public; costs and budgets are not committed |
| Credentials | Any provider key, signing key, private key | ❌ never — enforced by `secret-scan` and `autonomy:ip-check` |

## Enforced controls (present today)

- `npm run secret-scan` — no tracked secrets; part of `verify`.
- `npm run autonomy:ip-check` — fails on a client component importing a server-only module, on a
  tracked private key, or on a proprietary path; reports public env vars named like secrets and
  committed system prompts for review. Part of `verify`.
- Strict CSP; no external font/script hosts.
- Webhook signature verification with timing-safe comparison; replay-resistant idempotency keys.
- Service-only SECURITY DEFINER RPCs, signature-exact allowlist, canonical `search_path`.
- Company-scoped queries; RLS policies present (cutover is FOUND-006).
- Narrow API payloads — cron routes return counts only, never recipients or bodies.
- Provider errors report status only, never a body that could echo request content.

## Open risk (recorded, not fixed)

**System prompts are committed publicly** (`src/ai/prompts.ts`, `manager-observation.ts`,
`quotation.ts`). Today they are largely generic instruction text rather than proprietary decision
logic, so this is acceptable — but the moment a prompt encodes company-specific routing, pricing or
authority reasoning, it must move out of the public repository. That decision is **owner gate 6**.

Suggested boundary when that happens: prompts and evaluation datasets load from private
configuration (environment or a private package) at runtime; the public repository keeps the
contract and the loader, never the content.
