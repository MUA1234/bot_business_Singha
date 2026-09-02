# R0 owner-gate action guide

**Read-only. No hosted service was contacted to produce this, and none should be changed to
answer it.** Each gate below is a fact this repository cannot establish about itself, with
the shortest path to the answer.

> ## ⚠️ NEVER PASTE A SECRET
>
> **Do not paste a password, token, API key, service-role key, WhatsApp verify token, or a
> database connection string into a session, a chat, or a commit.** Nothing in this guide
> needs one. Every value requested below is non-sensitive: a commit id, a column name, a
> count, a hostname.
>
> If a screen shows a secret beside the value being requested — Supabase *Settings →
> Database*, Railway *Variables*, Meta's *verify token* field — **crop the screenshot or
> retype only the named field.**

| Gate | Priority | Status |
|---|---|---|
| Railway active deployment SHA | **1** | **INSPECTED — the SHA does not exist to be found (R0-F-007)** |
| Hosted Supabase migration/schema truth | **2** | open |
| Meta callback destination | 3 | **deferred by owner decision** |

Priority 2 is now the only remaining gate the owner can close by reading a dashboard, and it
gates more downstream work than anything else outstanding. **Priority 1 has been inspected and
cannot be closed** — see below; the answer is that no commit id exists for the running
deployment.

---

## ⛔ Priority 1 — Exact Railway deployment SHA — **INSPECTED; UNAVAILABLE**

### OWNER EVIDENCE, 2026-09-02 — the deployed SHA is UNAVAILABLE and UNVERIFIED

The owner inspected the active `singha-web` deployment. It reports:

| Field | Value |
|---|---|
| Source | `railway up` |
| Method | **CLI** |
| Status | Active / Deployment successful |
| Deployed | approximately 16 hours before inspection |
| Git commit SHA | **none displayed, after expanding the deployment** |
| GitHub source | **none displayed** |

**The deployed SHA is therefore recorded as UNAVAILABLE / UNVERIFIED.** It is not "unknown
pending a look" — it has been looked at, and **no commit id exists to record**. No Railway
change was made during the inspection.

**It must not be inferred.** Not from earlier GitHub-sourced deployments, not from the
public-page fingerprint the audit used, not from nearby commits, and not from D-021. Any
statement of the form "production is probably `acd9fbe`" is now withdrawn.

### Why this is worse than an unconfirmed SHA — finding R0-F-007

A `railway up` CLI deployment **uploads a local working directory**. It carries no git
provenance by construction. Three consequences follow, and they are facts about the method,
not speculation:

1. **The running artifact may not correspond to any commit in this repository.** A CLI deploy
   captures whatever was in that directory — which may have included uncommitted, unstaged or
   unpushed changes.
2. **What is running cannot be reproduced or audited from git.** There is no revision to check
   out, diff, or review.
3. **D-021 is contradicted.** The decision record states the service is *"deployed from GitHub
   `MUA1234/bot_business_Singha`@`main`"*. The active deployment was not. Either the GitHub
   integration was bypassed for this deploy, or it is not in force — and the record no longer
   describes reality. This is the same class of defect as PR-F-004: an authoritative document
   disagreeing with the live system.

### What this does NOT change

- The **schema** question (Priority 2) is a fact about the database and is unaffected by how
  the code was deployed. It remains answerable and is now the priority.
- The Vercel origin is still `402 DEPLOYMENT_DISABLED`, and inbound WhatsApp remains
  **unverified** (Priority 3, deferred).

### What it blocks, now firmly

- **The R1-F-001 hotfix decision cannot be made on evidence.** Whether the
  escalation-fallback defect is live is unknowable while the running code has no identity.
  The hotfix stays recorded and uncreated.
- **Any before/after comparison during R2** has no baseline to compare against.
- **Case A of the decision tree loses part of its support.** Its "likely" label rested partly
  on D-021's GitHub-deploy claim, which no longer holds for the active deployment. Priority 2's
  query is now the *only* evidence that can decide the case.

### The only ways to recover a deployed identity (owner decision, not an action to take now)

None of these should be done without a separate decision; they are listed so the options are
visible:

- **Redeploy from GitHub** so the running artifact has a commit id again — this *changes
  production* and is explicitly out of scope here.
- **Inject the build SHA at build time** and expose it on `/api/health`, so the question can
  never recur. A CLI deploy from a dirty tree should mark itself dirty rather than claim a
  clean commit.
- **Adopt GitHub-sourced deploys only**, matching what D-021 already claims, and correct D-021
  either way.

Until one is chosen, **"what is running in production" is not a knowable fact**, and every
plan that depends on it must say so rather than assume.

### For the record — where this was inspected

Railway → project **`singha-central`** → service **`singha-web`** → **Deployments** → the
entry marked **Active**, expanded. That is the correct place; it simply has no commit id to
show for a CLI-sourced deployment.

### Nothing further is requested for this gate

