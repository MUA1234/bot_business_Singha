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
| Railway active deployment SHA | **1** | open |
| Hosted Supabase migration/schema truth | **2** | open |
| Meta callback destination | 3 | **deferred by owner decision** |

Roughly two minutes in Railway and two in Supabase closes Priorities 1 and 2. They gate more
downstream work than anything else outstanding.

---

## 🔴 Priority 1 — Exact Railway deployment SHA

### The unknown fact

The deployed revision cannot be confirmed from outside: the running application exposes no
commit identifier, and `/api/health` is authenticated. The audit bounded it to **≥ `19a8e9d`**
by a public-page fingerprint (commit `19a8e9d` corrected the WhatsApp number shown on the
legal pages, and the live site serves the corrected value), and D-021 records that Railway
auto-deploys from `main` — so it is *probably* `acd9fbe`. **That is an inference, not a fact**,
and it is not sufficient to plan a migration against.

### 1. Where to look

Railway → project **`singha-central`** → service **`singha-web`** → **Deployments** tab.
The top entry marked **Active** is the running one. Click it: the commit SHA and message
appear in the deployment header, and the **Source** row shows `main @ <sha>`.

### 2. What is needed

- the **short commit SHA** of the *Active* deployment (7–10 hex characters, e.g. `acd9fbe`);
- its **deploy timestamp**;
- optionally a screenshot of the Deployments list — **crop out any Variables or Settings panel**.

### 3. SQL

Not applicable.

### 4. What to paste back

```
RAILWAY ACTIVE DEPLOYMENT
sha:      <short sha>
deployed: <date/time>
```

### 5. What it unblocks

Which fixes are actually live. It gates the **R1-F-001 production hotfix decision** — whether
the escalation-fallback defect is running in production cannot be judged without knowing the
deployed commit — and any before/after comparison during R2.

### 6. Safety

**Read-only.** Do **not** click Redeploy, Restart or Rollback, and do not open the Variables
tab. **Do not paste any environment variable value.**

---

## 🔴 Priority 2 — Hosted Supabase migration and schema truth

### The unknown fact

`docs/architecture-v2/MIGRATION_STATE.md` — which declares itself the authoritative record —
states that nothing after migration `0041` was applied to a hosted database. But the deployed
`main` code **requires migration 0069**: `src/lib/whatsapp-inbound.ts` resolves the inbound
company from `companies.whatsapp_phone_number_id`, a column only that migration creates.

Exactly one of these is true, and the repository cannot tell which:

- **(a)** migrations 0042–0069 *were* applied and the record was never updated; or
- **(b)** live code is running **ahead of its schema**, in which case inbound company
  resolution is failing or silently falling back — which touches company attribution.

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

> **Assessed as the LIKELY case — but this is an inference, not a finding.** It rests on
> D-021 (Railway deploys from `main`) and on the live site serving `19a8e9d`'s corrected
> phone number. **Neither proves the database state.** Case A must not be assumed, planned
> against, or acted on until `q2` returns actual values. Every other case below remains live
> until then.

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

| Gate | Question | Where | Time | Blocks |
|---|---|---|---|---|
| **Priority 1** | Which commit is the active Railway deployment? | Railway → `singha-central` → `singha-web` → Deployments | ~1 min | Knowing what is live; the R1-F-001 hotfix decision |
| **Priority 2** | Which `0069` is applied, and what does the ledger say? | Supabase → SQL Editor | ~2 min | **Every** future migration; R2; selects the decision-tree branch |
| **Priority 3** | Which host does Meta's webhook name? | *deferred by owner decision* | — | Whether inbound messaging works right now |
