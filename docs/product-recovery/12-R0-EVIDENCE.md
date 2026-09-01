# Phase R0 — Establish truth: evidence and findings

**Authorised scope:** R0 only, read-only. **Status: PARTIALLY COMPLETE — blocked on
credentials for three of five tasks.**
**Branch:** `claude/product-recovery-audit` · **Base:** `abc7767e` · **Date:** 2026-09-01/02

---

## ⚠️ URGENT — R0-F-001 (P0): the Vercel origin is DISABLED

This was not visible in the audit and changes the priority of D-1.

```
2026-09-01T14:21:48Z
https://bot-business-singha.vercel.app/   → HTTP 402  X-Vercel-Error: DEPLOYMENT_DISABLED
https://singha-web-production.up.railway.app/ → HTTP 200  Server: railway-hikari
```

Every Vercel path returns 402, including the webhook path:

| Path (Vercel) | Result |
|---|---|
| `/` | **402** `DEPLOYMENT_DISABLED` |
| `/login` | **402** |
| `/data-deletion` | **402** |
| `/api/webhooks/whatsapp` | **402** |

`DEPLOYMENT_DISABLED` with `402 Payment Required` is Vercel's account/billing-level
disable, not an application error. Confirmed across four paths and two separate probe
rounds.

### Why this is urgent