There is no value to paste back and no SQL to run. The gate is closed as **inspected and
unresolvable by inspection**, and it reopens only if the owner chooses one of the recovery
options above.

**Safety.** The inspection was read-only and no Railway change was made. Should this gate be
revisited: do **not** click Redeploy, Restart or Rollback, and do **not** open the Variables
tab or paste any environment variable value.

---

## 🔴 Priority 2 — Hosted Supabase migration and schema truth

### The unknown fact

`docs/architecture-v2/MIGRATION_STATE.md` — which declares itself the authoritative record —
states that nothing after migration `0041` was applied to a hosted database.

The audit's counter-evidence was that the deployed code *appeared* to require migration 0069
(`src/lib/whatsapp-inbound.ts` on `main` resolves the inbound company from
`companies.whatsapp_phone_number_id`, a column only that migration creates). **That argument
is now weaker, because R0-F-007 established that the running code has no verifiable identity**
— it may or may not be `main`. The contradiction is no longer "record versus deployed code";
it is simply "the record is unverified".

This makes the query below **more** important, not less: it is now the *only* evidence about
the hosted schema that does not depend on knowing what is deployed. Whatever it returns is a
direct fact about the database.

Two possibilities remain, and the repository cannot tell which:

- **(a)** migrations 0042–0069 *were* applied and the record was never updated; or
- **(b)** the schema really is at `0041`, in which case any deployed code that expects the
  0069 column is failing or silently falling back — which touches company attribution.

There is a second question layered on top: **two different migrations are numbered `0069`**
(`main`'s `0069_company_routing_and_catalogue_department.sql` and this line's
`0069_durable_inbound_processing.sql`), and the runner keys its ledger on the four-digit
prefix alone. The SQL below tells the two apart by the objects each creates.

### 1. Where to look

Supabase → your project → **SQL Editor** → New query. Paste and Run.

### 2. What is needed

The four result grids, as text or screenshots. Query 1 returns version numbers and filenames;
query 2 returns four integers; query 3 returns object names or nulls; query 4 returns three
values. **No customer or business records are read by any of them.**

### 3. Exact SELECT-only SQL

```sql
-- R0 / PR-F-004 — READ-ONLY. No DDL, no DML, no business data.

-- 1. The migration ledger, as the runner sees it
select version, filename, applied_at
from   schema_migrations
order  by version;

-- 2. WHICH 0069 is applied?  main's adds COLUMNS; this line's adds FUNCTIONS.
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='companies'
      and column_name='whatsapp_phone_number_id')             as main_0069_marker,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='companies'
      and column_name='default_price_confirmation_department') as main_0069_marker_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='claim_source_events')   as branch_0069_marker,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='complete_source_event') as branch_0069_marker_2;

-- 3. High-water marks either side of the disputed range
select
  to_regclass('public.channel_accounts')        as t_0074,
  to_regclass('public.management_cases')        as t_0028,
  to_regclass('public.currencies')              as t_0061,
  to_regclass('public.risks')                   as t_0093,
  to_regproc('public.enqueue_quotation_outbox') as f_0063,
  to_regproc('public.decide_approval')          as f_0046;

-- 4. Ledger summary
select count(*) as applied_count, min(version) as lowest, max(version) as highest
from   schema_migrations;
```

### 4. What to paste back

```
SUPABASE SCHEMA TRUTH
q1 ledger:     <paste rows, or "schema_migrations does not exist">
q2 markers:    main=<n> main2=<n> branch=<n> branch2=<n>
q3 high-water: <paste row>
q4 summary:    applied=<n> lowest=<n> highest=<n>
```

### 5. What it unblocks

**Everything downstream of a migration.** No migration may be applied to production while the
starting point is unknown. It gates R2 line reconciliation and whether any R1 work can ever be
hosted. It also selects the branch of the decision tree below.

### 6. Safety

**Read-only.** Do **not** run `npm run migrate`, click any migration or schema-change control,
or open Settings → Database. **Do not paste the connection string, the service-role key or the
anon key.**

---

## 🟡 Priority 3 — Meta callback destination — DEFERRED BY OWNER DECISION

**No action is requested, and none should be taken.** Meta has not been contacted and will not
be.

**Standing statement, unchanged:** **inbound WhatsApp is unverified.** The Vercel origin
`https://bot-business-singha.vercel.app` returns **`402 Payment Required`** with
`X-Vercel-Error: DEPLOYMENT_DISABLED` on **every** path, including `/api/webhooks/whatsapp`
(verified twice, across four paths). Decision D-021 records the Meta callback as still
pointing at Vercel.

**If that is still true, inbound customer messages are being delivered to a dead origin and
are failing** — and Meta stops retrying after a bounded period, so they are lost, not queued.
Railway is healthy and exposes the webhook route, but that is **not** evidence that Meta
targets it.

This gate stays open until the owner chooses to check it. Nothing else in the recovery plan
depends on it. When it is taken up: Meta App Dashboard → the app → **WhatsApp → Configuration**
→ the **Callback URL** field; only the **host** is needed, and **the verify token beside it
must never be shared**.

