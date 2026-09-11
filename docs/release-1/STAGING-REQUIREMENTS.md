# Staging environment — what is required, and why none was created

**No staging environment exists.** `railway status --json` for project `singha-central`
(`cf0cfa34-bdc5-4e10-8753-f8d89907cf65`) lists exactly **one** environment, `production`, with
exactly one service, `singha-web`, in workspace `lakshanv's Projects`. There is no staging,
preview or development environment.

## The determination — reassessed 2026-09-11 against the live dashboards

The earlier version of this document rested on D-021's statement that *"Railway has no free
tier"*. That was explicitly not to be relied on, so both accounts were re-inspected. **The
conclusion is unchanged and the evidence is now current rather than historical.**

The owner set two conditions, and staging may be created **only when both are true**.

### Condition 2 — Railway: **FAILS.** There is no included allowance to run it in.

`railway usage`, read 2026-09-11:

| Field | Value |
|---|---|
| Workspace | `lakshanv's Projects` |
| Billing period | Aug 29 – Sep 29, 2026 |
| Current usage / current bill | **$3.88** |
| Estimated bill | **$7.06** |
| Soft limit | **not set** |
| Hard limit | **not set** |
| Over limit | no |

This is a **usage-billed workspace with no free allowance being drawn down** — the bill accrues
from dollar zero and there is no included quota a second service could fit inside. Current usage
*is* the current bill, exactly.

Read twice on 2026-09-11, several hours apart: $3.85 → $3.88 current, $6.99 → $7.06 estimated.
The second reading is not a refinement of the first, it is the meter moving. A workspace whose
bill rises while nothing is being deployed is a workspace with no allowance left to absorb a
second service, which is the determination this section makes.

So a staging environment running `singha-web` is not "within already included usage"; it is
additional compute added directly to a live bill, and with no soft or hard limit set there is
nothing capping what it adds. That is a displayed additional charge, which the instruction says
not to accept.

### Condition 1 — Supabase: **cannot be verified**, which is itself a stop

Condition 1 requires Supabase to **explicitly show** the second project as free with no upgrade.
Nothing available here can see that:

| Route | Status |
|---|---|
| Supabase CLI | not installed, and `npx supabase` would install a package |
| `SUPABASE_ACCESS_TOKEN` / `SUPABASE_PAT` | not set |
| Supabase MCP connector | **requires authentication** — the OAuth flow cannot run in a non-interactive session |

The production service's `SUPABASE_SERVICE_ROLE_KEY` is a *project* key, not an account
management token; it can read that one database and cannot enumerate projects or report a plan.

So whether a second Free project is available is **unknown**, and "uncertain isolation" is a stop
condition in its own right.

### Consequence

**No staging environment was created.** Both conditions fail — one on measured evidence, one on
absent access — and guessing has an asymmetric downside: an unexpected charge on a bill with no
limit set, or a "staging" environment quietly pointed at the production database.

**Consequence: Release 1 cannot reach `STAGING VERIFIED`.** Everything that does not require a
deployment axis has been done and measured — see [DEPLOYMENT-READINESS.md](DEPLOYMENT-READINESS.md).

## What the owner needs to authorise, exactly

| Resource | Why | Cost |
|---|---|---|
| One Railway environment `staging` in `singha-central`, running `singha-web` | The deployment axis | Usage-billed; no free tier |
| One Supabase project, separate from `gazjughejdzebathpscb` | Isolation. Reusing production's database would make every isolation test meaningless | Whether the Free tier covers a **second** project with no upgrade — visible on the Supabase dashboard, which this process cannot reach (no CLI, no management token, connector unauthenticated) |

Two things worth deciding at the same time, because the usage reading exposed them:

* **No soft or hard usage limit is set** on the Railway workspace. Adding a second always-on
  service to a bill with no cap is a larger decision than adding one to a capped bill.
* The estimate is **$6.99** for the current period against **$3.85** spent so far. A staging
  service roughly doubles the running surface, so the honest expectation is a materially higher
  estimate, not a rounding difference.