Decision record **D-021 states that the Meta WhatsApp webhook still points at Vercel**
("Railway live and health-green; webhook still pointed at Vercel pending owner
repoint"). **If that is still true, inbound customer WhatsApp messages are currently
being delivered to a dead origin and are failing.** Meta retries webhook deliveries only
for a bounded period and then stops, so this class of failure loses messages
permanently.

### What is proven, and what is not

| Claim | Status |
|---|---|
| The Vercel origin `bot-business-singha.vercel.app` is disabled and serves 402 on every path | **PROVEN** by direct probe |
| The Railway origin is healthy and correctly configured | **PROVEN** (see R0-2) |
| Meta's webhook currently points at Vercel | **NOT PROVEN** — asserted by D-021 on 2026-09-01; requires Meta console access |
| Inbound messages are currently failing | **CONDITIONAL** — true if and only if the webhook still points at Vercel |

It is entirely possible the owner has already repointed the webhook, or that Meta is
configured against a different Vercel alias or custom domain that this probe did not
test. **Only the Meta App Dashboard can settle it.**

### Action required — owner, immediately

1. Open Meta App Dashboard → WhatsApp → Configuration → **Webhook callback URL**.
2. If it names **any `*.vercel.app` origin**, inbound messaging is down now.
3. Per **D-1**, repointing is an owner-approved production operation and **has not been
   performed**. The prepared change window and rollback are in
   [§R0-5](#r0-5--prepared-webhook-change-not-executed) below, ready for approval.

**No webhook, configuration, deployment or Meta change was made.** D-1 prohibits it.

---

## R0-1 — Hosted migration state: **BLOCKED, not established**

**This is the task R0 exists for, and it could not be completed.**

No database credentials exist in this environment. Verified by presence check only —
**no value was read, printed or stored**:

| Variable | Present? |
|---|---|
| `DATABASE_URL` | not set |
| `SUPABASE_DB_URL` | not set |
| `NEXT_PUBLIC_SUPABASE_URL` | not set |
| `SUPABASE_SERVICE_ROLE_KEY` | not set |
| `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | not set |
| `RAILWAY_TOKEN` / `RAILWAY_API_TOKEN` | not set |
| `CRON_SECRET` | not set |

Only `.env.example` exists in the repository (a template; no secrets). `scripts/migrate.mjs`
reads `process.env.DATABASE_URL` and loads no dotenv file, so `npm run migrate:status`
**cannot run here**:

```
$ npm run migrate:status
DATABASE_URL is required
```

The `claude.ai Supabase` connector is present but **unauthenticated**, and this is a
non-interactive session, so the OAuth flow cannot be completed here. Authorising it in
claude.ai connector settings would unblock this task.

**PR-F-004 therefore remains UNRESOLVED.** The production starting point is unknown, and
per the R0 banner now in `MIGRATION_STATE.md`, **no migration may be applied to
production** until it is known.

### Exact commands for the owner or operator (read-only)

Run against the **production** database and paste the output back.

```bash
# Option A — the repository's own status command (read-only; exits 1 if drift)
DATABASE_URL='<production connection string>' npm run migrate:status
```

```sql
-- Option B — SELECT-only, safe to run in the Supabase SQL editor

-- B1. The migration ledger: what the runner believes is applied
select version, filename, applied_at
from schema_migrations
order by version;

-- B2. THE DECISIVE QUERY for PR-F-004.
--     Does the column that deployed main code depends on actually exist?
select count(*) as has_whatsapp_phone_number_id
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'companies'
  and column_name  = 'whatsapp_phone_number_id';

-- B3. Cross-check a few objects from the disputed 0042-0069 range
select to_regclass('public.channel_accounts')      as channel_accounts_0074,
       to_regclass('public.management_cases')      as management_cases_0028,
       to_regclass('public.currencies')            as currencies_0061,
       to_regproc('public.enqueue_quotation_outbox') as enqueue_rpc_0063;
```

**Interpreting B2 — this is the whole point of R0:**

| Result | Meaning | Consequence |
|---|---|---|
| `1` | Production **is** at 0069. `MIGRATION_STATE.md` was merely stale | Best case. Record the real state; R2 planning proceeds from a known baseline |
| `0` | Deployed code is running **ahead of its schema** | Inbound company resolution is failing or falling back. **Investigate immediately** — this touches company attribution, which `CLAUDE.md` classifies as a critical failure class |

---

## R0-2 — Deployed Railway SHA: **BOUNDED, not exact**

No Railway API token exists here, so the dashboard could not be read. The application
exposes no build SHA (PR-F-014), so the revision cannot be read from the running app
either.

**However, a public discriminator was found and used**, giving a genuine lower bound.

Commit `19a8e9d` ("fix: correct the WhatsApp number shown on the public legal pages")
changed `src/app/legal-config.ts`, altering a value rendered on the **public**
`/privacy`, `/terms` and `/data-deletion` pages:

| Revision | `whatsappNumber` |
|---|---|
| before `19a8e9d` (and on this audit branch) | `+94 76 096 3935` |
| `19a8e9d` and later on `main` | `+94 70 113 5556` |

Probe result:

```
GET https://singha-web-production.up.railway.app/data-deletion → 200
rendered number: +94 70 113 5556
```

**Therefore the deployed revision includes `19a8e9d` or later.** `19a8e9d` is the
second-newest commit on `main`; combined with D-021 (Railway auto-deploys from `main`),
the deployed SHA is **almost certainly `acd9fbe`** — but `acd9fbe` ("normalise item
descriptions to catalogue names") changes nothing publicly observable, so the final
commit cannot be discriminated from outside.

**Conclusion:** deployed revision **≥ `19a8e9d`**, consistent with `acd9fbe`. Exact
confirmation needs the Railway dashboard (Deployments → the active deployment's commit)
— an owner action of about ten seconds.

**Also confirmed by this probe:** the branch line still carries the **wrong, uncorrected
WhatsApp number** in `legal-config.ts`. That is a fifth main-only production fix the
branch lacks, adding to PR-F-002. Publishing the branch as-is would put a stranger's
phone number back onto the public data-deletion page — the exact defect `19a8e9d` fixed.
**Added to the R2 port list.**

## R0-3 — Railway origin health: **CONFIRMED HEALTHY**

| Check | Result |
|---|---|
| `/` `/login` `/privacy` `/terms` `/data-deletion` | **200** |
| `/app` unauthenticated | **307 → `/login?next=%2Fapp`** (fails closed) |
| `/api/webhooks/whatsapp` GET without verification params | **403 `forbidden`** (correctly rejects) |
| `/api/health` unauthenticated | **`unauthorized`** (correctly gated) |
| Security headers | HSTS w/ preload, restrictive CSP, `X-Frame-Options: DENY`, `nosniff`, strict referrer, permissions policy denying camera/mic/geolocation |
| Edge | `x-railway-edge: sin1` (Singapore) |

The Railway deployment is correctly configured and ready to receive the webhook.

## R0-4 — Webhook destination: **NOT ESTABLISHED**

Requires Meta App Dashboard or Graph API access with the app token. No WhatsApp
credentials are configured here, and D-3 prohibits configuration changes.

The repository's only record is **D-021**, dated 2026-09-01: *"webhook still pointed at
Vercel pending owner repoint."* Given R0-F-001, confirming this is now urgent rather
than routine.

<a id="r0-5--prepared-webhook-change-not-executed"></a>
## R0-5 — Prepared webhook change (NOT executed)

Prepared per D-1, which requires staging verification and a final owner approval
immediately before the change. **Nothing here has been performed.** It is recorded now
because R0-F-001 may make it urgent.

**Target:** `https://singha-web-production.up.railway.app/api/webhooks/whatsapp`

**Preconditions (all must hold before the change):**

1. R0-1 resolved — production migration state known.
2. `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`,
   `WHATSAPP_PHONE_NUMBER_ID` confirmed present and correct on Railway.
3. `CRON_SECRET` set on Railway and `IN_PROCESS_CRON=on` (else the outbox drain still
   will not run — the defect this move exists to fix).
4. Verified in **staging** first (D-1) — currently blocked, staging does not exist (D-3).

**Change window:** any low-traffic window; the operation itself is a single field edit
and takes effect immediately.

**Procedure:**

1. Record the current callback URL verbatim (this is the rollback value).
2. Meta App Dashboard → WhatsApp → Configuration → Webhook → Edit callback URL to the
   target above; verify token unchanged.
3. Meta sends a `GET` verification challenge; it must return the `hub.challenge` echo.
4. Confirm subscribed fields still include `messages`.
5. Send one test message from a known number.
6. Verify within 2 minutes: a `wa_messages` inbound row exists; a `message_outbox` row
   reaches `sent`; `/api/health` reports no outbox failures.

**Rollback:** restore the recorded previous callback URL. Reversible in seconds, no data
migration, no schema change.

⚠️ **Caveat:** if the previous URL is the **disabled Vercel origin**, rolling back
restores a broken state. In that case rollback is *forward* — fix Railway, do not
revert.

**This step is STOPPED pending owner approval (D-1).**

## R0-6 — Documentation corrections: **COMPLETE**

| File | Correction |
|---|---|
| `docs/architecture-v2/MIGRATION_STATE.md` | Added an R0 correction banner (the record-vs-deployed-code contradiction; the `0069` collision and its silent-skip mechanism; the previously-missing range). Corrected the canonical-migration range `0001–0068` → `0001–0109` and documented that **two lines exist** with colliding 0069s, which `migration-lint` cannot detect. **Added per-migration state rows for all 41 migrations 0069–0109**, each recorded as *owner confirmation required* — closes **PR-F-011**. |
| `CLAUDE.md` | Active phase corrected to **Product Recovery R0 only**, with the owner's standing constraints inlined. Corrected the false claim that 0048–0067 are "NOT merged, NOT deployed" (they are on `main` and deployed). Corrected the stale test counts (`unit 419 / 79 files` → measured **1362 passed / 1 failed / 2 skipped, 184 files**) and marked counts advisory. Closes **PR-F-015**. |
| `docs/product-recovery/13-OWNER-DECISIONS-RECORD.md` | New — the authoritative record of D-1…D-10, the amendments, the R0 permission boundary, and the two audit recommendations the owner superseded. |

**No application code, test, script, migration or configuration file was modified.**

---

## R0-7 — Permitted non-mutating verification

`npm run verify` was run on this branch. Results, in chain order:

| Step | Result |
|---|---|
| `secret-scan` | ✅ no tracked secrets found |
| `migration-lint` | ✅ 109 migrations, sequential 0001–0109, no gaps or duplicates |
| `completion-inventory --check` | ✅ `supabaseAdmin` usage confined to the system allowlist |
| `autonomy:audit --quiet` | ❌ **FAILED** — see R0-F-005 |
| `check-ip-boundary --quiet` | ✅ PASS (run separately; the chain had aborted) |
| `typecheck` | ✅ clean (run separately) |
| `test` | ⚠️ 1362 passed / **1 failed** / 2 skipped, 184 files — PR-F-013 (run separately) |

Two independent corroborations came out of this, both from the repository's own tooling:

**1. `migration-lint` passes — and that is the point.** It reports "sequential 0001–0109,
no gaps or duplicates" while the `0069` collision (PR-F-001) sits in plain view. The lint
checks numeric sequence *within one checkout*; it structurally cannot see a second line.
A green `migration-lint` is therefore **not** evidence that migrations are safe to apply.

**2. `completion-inventory` independently confirms PR-F-010:** it reports
`flags-no-consumer=7/8` — seven of eight feature flags have no consumer in runtime code.
This was derived in the audit by call-graph search; the repository's own inventory agrees.

`verify` also regenerates two documents (`ORIGINAL_VISION_COVERAGE_MATRIX.md`,
`COMPLETION_INVENTORY.md`). The regenerated diffs were pure noise — a date stamp and two
shifted line numbers — and were **reverted** to keep the R0 change set confined to
authorised edits.

## R0 findings

| ID | Sev | Finding | Status |
|---|---|---|---|
| **R0-F-001** | **P0** | The Vercel origin is `DEPLOYMENT_DISABLED` (402 on every path, including the webhook). If Meta still points there per D-021, **inbound customer messaging is down and messages are being lost.** | **OPEN — urgent owner action** |
| **R0-F-002** | **P0** | Production migration state could not be established: no credentials in this environment; the Supabase connector is unauthenticated and cannot be authorised non-interactively. PR-F-004 unresolved; **no migration may be applied to production.** | **OPEN — blocked on owner** |
| **R0-F-003** | **P1** | The branch line still carries the **wrong public WhatsApp number** (`+94 76 096 3935`) that `main` corrected in `19a8e9d`. A fifth main-only fix the branch would regress. | Added to the R2 port list |
| **R0-F-004** | **P2** | Deployed SHA bounded to **≥ `19a8e9d`** by public-page fingerprint, consistent with `acd9fbe`; exact confirmation needs the Railway dashboard. | Bounded; PR-F-014 stands |
| **R0-F-005** | **P1** | **`npm run verify` FAILS on the approved baseline.** `autonomy:audit` rejects requirement **IP-001**: its `last_verified_sha` `c72b2fe` **is not a commit in this repository** (`git cat-file -t c72b2fe` → *not a valid object name*). The register's own evidence rule — a completion status requires a verified SHA — is therefore violated by a record currently marked `locally_verified`. Pre-existing; not introduced by this work. | **OPEN** |
| **R0-F-006** | **P2** | `migration-lint` reports "109 migrations, sequential, no gaps or duplicates" while the cross-line `0069` collision exists. The lint validates one checkout and **cannot detect the collision** — a green result must not be read as "safe to apply". | Recorded; hardening deferred to R1 |

## R0 completion status

| Task | Status |
|---|---|
| Establish the real hosted migration state | ❌ **BLOCKED** — no credentials (R0-F-002) |
| Confirm the deployed Railway SHA | ⚠️ **BOUNDED** — `≥ 19a8e9d`; exact needs dashboard |
| Confirm the production Meta webhook destination | ❌ **BLOCKED** — no Meta access |
| Correct the migration-state record | ✅ **COMPLETE** |
| Correct stale repository documentation | ✅ **COMPLETE** |
| Produce evidence and findings | ✅ **COMPLETE** (this document) |

**R0 cannot be closed by an agent.** Its three blocked tasks are all owner actions. What
R0 did deliver: the documentation is now truthful, the `0069` collision is recorded where
an operator will see it before running migrations, and an **undetected production outage
was found.**

## What is needed to close R0

1. **Check the Meta webhook URL now** (R0-F-001) — minutes, potentially stopping message loss.
2. **Run the R0-1 queries** against production and paste the output — resolves PR-F-004.
3. **Confirm the deployed SHA** from the Railway dashboard.

With those three, R0 closes and — subject to the independent Codex review required by
safeguard 6 — R1 can be scoped.

**Deliberately left for review, not fixed here:** R0-F-005. Correcting IP-001 means
either supplying the real verification SHA or downgrading a `locally_verified` status.
Both are judgements about the requirement register's contents, and under safeguard 8
("every verified capability requires … an exact SHA") the honest options differ in
consequence. It is flagged rather than quietly patched, so the reviewer decides.

**Stopping here for owner and Codex review, as instructed.**
