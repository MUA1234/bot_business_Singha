# Staging environment — what is required, and why none was created

**No staging environment exists.** `railway status --json` for project `singha-central`
(`cf0cfa34-bdc5-4e10-8753-f8d89907cf65`) lists exactly **one** environment, `production`, with
exactly one service, `singha-web`. There is no staging, preview or development environment.

The Release 1 brief permits deploying to *an existing clearly labelled non-production*
environment and forbids silently creating a paid or production-connected one. So none was
created, and **Release 1 cannot reach `STAGING VERIFIED`** until one exists.

Creating it costs money on Railway (no free tier — recorded in D-021) and requires a second
Supabase project. Both are owner decisions.

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
