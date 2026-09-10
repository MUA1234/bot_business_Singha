# Railway / deployment evidence checklist

**For the owner to fill in from the Railway dashboard.** Read-only inspection; nothing
here asks for a configuration change.

## Never provide secret values

Every question below asks for **names, presence, and non-secret settings only**.

* **Do not** paste the value of any variable — not `SUPABASE_SERVICE_ROLE_KEY`,
  `DATABASE_URL`, `CRON_SECRET`, `WHATSAPP_TOKEN`, `META_APP_SECRET`, `OPENAI_API_KEY`,
  or anything else.
* Where a variable's *value* matters, the question asks only whether it is **set**, or
  what its value is **among a fixed set of non-secret options** (for example
  `IN_PROCESS_CRON` is either `on` or not `on`).
* If a screenshot is easier, **mask every value column** before sharing it.

If any answer would require revealing a secret, write "withheld — secret" and move on.
None of the numbering or merge decisions depend on a secret value.

---

## R1 — Deployed source type and provenance

This is finding **PR-F-014 / R0-F-007**, escalated: the active deployment was reportedly
made by `railway up` from the CLI, with no Git SHA and no GitHub source. If true, the
running artifact may correspond to **no commit at all**.

| # | Question | Answer |
|---|---|---|
| R1.1 | Service name (expected `singha-web`) | |
| R1.2 | Deployment **source type**: GitHub repo, CLI (`railway up`), Docker image, or template? | |
| R1.3 | If GitHub: the connected **repository** and **branch** | |
| R1.4 | If GitHub: is **auto-deploy on push** enabled? | |
| R1.5 | The **commit SHA** shown for the currently active deployment (full 40 characters if available) | |
| R1.6 | The active deployment's **creation timestamp** and **who/what triggered it** | |
| R1.7 | Does the deployment detail page show a commit message / author, or only "deployed via CLI"? | |
| R1.8 | How many deployments are in the history, and is the most recent one the active one? | |

**Where to look.** Railway → project → service → *Deployments*; open the active deployment
and read its header and *Source* section. The service's *Settings → Source* shows the
configured source.

### If no SHA is recoverable

Say so explicitly. That is a finding, not a gap to be filled by guessing. It means the
deployed revision is **unavailable, not merely unconfirmed** — it cannot be reproduced or
audited from git, and no claim about "what is deployed" can rest on it. The remedy is a
fresh, provenance-carrying deployment from a known commit, which is a production boundary
requiring separate approval.

---

## R2 — Build and start configuration

| # | Question | Answer |
|---|---|---|
| R2.1 | **Build command** (or "Nixpacks default" / "Dockerfile") | |
| R2.2 | **Start command** | |
| R2.3 | Builder: Nixpacks, Dockerfile, or Buildpacks? | |
| R2.4 | Node version pinned by the build (the repo requires `>=20`) | |
| R2.5 | Root directory setting, if not the repository root | |
| R2.6 | Health-check path and timeout, if configured | |
| R2.7 | Number of **replicas / instances** for this service | |

**Why R2.7 matters.** The in-process scheduler starts once per process. Two replicas mean
two schedulers. The jobs it drives are concurrency-safe at the database level
(`claim_outbox_batch` leases with `FOR UPDATE SKIP LOCKED`), so a second instance cannot
double-send — but it does double the tick rate and the model spend on `ai-monitor`.
Record the real number.

There is **no Railway configuration file in the repository** (no `railway.json`,
`railway.toml`, `nixpacks.toml`, `Procfile` or `Dockerfile`). Every build and start
setting therefore lives only in the Railway dashboard and is invisible to this repository —
which is itself part of the provenance problem.

---

## R3 — Scheduler: is exactly one running?

Owner decisions 1 and 2: Railway is the single application/scheduler host, and Vercel cron
must not coexist with the Railway scheduler.

| # | Question | Answer |
|---|---|---|
| R3.1 | Is the variable `IN_PROCESS_CRON` **set**, and is its value exactly `on`? (the value is not a secret) | |
| R3.2 | Is `CRON_SECRET` **set**? (presence only — do not paste it) | |
| R3.3 | Do the service logs contain `cron.scheduler_disabled`, or lines showing scheduled ticks? | |
| R3.4 | Are there any **Railway cron services / scheduled jobs** configured in this project, separate from the web service? | |
| R3.5 | Any other Railway service in the project that could call `/api/cron/*`? | |

**How to read R3.1/R3.3.** `src/lib/scheduler.ts` starts only when `IN_PROCESS_CRON=on`
**and** `CRON_SECRET` is set; otherwise it logs `cron.scheduler_disabled` with a reason
and starts nothing. So:

* `IN_PROCESS_CRON` unset or not `on` → **no scheduler is running on Railway**, and the
  outbox drain (the only recovery path for a failed customer message) runs only if
  something external calls it.
* `IN_PROCESS_CRON=on` with `CRON_SECRET` set → the scheduler is running the four jobs in
  `DEFAULT_JOBS` (`outbox` 1 min, `follow-ups` 15 min, `ai-monitor` 1 h, `daily-digest` 24 h).

---

## R4 — Any other scheduler invoking the same jobs

