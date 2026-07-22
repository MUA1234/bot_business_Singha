# DEPLOYMENT_PLAN.md

**Status:** Phase 0 deliverable — for review. Master spec §26. (Also the
`DEPLOYMENT_AND_ENVIRONMENTS` the build prompt names.)

## 1. Environments (§26)

| Env | Vercel | Supabase | Inngest | QuickBooks | Data |
|---|---|---|---|---|---|
| Local | `next dev` + `inngest-cli dev` | local or staging project | dev server | sandbox | seed only |
| Staging | staging deployment | **separate** staging project | staging env | **sandbox** | seed / sandbox |
| Production | prod deployment | **separate** prod project | prod env | prod (draft-only) | real |

**Staging and production use separate Supabase projects.** Never test new financial,
surveillance or AI-agent behaviour against production data (spec §26).

## 2. Deploy flow

`git push` → Vercel auto-deploy. Inngest functions are served from `/api/inngest`.
Provide `vercel.json` only if config is needed. Production deploys require **explicit
human approval** (see CLAUDE.md); no auto-promote to prod.

## 3. Migrations

- Supabase migrations are forward + reversible where practical, rehearsed on staging
  before production, with a backup taken first. See Prompt 8 (migration review) in
  `CLAUDE_DEVELOPER_PROMPT_PACK.md`.
- No destructive migration without a rehearsed rollback/recovery and a written runbook.

## 4. Secrets & config

All secrets in Vercel/Supabase env vars, per environment, never committed.
`.env.example` documents every variable (see `SETUP.md`). Production credentials are
least-privilege. Service-role key is server-only.

## 5. Feature flags

High-risk or incomplete capabilities ship behind `feature_flags` that **default off/
safe**. Gated domains (GPS/CCTV/agents) are flag-guarded and not merely absent.

## 6. Release readiness (Prompt 9/10)

Before staging: approved scope complete; required tests pass; migrations rehearsed;
config present but not exposed; permissions + isolation tested; integrations on
sandbox; flags default safe; audit + monitoring work; alerts have owners; rollback
documented; no open Critical/High findings. Before production: management +
developer + finance approval (finance integrations) + privacy/legal (gated features);
verified backups/restore; active monitoring; rollback owner available.

## 7. Backups & rollback

Verified backup + restoration before any production migration. Documented rollback
trigger, owner and procedure per release. Health checks gate promotion.

## 8. Topology

See `ARCHITECTURE.md` §6 for the deployment diagram.
