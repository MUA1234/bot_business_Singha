# Configuration guide — activating the Interim AI Finance System

This is the "you configure, I told you what" hand-off. The code is built and tested
up to the webhook integration boundary. Below is everything **you** do to bring it
online, in order. Each step says exactly what to paste where.

> Nothing here costs money on the free tiers: Supabase (free), Vercel (hobby),
> Inngest (free), Meta WhatsApp Cloud API (free to receive; templated sends metered
> but generous). OpenAI is the only pay-as-you-go item — set a spend cap (step 4).

---

## 0. Prerequisites (2 min)

```bash
node -v            # need ≥ 20 (you have v24 — good)
cd /Users/mua/Documents/GitHub/bot_business_Singha
npm install        # already run; re-run if node_modules is missing
npm test           # sanity: should print "66 passed"
```

Copy the env template — you'll fill it in as you go:

```bash
cp .env.example .env.local
```

---

## 1. Supabase project + database (10 min)

1. Create a project at <https://supabase.com/dashboard> (free tier). Region: pick the
   one closest to your users.
2. In the project: **Project Settings → API**, copy:
   - `Project URL`  → `.env.local` as `NEXT_PUBLIC_SUPABASE_URL` **and** `SUPABASE_URL`
   - `anon public`  → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` (secret) → `SUPABASE_SERVICE_ROLE_KEY` *(server-only; never in the browser)*
3. Run the migrations, in order, in **SQL Editor** (paste each file's contents and Run):
   ```
   src/db/migrations/0001_org_and_access.sql
   src/db/migrations/0002_accounting_core.sql
   src/db/migrations/0003_subledgers.sql
   src/db/migrations/0004_intelligence_and_evidence.sql
   src/db/migrations/0005_banking_and_planning.sql
   src/db/migrations/0006_approval_policies.sql
   ```
   (Or use the Supabase CLI: `supabase db push` after `supabase link`.)
4. **Seed your pilot company** — the owner decisions from guide §18. Minimum to start:
   ```sql
   insert into companies (id, name, base_currency, country)
     values (gen_random_uuid(), 'Singha Holdings (Pilot)', 'LKR', 'LK')
     returning id;   -- note this company_id

   -- give yourself owner access (use your auth user id from Authentication → Users)
   insert into users (id, email, full_name) values ('<your-auth-uid>', 'lakanthi7@gmail.com', 'Owner');
   insert into user_company_access (user_id, company_id, role_key)
     values ('<your-auth-uid>', '<company_id>', 'owner_management');

   -- a minimal chart of accounts (expand later)
   insert into chart_of_accounts (company_id, code, name, type) values
     ('<company_id>','1100','Bank','asset'),
     ('<company_id>','1000','Cash','asset'),
     ('<company_id>','2100','Reimbursements Payable','liability'),
     ('<company_id>','3000','Owner Equity','equity'),
     ('<company_id>','4000','Sales','income'),
     ('<company_id>','5000','General Expense','expense');

   -- one open period so posting is allowed
   insert into fiscal_years (id, company_id, name, start_date, end_date)
     values (gen_random_uuid(), '<company_id>', 'FY2026', '2026-01-01', '2026-12-31') returning id;
   insert into accounting_periods (company_id, fiscal_year_id, name, start_date, end_date, status)
     values ('<company_id>', '<fiscal_year_id>', 'Open', '2026-01-01', '2026-12-31', 'open');

   -- approval policy: what the consumer pipeline evaluates against (guide §18).
   -- The example below auto-approves small cash expenses WITH a receipt, and sends
   -- everything else to a finance reviewer. Tune the bands with your finance adviser.
   -- Without an active policy the pipeline FAILS SAFE — every event needs human approval.
   insert into approval_policies (company_id, version, is_active, policy) values
     ('<company_id>', 1, true, '{
        "company_id": "<company_id>",
        "currency": "LKR",
        "version": 1,
        "rules": [
          { "id": "small-cash", "description": "auto-approve small cash expenses with a receipt",
            "priority": 1, "event_types": ["expense_payment"], "max_amount": "10000.00",
            "require_evidence": true, "auto_approve": true },
          { "id": "default", "description": "everything else → finance reviewer",
            "priority": 100, "auto_approve": false, "required_approver_roles": ["finance_reviewer"],
            "approvals_required": 1 }
        ]
     }'::jsonb);
   ```
   > Put the **real** `<company_id>` inside the JSON too (the engine checks it). The app
   > re-validates this JSON with Zod on read; an invalid policy is ignored and the
   > pipeline fails safe to human approval — it will never auto-approve on a bad policy.
   You'll confirm the rest of guide §18 (tax codes, approval limits, bank accounts,
   receipt policy) with your finance adviser before going live — see
   `docs/OPEN_QUESTIONS.md`.

**Test isolation now:** log in as a user with access to company A and confirm a
`select * from journal_entries` returns nothing for company B. RLS should make
cross-company rows invisible.

---

## 2. OpenAI (AI gateway) (5 min)

1. Create a key at <https://platform.openai.com/api-keys> → `.env.local` as `OPENAI_API_KEY`.
2. **Set a monthly spend limit** in Billing → Limits (protects the free-tier promise).
3. The live transport is **already built** — `src/ai/openai-transport.ts` (uses `fetch`,
   no SDK dependency; model ids stay confined to the gateway routing table). It reads
   `OPENAI_API_KEY` lazily, so it does nothing until the key is present. Nothing more to
   wire; the consumer (`src/inngest/functions.ts`) constructs it automatically.

Costs are recorded to the `ai_runs` table on every call (model, tokens, USD — guide §13),
so you can watch spend in SQL. In tests the gateway runs against an injected fake; no
live calls happen.

---

## 3. Inngest (durable jobs) (5 min)

1. Sign up at <https://www.inngest.com> (free). Create an app.
2. **App keys** → copy `Event Key` → `INNGEST_EVENT_KEY`; `Signing Key` → `INNGEST_SIGNING_KEY`.
3. After you deploy (step 5), register the serve URL in Inngest:
   `https://<your-vercel-app>/api/inngest`. Locally, run `npx inngest-cli@latest dev`
   and it auto-discovers `http://localhost:3000/api/inngest`.

