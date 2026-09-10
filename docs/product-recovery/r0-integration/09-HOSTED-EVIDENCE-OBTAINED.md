# Hosted evidence — what was obtained, and what is still blocked

**Collected 2026-09-10** by the development process, read-only. No hosted write, migration,
DDL, side-effecting RPC or business-data query was performed. No secret value was printed,
logged or committed.

| | |
|---|---|
| Method | `railway` CLI v5.49.3, authenticated as the project owner |
| Actions | `railway list`, `railway link` (scratch dir), `railway status --json`, `railway variables --json` |
| Mutations | **none** — every command above is read-only |

---

## A. Railway provenance — checklist R1

| # | Question | Answer |
|---|---|---|
| R1.1 | Service name | **`singha-web`** |
| — | Project | **`singha-central`**, id `cf0cfa34-bdc5-4e10-8753-f8d89907cf65` |
| — | Environment | **`production`**, id `956e1d09-054b-4b3a-befd-2beb2f70e57f` |
| — | Service id | `1efb0bd9-8fe9-46f3-91b7-5207531e253b` |
| — | Public URL | `https://singha-web-production.up.railway.app` |
| — | Status | **Online**, 1 instance `RUNNING`, region `sfo`, **1 replica** |
| R1.2 | Deployment **source type** | **CLI** — see below |
| R1.3 | Configured repository | **`MUA1234/bot_business_Singha`** (`source.repo`) |
| R1.5 | **Commit SHA of the active deployment** | **NONE** — no `commitHash` on the deployment |
| R1.6 | Active deployment | `1a806770-4197-4a4c-a1b3-b6ccdc3a3eac`, created **2026-09-01T12:33:59.343Z** |
| R1.7 | Trigger | `meta.cliCaller: "claude_code"`, `meta.reason: "deploy"`, `cliAgentSessionId` present |
| R2.3 | Builder | **RAILPACK** (`buildEnvironment: V3`) |
| R2.1/R2.2 | Build / start command | **both `null`** — builder defaults |
| R2.6 | Healthcheck path / timeout | **`null`** — no healthcheck configured |
| R2.7 | Replicas | **1** (`sfo`) |
| — | Service-level `cronSchedule` | **`null`** — no Railway-native cron |
| — | Image digest | `sha256:897348ef806c244b1e8dd2e36c7a7a90c48f5c8c609f9494196169fa2c3e0a05` |

### PR-F-014 / R0-F-007 is CONFIRMED, with a nuance worth recording

The service **is** connected to `MUA1234/bot_business_Singha`, which on its own looks like a
GitHub deployment. It is not. The **active deployment carries no commit hash** and its
metadata names the CLI as the caller (`cliCaller: "claude_code"`, `reason: "deploy"`). So the
running artifact was pushed by `railway up`, not built from a git ref.

**The deployed revision remains UNAVAILABLE, not merely unconfirmed.** It cannot be
reproduced or audited from git. The connected repository field must not be read as
provenance — it describes what *would* build, not what *is* running.

The only durable identifier for the running artifact is the image digest above.

---

## B. Scheduler ownership — checklist R3 / R4

| # | Question | Answer |
|---|---|---|
| R3.1 | `IN_PROCESS_CRON` | **set, value `on`** (non-secret) |
| R3.2 | `CRON_SECRET` | **set** (value withheld) |
| R3.4 | Railway-native cron on the service | **none** (`cronSchedule: null`) |
| R3.5 | Other services in the project | **none** — `singha-web` is the only service |
| R2.7 | Replicas | **1**, so exactly one scheduler process |

**The Railway in-process scheduler IS running in production.** Both of `src/lib/scheduler.ts`'s
start conditions hold (`IN_PROCESS_CRON=on` and `CRON_SECRET` present), and with one replica
there is exactly one scheduler.

It therefore runs `main`'s `DEFAULT_JOBS` — `outbox` (1 min), `follow-ups` (15 min),
`ai-monitor` (1 h), `daily-digest` (24 h).

**It does NOT run `inbound-sweeper` or `dispatch-drain`** — those routes do not exist on
`main` and are not in `DEFAULT_JOBS`. This is the gap recorded in
[05-MAIN-REGRESSION-RECONCILIATION.md](05-MAIN-REGRESSION-RECONCILIATION.md) §1, now
confirmed against the live configuration rather than inferred.

### Finding H-1 (P1) — unauthorised model spend is live

`OPENAI_API_KEY` is **set** and `IN_PROCESS_CRON=on`, so the `ai-monitor` job has been making
model calls **hourly** since the deployment of 2026-09-01. No paid model calls are authorised
during R0–R3 (`13-OWNER-DECISIONS-RECORD.md`).

This is stated as a finding, not acted on: changing a production variable or the scheduler is
outside the authorised scope. **Owner action required** — either accept the spend explicitly,
or set `IN_PROCESS_CRON` off (which would also stop the outbox drain, the only recovery path
for a failed customer message) or remove the key.

---

## C. Configuration manifest — names and presence only

26 variables are set on `singha-web` / `production`. **No value below is printed except the
three non-secret operational flags.**

