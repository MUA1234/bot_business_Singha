# Staging build-out and the production plan

> **Nothing in this document has been executed against a hosted system.** Staging was authorised
> with a US$15 ceiling and could not be built: the Supabase half requires account access this
> process does not have. The Railway half was deliberately not built alone, because a staging
> application with nowhere isolated to point is either useless or dangerous.
>
> **Actual staging spend: US$0.00.** No Railway environment, service or deployment was created.

---

## 1. Why staging was not created

The owner's instruction has a precondition inside it: *"Proceed only if the dashboard confirms it
fits within the account's free-project allowance and shows no paid upgrade."* That confirmation
cannot be obtained here, and neither can the project.

Four routes to creating a Supabase project, each checked on 2026-09-11 rather than assumed:

| Route | State |
|---|---|
| Supabase MCP connector | **Requires authentication.** The OAuth flow cannot run in a non-interactive session. No `mcp__…Supabase…` tool is available |
| Supabase CLI | **Not installed.** Not on `PATH`, not in `node_modules/.bin`, not a global npm package, not in WinGet/Chocolatey/Scoop |
| A stored access token | **Absent.** `~/.supabase/` exists but holds only `telemetry.json` and `traces/` — no `access-token`. No `SUPABASE_ACCESS_TOKEN` or `SUPABASE_PAT` in the environment |
| A token in Railway's production variables | **Absent.** All 26 production variable NAMES were listed (values never read). The only Supabase credentials are `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` — **project** keys, which can read and write that one database and cannot enumerate projects, read a plan, or create anything |

`supabase login` is an interactive browser flow. There is no non-interactive path.

**Railway is not the blocker.** The CLI is authenticated as `lakanthi7@gmail.com` and
`railway environment new staging` would work. It was not run because a staging `singha-web` with
no isolated database has exactly two options — point at production Supabase, which the owner
forbade and which would make every isolation test meaningless, or point at nothing — and because
creating billable compute that cannot serve its purpose spends the budget without buying evidence.

### What the owner needs to do

One action, and everything below is prepared for it:

1. Create a Supabase project named `singha-management-staging`, confirming on the dashboard that
   it is within the free-project allowance with no upgrade.
2. Either supply a Supabase **personal access token** (so this can be automated end to end), or
   hand over the new project's URL, anon key and service-role key for staging variables.

---

## 2. The staging variable set, populated individually

Not cloned from production. Each line below is a deliberate value, and the four marked **NEVER**
are the ones that must not carry a production value under any circumstance.

| Variable | Staging value | Why |
|---|---|---|
| `APP_ENV` | `staging` | Not `production`; the fixture seed refuses `production` outright |
| `APP_BASE_URL` | the staging Railway domain | Own domain, never production's |
| `NEXT_PUBLIC_SUPABASE_URL` | **NEVER production.** The new staging project's URL | Baked into the client bundle at build time |
| `SUPABASE_URL` | **NEVER production.** Same staging URL | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **NEVER production.** Staging anon key | |
| `SUPABASE_SERVICE_ROLE_KEY` | **NEVER production.** Staging service-role key | |
| `RLS_READS` | `on` | Explicit, not defaulted — owner decision 5 |
| `RLS_WRITES` | `on` | Explicit, not defaulted |
| `EXECUTION_ENABLED` | *unset* | Default off. Set to `on` only for the controlled execution window, then unset |
| `MODEL_JOBS` | `off` | No model spend. Independent of execution by design |
| `MANAGEMENT_KERNEL` | `on` | The loop is what staging exists to exercise |
| `IN_PROCESS_CRON` | `on` | Railway is the sole scheduler (D-021). Staging-local jobs only |
| `WHATSAPP_ASYNC` | `off` | No async delivery path |
| `WHATSAPP_ACCESS_TOKEN` | a synthetic non-token | Outbound must fail closed, not succeed quietly |
| `WHATSAPP_APP_SECRET` | a fresh staging secret | Webhook signature verification still real |
| `WHATSAPP_PHONE_NUMBER_ID` | `000000000000000` | Obviously not a real number |
| `WHATSAPP_VERIFY_TOKEN` | a fresh staging token | **No Meta callback is configured to point here** |
| `OPENAI_API_KEY` | empty | |
| `CRON_SECRET` | freshly generated | Never production's |