---

## 4. Meta WhatsApp Cloud API — the webhook (15 min)

This is the boundary the code stops at. The handler already verifies Meta's challenge
and **hard-rejects bad signatures**; it just needs to be pointed at.

1. At <https://developers.facebook.com> create a **Business** app → add **WhatsApp**.
2. **WhatsApp → API Setup**: copy the **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
   Create a permanent token via a **System User** (Business Settings → System Users →
   generate token with `whatsapp_business_messaging` + `whatsapp_business_management`)
   → `WHATSAPP_ACCESS_TOKEN`.
3. **App Settings → Basic**: copy **App Secret** → `WHATSAPP_APP_SECRET` (this is what
   verifies `X-Hub-Signature-256`).
4. Choose any random string as your verify token → `WHATSAPP_VERIFY_TOKEN` (you'll type
   the same value into Meta next).
5. **WhatsApp → Configuration → Webhook → Edit**:
   - Callback URL: `https://<your-vercel-app>/api/webhooks/whatsapp`
   - Verify token: the `WHATSAPP_VERIFY_TOKEN` value from step 4
   - Click **Verify and Save** — Meta calls our `GET` handler; it echoes the challenge
     only if the token matches.
   - **Subscribe** to the `messages` field.
6. Send a WhatsApp message to your number (e.g. *"Paid 4,500 cash for fuel, receipt to
   follow"*). End to end you should now see the **whole consumer pipeline** run:
   - a row in `source_events` (status `received`) and **one** Inngest run;
   - an `ai_runs` row (the extraction call + its cost);
   - a `financial_events` row in a state that matches the content —
     `awaiting_evidence` (no receipt yet), `awaiting_information` (missing a field),
     `awaiting_approval` (complete, needs a human), or `approved` (matched an
     auto-approve rule — note it is **not** posted);
   - the matching `approval_requests` / `clarification_requests` / `duplicate_candidates`
     row; and `audit_events` entries tracing every step.
   Send the **same** message twice — the second is stored as `duplicate` and does **not**
   enqueue a second job (idempotency, guide invariant #9), so no duplicate financial event
   is ever created.

**Local testing without Meta:** use the signature helper to forge a valid header:
```bash
BODY='{"entry":[{"changes":[{"value":{"messages":[{"id":"wamid.TEST"}]}}]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WHATSAPP_APP_SECRET" | awk '{print $2}')"
curl -sX POST http://localhost:3000/api/webhooks/whatsapp \
  -H "Content-Type: application/json" -H "X-Hub-Signature-256: $SIG" -d "$BODY"
```
A wrong secret → `401 invalid signature` (the hard reject, D-007).

**Run the consumer locally too:** the forged `curl` above only *ingests*. To watch the
full pipeline run against your local app, start the Inngest dev server in a second
terminal — it discovers the app and executes the queued job:
```bash
npx inngest-cli@latest dev        # opens a dashboard at http://localhost:8288
```
With `SUPABASE_*` and `OPENAI_API_KEY` in `.env.local`, the forged message will flow all
the way to a `financial_events` row. Watch each step (and any retry) in that dashboard.

---

## 5. Publish the app to Vercel (10 min)

The app is a standard Next.js project (`next.config.mjs`, `src/app/**`), so Vercel needs
no special settings — **no `vercel.json` required**. `npm run build` is verified to pass
(2026-08-02): the home page prerenders and `/api/webhooks/whatsapp`, `/api/webhooks/email`
and `/api/inngest` build as on-demand server functions.

> **You can deploy before configuring anything.** All secret access is lazy, so the app
> builds and boots with **zero env vars** — the landing page renders and the API routes
> simply return an error until their keys are set. Recommended order: deploy bare (steps
> 1–2 below) → confirm the landing page loads → then add env + integrations (steps 1–4
> above and step 3 below) and redeploy.

1. **Push to GitHub** (nothing secret is committed — `.env*` is git-ignored; verify with
   `git status` that no `.env.local` is staged):
   ```bash
   git add -A && git commit -m "Interim finance: consumer pipeline"
   git push -u origin main
   ```
2. **Import** the repo at <https://vercel.com/new> — Vercel auto-detects Next.js
   (build `next build`, output handled for you). Or use the CLI: `! npx vercel` (the `!`
   prefix runs it in this chat so any login prompt comes back here).
3. **Environment Variables** (Project → Settings → Environment Variables): add **every**
   var from `.env.local`. Only the `NEXT_PUBLIC_*` ones are exposed to the browser; the
   rest (`SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `WHATSAPP_*`, `INNGEST_*`) are
   server-only secrets. Set them for **Production** (and Preview if you want PR builds).
4. **Deploy.** Your public URLs are:
   - webhook: `https://<app>.vercel.app/api/webhooks/whatsapp` → paste into Meta (step 4.5)
   - Inngest serve: `https://<app>.vercel.app/api/inngest` → register in Inngest (step 3.3)
5. **Redeploy after changing env vars** — Vercel only picks up new values on a fresh
   deploy (Deployments → ⋯ → Redeploy).
6. **Safety gate:** do **not** set `APP_ENV=production` for real accounting use until the
   owner-decision checklist (guide §18 / `docs/OPEN_QUESTIONS.md`) is signed off. Until
   then the system creates drafts, approvals and reports but is **not** the statutory
   ledger, and **nothing is posted or paid** (financial controls).

---

## 6. What runs now vs. what I build next

**Now (once the keys above exist), the full path is live and tested:**
WhatsApp/email → signature-verified webhook → `source_events` (persist-then-enqueue,
idempotent) → Inngest → `AiGateway.runExtraction` (untrusted-fenced, Zod-validated,
cost-logged) → `detectMissingFields` → `scoreDuplicate` → `financial_events` draft +
version → `evaluatePolicy` → `approval_requests` / `clarification_requests` /
`duplicate_candidates` → `audit_events`. Auto-approve moves an event to `approved` only
when your deterministic policy allows it — and even then **it does not post a journal**.

**Next phases (deferred, each its own approved step):**
1. **Approval → posting** (guide §17 Prompt D): an approved draft becomes a balanced
   journal via `buildPostedJournal` — still draft/read-only first (D-011 financial
   controls). This is intentionally separate: approval is not permission to post.
2. **Inbound reply handling:** answers to clarification/approval messages re-open the
   event and re-run the relevant steps.
3. **WhatsApp sender → employee/user resolution** (the pipeline attributes `system` as
   submitter until this lands).
4. **Finance dashboard + reports UI** (guide §11–§12) on top of the existing math.
5. **Receipt OCR** for uploaded images/PDFs.

Tell me which of these to build next (my suggestion: **approval → posting**), and I'll
continue from exactly here.
