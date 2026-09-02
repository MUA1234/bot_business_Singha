# R0 owner-gate checklist — three unresolved hosted truth gaps

**Read-only. No hosted service was contacted to produce this.** Each item below is a fact
this repository cannot establish about itself, with the shortest path to the answer.

Nothing here needs a secret to be shared. Where a value is requested it is non-sensitive:
a column name, a commit id, a URL. **Do not paste connection strings, service-role keys,
access tokens or `.env` contents into any reply** — none of them is needed.

---

## ☐ PR-F-004 — What migration state is the production database actually in?

**The unknown fact.** `docs/architecture-v2/MIGRATION_STATE.md` — which declares itself the
authoritative record — states that nothing after migration `0041` was applied to a hosted
database. But the deployed `main` code **requires migration 0069**:
`src/lib/whatsapp-inbound.ts` resolves the inbound company from
`companies.whatsapp_phone_number_id`, a column only that migration creates.

Exactly one of these is true, and the repository cannot tell which:

- **(a)** migrations 0042–0069 *were* applied and the record was never updated — most likely; or
- **(b)** live code is running **ahead of its schema**, in which case inbound company
  resolution is failing or silently falling back, which touches company attribution.

**Where to retrieve it.** Supabase dashboard → your project → **SQL Editor**. Run either.

```sql
-- The decisive question: does the column the deployed code depends on exist?
select count(*) as has_column
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'companies'
  and column_name  = 'whatsapp_phone_number_id';

-- And the full picture:
select version, filename, applied_at
from schema_migrations
order by version;
```

**What is needed back.** Two non-secret things: the number `0` or `1` from the first query,
and either a screenshot of the second query's result or its `version` column pasted as text.
No credentials, no data rows.

**What it blocks.** Everything downstream of a migration. **No migration may be applied to
production until this is answered**, because the starting point is unknown. It gates R2 line
reconciliation, and it gates whether any R1 work can ever be hosted.

**How to read the answer.** `1` → the record was merely stale; update it and proceed.
`0` → deployed code is ahead of its schema; treat as an incident and inspect inbound company
attribution before anything else.

---

## ☐ PR-F-014 — Which commit is actually running on Railway?

**The unknown fact.** The deployed revision cannot be confirmed from outside: the running
application exposes no commit identifier, and `/api/health` is authenticated. The audit
bounded it to **≥ `19a8e9d`** by a public-page fingerprint (commit `19a8e9d` corrected the
WhatsApp number shown on the legal pages, and the live site serves the corrected value), and
D-021 records that Railway auto-deploys from `main` — so it is *probably* `acd9fbe`. That is
an inference, not a fact, and it is not good enough to plan a migration against.

**Where to retrieve it.** Railway dashboard → project **`singha-central`** → service
**`singha-web`** → **Deployments**. The active deployment shows the commit it was built from.

**What is needed back.** The short commit SHA of the **active** deployment (7–10 characters),
and its deploy timestamp. Both are non-secret. A screenshot of the deployments list is fine.

**What it blocks.** Knowing which fixes are actually live. It gates the R1-F-001 hotfix
decision — you cannot judge whether the escalation-fallback defect is live without knowing
what is deployed — and it gates any before/after comparison during R2.

**Worth fixing permanently.** One line exposing the build SHA on `/api/health` would remove
this question for good. Recommended, not yet done, because it is a production-facing change.

---

## ☐ R0-F-001 — Where does Meta's WhatsApp webhook actually point?

**The unknown fact — and the most urgent.** The Vercel origin
`https://bot-business-singha.vercel.app` returns **`402 Payment Required`** with
`X-Vercel-Error: DEPLOYMENT_DISABLED` on **every** path, including
`/api/webhooks/whatsapp`. Verified twice, across four paths. The Railway origin is healthy.

Decision **D-021** records that the Meta webhook still points at **Vercel**. If that is still
true, **inbound customer WhatsApp messages are being delivered to a dead origin and are
failing** — and Meta stops retrying after a bounded period, so they are lost, not queued.

This repository cannot verify where Meta points. It is entirely possible the webhook was
already repointed, or that Meta targets a different Vercel alias or a custom domain that the
probe did not test.

**Where to retrieve it.** Meta App Dashboard → your app → **WhatsApp → Configuration** →
the **Callback URL** field.

**What is needed back.** Just the **host** of that URL — for example
`singha-web-production.up.railway.app` or `bot-business-singha.vercel.app`. **Do not share
the verify token**, which sits beside it on that screen and is a secret.

**What it blocks.** Whether inbound messaging is working at all right now. It also gates
D-1's webhook repoint, which is prepared with a change window and rollback in
[12-R0-EVIDENCE.md §R0-5](12-R0-EVIDENCE.md) and **stopped pending your approval**.

**How to read the answer.** Any `*.vercel.app` host → inbound is down now; treat as an
incident. The Railway host → the move already happened and R0-F-001 closes.

---

## Summary

| Gate | Question | Where | Time | Blocks |
|---|---|---|---|---|
| **R0-F-001** | Which host does Meta's webhook name? | Meta App Dashboard → WhatsApp → Configuration | ~1 min | Whether inbound messaging works **right now** |
| **PR-F-004** | Does `companies.whatsapp_phone_number_id` exist? | Supabase → SQL Editor | ~2 min | **Every** future migration; R2 |
| **PR-F-014** | Which commit is the active Railway deployment? | Railway → `singha-central` → `singha-web` → Deployments | ~1 min | Knowing what is live; the R1-F-001 hotfix decision |

Roughly five minutes of dashboard reading closes all three, and they gate more downstream
work than anything else outstanding.