Absent on purpose: every payment credential, every external business-effect credential, and any
Meta callback registration.

### Pre-deploy verification, before the first deployment

```
railway variables --service singha-web --environment staging --json
```

and assert, mechanically, that no value equals or contains: the production Supabase project ref
`gazjughejdzebathpscb`, the production `SUPABASE_URL`, the production service-role key, the
production `CRON_SECRET`, or the production WhatsApp phone number id. A staging environment that
shares any one of those is not a staging environment.

### Cost containment

Railway's workspace has **no soft or hard limit set** (checked twice on 2026-09-11: usage moved
$3.85 → $3.88 and the estimate $6.99 → $7.06 while nothing was deployed). Before creating the
staging service, set a **hard limit** on the workspace. With one at US$15 the ceiling is enforced
by Railway rather than by attention.

After verification: disable the staging scheduler, confirm execution/model/outbound are off, and
scale the staging service to zero. Keep the environment and the database — the evidence and the
configuration are the point.

---

## 3. The conflict the owner must resolve first

**Migrations `0001–0110` do not create the management kernel.**

Verified on a database built from exactly that range: `management_items`,
`management_item_evidence`, `management_item_recommendations`, `management_item_decisions`,
`management_execution_attempts`, `management_execution_enablement`, `management_kernel_enablement`,
`management_task_idempotency` and `ask_ai_answers` are **all absent**. Every one lives in the
quarantined R1 draft chain, which owner decision R1-D-1 kept out of the production numbering.

So the instruction "apply migrations 0001–0110" and the instruction "prove the twelve loop
properties" cannot both be satisfied. Staging must apply the **30 draft units as well**, or
proofs 1–11 have no tables to run against.

This is not a new decision so much as a visible one: it is the same question as *does Release 1
include the management kernel at all*. Applying the drafts to a disposable staging database is not
the thing R1-D-1 prohibited — that was taking production migration numbers — and staging is
precisely where the chain should be exercised before that numbering decision is made.

**Recommendation:** apply `0001–0110` and then the 30 draft units to staging, exactly as the local
stack does, and keep the production numbering decision separate and later.

---

## 4. Backup readiness — NOT established

The owner's own bar is *"a managed backup with a verified restore path, or an encrypted logical
backup plus a successful restore rehearsal in an isolated database"*. Neither is in place, and the
first cannot even be inspected from here: reading a Supabase project's backup or PITR
configuration is a management-API operation, and there is no management token. It is not visible
in SQL.

What **is** established, and is not a substitute:

* the pending range applies cleanly over the **real production ledger** — `rehearse-from-ledger`
  replays the committed 69-row evidence file and applies 0070–0110, reaching 110 rows and
  high-water 0110 with no draft object leaking in;
* twelve adversarial migration scenarios hold, including interruption, duplicate version, altered
  migration, missing dependency, and restore-then-reapply.

That is rehearsal of the *migration*, not of a *restore*. **Production deployment must not be
recommended until a backup exists and a restore has actually been performed into an isolated
database.**

---

## 5. The production plan — prepared, NOT executed

Each step has an explicit stop condition. Steps 1–4 are prerequisites; nothing after step 4 may
begin until all four are satisfied.