Neither can be created by this process under the instruction it was given.

---

## What has to exist

### 1. A separate Supabase project

**Not** the production project `gazjughejdzebathpscb`. A separate project id, separate
credentials, separate database.

| Requirement | Why |
|---|---|
| Contains **no production customer data** | Verified by inspection before use, not assumed. Copying production data into staging is forbidden by the brief |
| Seeded with **synthetic multi-company fixtures** | At least two companies, because the isolation tests exist to prove one cannot see the other |
| Backup and restore **proven** before any migration | There are no down-migrations for the numbered sequence; restore is the only rollback |
| Same PostgreSQL major version as production (16) | A migration that behaves differently on another major version proves nothing |

### 2. A Railway environment named unambiguously

`staging` — not `prod2`, not `test`, and not a second service inside `production`. The name is
what a person reads at 3am before typing a command.

| Setting | Value | Note |
|---|---|---|
| `APP_ENV` | `staging` | **Not** `production`. Keeps the design lab and dev surfaces available and marks logs |
| `DATABASE_URL` | staging Supabase | Production has **no** `DATABASE_URL` at all (finding H-3), so this is new |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_*` | staging project's | Never the production values |
| `RLS_READS`, `RLS_WRITES` | **`on`** | The whole point of staging is to prove isolation before production. The app now refuses to start if these are unset |
| `IN_PROCESS_CRON` | `on` | Scheduler ownership is under test |
| `CRON_SECRET` | fresh, staging-only | Never copied from production |
| `MANAGEMENT_KERNEL` | `on` | Otherwise the cycle honestly reports `disabled` and proves nothing |
| `WHATSAPP_*` | **absent or a test number** | See below |
| `OPENAI_API_KEY` | owner's decision | Absent means the AI paths refuse; set means staging incurs model spend |

### 3. Meta / WhatsApp: nothing is repointed

The production webhook is **not** touched. Staging must not receive real customer messages, and
no real message may be sent from it.

Either leave `WHATSAPP_*` unset — the webhook route then refuses, which is a valid staging
posture — or register a **separate Meta test number**. Repointing the production callback is a
production boundary and needs its own approval; it is not part of standing staging up.

---

## Why `RLS_READS` / `RLS_WRITES` must be `on` in staging specifically

Production currently runs with both **unset**, which under the repository's `=== "on"`
convention means off: reads and writes go through the service-role client and company
separation rests on application code, not the database (finding H-2 / PR-F-012).

Owner decision 5 requires isolation to be enabled and **proven in isolated staging before
production**. Staging is where `on` is exercised for the first time. Turning it on in
production without that proof would be the same class of mistake as applying an unrehearsed
migration.

This candidate makes the absence impossible to have by accident: `assertProductionConfig`
refuses to start when either switch is unset or holds a value that is neither `on` nor `off`.

---

## The sequence, once it exists

1. Verify the staging database holds no production data.
2. Prove backup **and restore** on it. Restore is the rollback; an unproven restore is not one.
3. Deploy the exact candidate SHA — from git, so the deployment carries a commit hash. (The
   production deployment does not; see finding PR-F-014.)
4. Apply the reconciled migrations, recording every applied version.
5. Run the checklists in [RUNBOOK.md](RUNBOOK.md): RLS and cross-company, scheduler ownership,
   lifecycle through real composition, Ask-AI advisory-only, the single automated action against
   synthetic data, smoke, and rollback.

Only then is `STAGING VERIFIED` an honest claim.

---

## What can be verified without it

Everything except the deployment axis. The candidate has been verified on disposable local
PostgreSQL 16.10: fresh-database migration, a `main`-seeded rehearsal, the core campaign, the
kernel campaign, unit tests, typecheck, build, and the security gates. Those results are in
[DEPLOYMENT-READINESS.md](DEPLOYMENT-READINESS.md).

A disposable container is not a deployment. It proves the code and the schema agree; it proves
nothing about a hosted environment, its configuration, or its data.