The repository contains cron route handlers that more than one platform could call. This
is where a double-run would come from.

| # | Question | Answer |
|---|---|---|
| R4.1 | Is the **Vercel project still connected** to this repository, and is it enabled or disabled? | |
| R4.2 | If enabled: which cron schedules does the Vercel dashboard show as active? | |
| R4.3 | Has any **Vercel deployment protection / billing disable** been lifted since 2026-09-01? | |
| R4.4 | Any **external** scheduler pointed at `/api/cron/*` — GitHub Actions, cron-job.org, Inngest, UptimeRobot, an EasyCron job, a personal crontab? | |
| R4.5 | Any **Supabase** scheduled function / `pg_cron` job calling into the app or database? | |

### What the repository declares today

`vercel.json` on the **recovery branch** declares three cron schedules:

| Path | Schedule |
|---|---|
| `/api/cron/heartbeat` | `0 7 * * *` |
| `/api/cron/inbound-sweeper` | `*/10 * * * *` |
| `/api/cron/dispatch-drain` | `*/5 * * * *` |

`vercel.json` on **`main`** declares only one (`heartbeat`, daily) — because `main` moved
scheduling into the Railway in-process scheduler instead.

**This is a live conflict with owner decisions 1 and 2**, and it cuts both ways:

* If Vercel were re-enabled while Railway's scheduler is on, `heartbeat` would double-run.
* The branch's two new jobs (`inbound-sweeper`, `dispatch-drain`) are declared **only** as
  Vercel crons and are **not** in `main`'s `DEFAULT_JOBS`. So if the branch were deployed
  to Railway as it stands, with Vercel disabled, **nothing would drive them at all** — the
  durable inbound processing that the branch's 0069 exists to provide would never run.

Both facts are recorded as dispositions in
[`05-MAIN-REGRESSION-RECONCILIATION.md`](05-MAIN-REGRESSION-RECONCILIATION.md).

---

## R5 — Webhook destination (the P0 from R0-F-001)

| # | Question | Answer |
|---|---|---|
| R5.1 | Meta App Dashboard → WhatsApp → Configuration → **Webhook callback URL** (the URL, which is not a secret) | |
| R5.2 | Does it name a `*.vercel.app` origin, the Railway origin, or a custom domain? | |
| R5.3 | If a custom domain: which service does its DNS currently resolve to? | |
| R5.4 | Webhook **subscribed fields** (e.g. `messages`) | |
| R5.5 | Any recent **delivery failures / retry warnings** shown by Meta? | |

**Why this is urgent.** As probed on 2026-09-01, every Vercel path returned HTTP 402
`DEPLOYMENT_DISABLED`, including `/api/webhooks/whatsapp`. If Meta still points there,
inbound customer messages are being delivered to a dead origin, and Meta stops retrying
after a bounded period — those messages are lost permanently.

Repointing the webhook is a **production boundary** and requires separate owner approval.
This checklist only establishes where it points.

---

## R6 — Environment variable inventory (names and presence only)

List **which of these are set** on the Railway service. Presence only — no values.

| Variable | Set? | Notes |
|---|---|---|
| `DATABASE_URL` | | value withheld |
| `NEXT_PUBLIC_SUPABASE_URL` | | non-secret, but not needed here |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | | value withheld |
| `SUPABASE_SERVICE_ROLE_KEY` | | value withheld |
| `CRON_SECRET` | | value withheld |
| `IN_PROCESS_CRON` | | **report the value** — `on` or otherwise (non-secret) |
| `RLS_READS` | | **report the value** — `on` or otherwise (non-secret) |
| `RLS_WRITES` | | **report the value** — `on` or otherwise (non-secret) |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | | values withheld |
| `META_APP_SECRET` / `META_VERIFY_TOKEN` | | values withheld |
| `OPENAI_API_KEY` | | value withheld — **and see below** |
| Any `V3_1_*` flag | | **report names and values** (all should be absent or not `on`) |

**On `OPENAI_API_KEY`.** No paid model calls are authorised during R0–R3. If this is set
and the `ai-monitor` job is running hourly, model spend is being incurred. Report whether
the key is set and whether `IN_PROCESS_CRON` is `on`; that combination is the thing to
check, not the key itself.

**On `RLS_READS` / `RLS_WRITES`.** Both default off, and the application currently reads
and writes through the service-role client (PR-F-012). Confirming they are off establishes
the baseline that owner decision 5 requires before the staging proof.

---

## What is settled once these come back

| Question | Settled by |
|---|---|
| Can the deployed revision be identified at all? | R1.5, R1.7 |
| Is the deployment reproducible from git? | R1.2, R1.3, R1.5 |
| Is exactly one scheduler running? | R3.1, R3.4, R4.1, R4.2, R4.4, R4.5 |
| Would the branch's new jobs run on Railway? | R3.1 plus the `DEFAULT_JOBS` gap above |
| Is inbound messaging currently reaching a live origin? | R5.1, R5.2 |
| Is unauthorised model spend occurring? | R3.1 + R6 `OPENAI_API_KEY` |
| What is the RLS runtime baseline? | R6 `RLS_READS` / `RLS_WRITES` |