| # | Step | Detail | Stop if |
|---|---|---|---|
| 1 | **Backup confirmed** | A managed backup with a verified restore path, or an encrypted logical backup restored into an isolated database and checked | No verified restore. Do not proceed on the existence of a backup alone |
| 2 | **Maintenance window** | Agreed with the owner. 41 migrations; the rehearsal completes in seconds on an idle database, but the window must cover a rollback | No agreed window |
| 3 | **Model jobs disabled** | Set `MODEL_JOBS=off` and confirm `ai-monitor` stops, **without** stopping inbound or outbox | Inbound or outbox also stops — that is the wrong switch |
| 4 | **Outbound drain protected** | Confirm `message_outbox` has no `queued` row mid-flight; let the drain finish | Rows are in flight |
| 5 | **Migrations 0070–0110** | `npm run migrate` against production. Forward-only, one transaction each | Any migration fails — stop, do not patch the schema by hand |
| 6 | **Post-migration verification** | 110 contiguous rows, no duplicates, high-water 0110, marker objects present, no draft object | Any check fails |
| 7 | **Deploy the candidate** | The exact verified SHA, from git so the artifact carries a commit hash — the current production artifact has none (`railway up` from a CLI) | The deployed SHA is not the verified one |
| 8 | **RLS verification** | `RLS_READS=on`, `RLS_WRITES=on`, proven against the live database, not assumed from the variable | Either is off or unproven |
| 9 | **Scheduler single owner** | Railway only. No Vercel cron, no second scheduler | Any second scheduler is reachable |
| 10 | **Smoke tests** | Routes served and gated; cron routes refuse an unauthenticated caller and a wrong secret; Ask-AI refuses a caller-supplied `companyId` and `membershipId` | Any smoke test fails |
| 11 | **Rollback thresholds** | Any 5xx on a scheduled route, any cross-company read, any unexpected `management_execution_attempts` row, or any outbound send. Rollback = redeploy the previous artifact; the schema is forward-only, so a schema rollback is a restore from step 1 | Any threshold is crossed |
| 12 | **Meta callback** | A **separate, final** action after everything above is stable. Not part of this deployment | Anything above is unresolved |

**Execution stays disabled in production.** `EXECUTION_ENABLED` unset, and the server-side
`r1_exec_global_boundary` row false. Both, independently.

---

## 6. Verdict

**Production: NO-GO.** Two independent reasons, either sufficient:

1. **No verified backup restore** (§4). This is the owner's own bar.
2. **Staging has never run.** The candidate has never executed on a hosted deployment axis, which
   is the one axis local evidence cannot substitute for.

The engineering is not the blocker. What is unproven is the deployment, and what is missing is an
account credential and a restore.

---

## 7. Two regressions the draft chain introduces — found by applying it to the live stack

Both appeared the moment the 30 draft units were applied on top of `0001–0110`, and neither is
visible in any campaign that runs the released chain alone. They bear directly on the §3 decision.

### 7.1 `F-004` — 41 unbounded user-writable text columns, all on draft tables

Migration `0110_bounded_user_text` is the released chain's answer to unbounded user input. The
draft chain reintroduces the problem on its own tables:

| Table | Unbounded, `authenticated`-writable text columns |
|---|---|
| `management_items` | **25** |
| `management_item_feedback` | 4 |
| `management_item_transitions` | 4 |
| `management_item_evidence` | 3 |
| `observation_sources` | 3 |
| `management_execution_enablement` | 1 |
| `management_kernel_enablement` | 1 |
| **Total** | **41** |

Zero are on released tables. The gate that catches it —
`tests/hard-scenario/f004-bounded-text.test.ts` — derives the list from the catalogue, so it will
keep catching it.

**Not fixed here, deliberately.** A bound is a product decision (how long may a `routing_reason`
be? a `refusal_reason`? a `note`?), and inventing 41 limits to make a gate green is the kind of
fix that looks like progress and buys nothing. It needs an owner's answer, then one draft unit.

### 7.2 `F5` / `F-009` — the composite tenant-integrity FK gap widens from 103 to 120

The recorded ceiling is 103 single-column foreign keys whose parent is not scoped by
`(company_id, id)`. With the draft chain applied it is **120** — 17 new ones, all from draft
tables. The suite asserts the gap does not WIDEN, and it widened.

**Both are blockers for promoting the draft chain**, not for the released `0070–0110` range. They
do not affect the production migration plan in §5, which applies released migrations only.