| Variable | Set | Value |
|---|---|---|
| `APP_BASE_URL` | ✅ | withheld |
| `APP_ENV` | ✅ | **`production`** (non-secret) |
| `CRON_SECRET` | ✅ | withheld |
| `IN_PROCESS_CRON` | ✅ | **`on`** (non-secret) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | withheld |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | withheld |
| `SUPABASE_URL` | ✅ | withheld |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | withheld |
| `OPENAI_API_KEY` | ✅ | withheld — see **H-1** |
| `WHATSAPP_ACCESS_TOKEN` | ✅ | withheld |
| `WHATSAPP_APP_SECRET` | ✅ | withheld |
| `WHATSAPP_PHONE_NUMBER_ID` | ✅ | withheld |
| `WHATSAPP_VERIFY_TOKEN` | ✅ | withheld |
| `NIXPACKS_NODE_VERSION`, `RAILPACK_NODE_VERSION` | ✅ | withheld |
| `RAILWAY_*` (11 platform-injected) | ✅ | platform values |
| **`RLS_READS`** | ❌ **unset** | — |
| **`RLS_WRITES`** | ❌ **unset** | — |
| **`DATABASE_URL`** | ❌ **unset** | — |
| `V3_1_*` (any) | ❌ none set | — |

### Finding H-2 (P0 for Release 1) — production runs with RLS bypassed

`RLS_READS` and `RLS_WRITES` are **both unset**, and `src/config/env.ts` treats a flag as on
only when it is exactly `"on"`. Production therefore reads and writes through the
service-role client, and **company isolation rests on application code, not the database**.

This is PR-F-012, now confirmed on the live service rather than inferred. It is the reason
Release 1 must ship fail-closed production configuration validation (§8 of the Release 1
brief): a production start with database isolation silently disabled must become impossible.

### Finding H-3 — no `DATABASE_URL` on the service

The application reaches Supabase over PostgREST; it holds no direct Postgres connection
string. Two consequences:

1. **`scripts/migrate.mjs` has never run from the Railway service** — it requires
   `DATABASE_URL` and would exit 2. Whatever migration state exists on the hosted database
   was produced from somewhere else (a workstation, or the Supabase dashboard).
2. Applying migrations to production will need a connection string that does not currently
   live on the service. That is a deployment-runbook input, not a code change.

### Finding H-4 — no staging environment exists

`railway status --json` lists exactly **one** environment: `production`. There is no
staging, preview or development environment in `singha-central`, and `singha-web` is its
only service.

**Consequence for Release 1:** step 11 of the brief (deploy the candidate to an existing
clearly-labelled non-production staging environment) **cannot be executed**. The brief
forbids silently creating a paid or production-connected environment, so none was created.
The exact creation requirements are in
[`STAGING-REQUIREMENTS.md`](../../release-1/STAGING-REQUIREMENTS.md).

---

## D. What remains BLOCKED — the hosted database

**The hosted migration ledger and object markers were NOT obtained. Hosted migration state
is still UNKNOWN, and the decision-tree case is still unclassified.**

### The exact blocker

The service holds no `DATABASE_URL`, so the only read path is PostgREST using
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. To use those without ever exposing them, the
probe was written to run under `railway run`, which injects the service environment into a
child process:

```
railway run --service singha-web -- node probe.mjs
```

**This command was refused by the Claude Code auto-mode permission classifier.** It is a
sandbox permission boundary, not a Railway or credential failure. It was not worked around.

The probe (`scripts/hosted/probe.mjs` in the candidate branch) is written, reviewed and
ready. Its safety properties:

* every request is a `GET`;
* object-existence probes use `limit=0`, so **zero business rows** are returned;
* the only rows read are `schema_migrations` (version, filename, applied_at) — deployment
  metadata, not customer or business data;
* no RPC, no write, no DDL;
* credentials are read from the environment and **never printed** — it reports only the
  endpoint host and the key's character count.

### Two ways to unblock, either sufficient

1. **The owner runs it.** From a directory linked to `singha-central`:
   ```
   railway run --service singha-web -- node scripts/hosted/probe.mjs
   ```
   It writes `hosted-evidence.json` (ledger rows + booleans) and prints a readable summary.
   Return that file or the printed output.
2. **Grant the permission.** Add a Bash permission rule for `railway run` in Claude Code
   settings, and this session can complete the probe itself.

### What is settled the moment it runs

| Question | Settled by |
|---|---|
| Has any migration been applied by the runner? | ledger presence |
| The true high-water mark, and any gaps | ledger rows |
| **Which 0069 is deployed — record and reality** | ledger row `0069` + object markers |
| Whether the record and the reality agree | the two together |
| Which company-resolution design exists | `channel_accounts` / `channel_identities` |
| Whether any of 0069–0109 is already present | the 27-table probe |
| Whether the R1 draft quarantine held | `r1_draft_migrations` probe |

Until then the decision-tree case is **unclassified**, and no migration may be applied to
the hosted database. See [02-MIGRATION-DECISION-TREE.md](02-MIGRATION-DECISION-TREE.md).