---

# Migration-reconciliation decision tree

**Planning only. No migration will be created, renumbered or applied on the strength of this
document.** Read `q2`'s markers from Priority 2.

```
                    ┌─────────────────────────────────────┐
                    │ q2: which 0069 markers are present? │
                    └──────────────┬──────────────────────┘
        ┌──────────────────┬───────┴────────┬────────────────────┐
        ▼                  ▼                ▼                    ▼
   main=1 branch=0    main=0 branch=1   main=0 branch=0     main=1 branch=1
   ── CASE A ──       ── CASE B ──      ── CASE C ──        ── CASE D ──
   LIKELY, UNPROVEN
```

## CASE A — `main_0069_marker = 1`, `branch_0069_marker = 0`

> **Assessed as the LIKELY case — but this is an inference, and its support has WEAKENED.**
>
> It originally rested on two things: D-021's statement that Railway deploys from `main`, and
> the live site serving `19a8e9d`'s corrected phone number. **R0-F-007 has removed the first**
> — the active deployment came from `railway up` via the CLI, with no commit id and no GitHub
> source, so "production is running `main`" is no longer supported. The second was only ever a
> statement about rendered content, and the owner has directed that public fingerprints not be
> used to infer the deployed revision.
>
> **Neither ever proved the database state, and one of the two is now gone.** Case A must not
> be assumed, planned against, or acted on until `q2` returns actual values. Every other case
> below remains live until then, and Case C in particular is now relatively more plausible
> than it was.

Production ran **main's 0069**; the record was merely stale.

**Recommended action.** Update `MIGRATION_STATE.md` to the real applied state, citing the
query output and a date. Then **renumber the entire branch line `0069–0109` upward** to begin
above production's high-water mark, preserving relative order, and preserving migrations
0063–0067 and their self-verifying assertions **verbatim**. Re-point the R1 draft units into
that reconciled sequence. Rehearse on a disposable database seeded **from production's actual
ledger**, never from empty.

**Risk.** Moderate and well-understood. This is the case the R2 plan already assumes.

## CASE B — `main_0069_marker = 0`, `branch_0069_marker = 1`

Production ran **this line's** 0069 — meaning the branch line, not `main`, reached the
database at some point.

**Recommended action.** **Stop and re-audit before anything else.** This contradicts D-021 and
the deployment record, and it means deployed `main` code is running **without** the column it
requires — an active inbound-routing defect. Renumber **main's** 0069 instead of this line's,
and treat inbound company attribution as an incident.

**Risk.** High. Do not proceed to R2 until the contradiction is explained.

## CASE C — both markers `0`

Neither 0069 is applied; production sits at an earlier point, which `q4`'s `highest` names.

**Recommended action.** That `highest` becomes the true baseline. Both 0069s are then
unapplied, so the collision resolves cleanly by renumbering the branch line above main's — no
live data depends on either yet. **But deployed `main` code still requires its 0069**, so
inbound routing is broken now, and main's 0069 must be applied first as its own
owner-approved step.

**Risk.** Moderate. Sequence matters: main's 0069 first, then reconciliation.

## CASE D — both markers `1`

Both lines' objects exist — the schemas were merged by hand, or migrations were run from two
branches.

**Recommended action.** **The most dangerous case; halt.** `schema_migrations` cannot be
trusted, because a single `0069` row is claiming to represent two different migrations. Do a
full object-level reconciliation of the live schema against both lines before touching
anything, and expect to rebuild the ledger by **baseline** rather than by replay.

**Risk.** High. R2 does not start until the schema is characterised object by object.

## In every case, unchanged

- The R1 draft units stay **quarantined** until a numbering decision is made and approved.
- **No migration is applied to production** without separate owner approval, a rehearsed
  rollback, and a staging run first.
- If query 1 reports **`schema_migrations` does not exist**, production was never migrated by
  the runner at all — treat as **Case C with no ledger**, and establish the baseline by object
  inspection rather than by trusting any recorded version.

---

## Summary

| Gate | Question | Where | Status | Blocks |
|---|---|---|---|---|
| **Priority 1** | Which commit is the active Railway deployment? | Railway → `singha-central` → `singha-web` → Deployments | **INSPECTED — no commit id exists (R0-F-007).** Recorded UNAVAILABLE / UNVERIFIED | The R1-F-001 hotfix decision; any R2 before/after baseline. **Not closable by inspection** |
| **Priority 2** | Which `0069` is applied, and what does the ledger say? | Supabase → SQL Editor | **OPEN — ~2 min** | **Every** future migration; R2; selects the decision-tree branch |
| **Priority 3** | Which host does Meta's webhook name? | *deferred by owner decision* | deferred | Whether inbound messaging works right now |

**Priority 2 is now the only gate answerable by reading a dashboard.** Priority 1 has been
answered in the only sense available — the answer is that the running deployment has no
identity — and Priority 3 is deferred by decision.
