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
npm test           # sanity: should print "57 passed"
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
   ```
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
3. Wire the live transport (the one small piece of code left, kept out until you had a
   key): create `src/ai/openai-transport.ts` implementing `CompletionTransport` from
   `src/ai/gateway.ts`. Tell me when your key is set and I'll add it — it's ~30 lines
   and belongs only in that file (the "no model IDs outside the gateway" rule, D-006).

Until then the gateway runs against an injected fake in tests; no live calls happen.

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
6. Send a WhatsApp message to your number. It should land in `source_events`
   (status `received`) and enqueue one Inngest job. Send the **same** message twice —
   the second is stored as `duplicate` and does **not** enqueue again (idempotency).

**Local testing without Meta:** use the signature helper to forge a valid header:
```bash
BODY='{"entry":[{"changes":[{"value":{"messages":[{"id":"wamid.TEST"}]}}]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WHATSAPP_APP_SECRET" | awk '{print $2}')"
curl -sX POST http://localhost:3000/api/webhooks/whatsapp \
  -H "Content-Type: application/json" -H "X-Hub-Signature-256: $SIG" -d "$BODY"
```
A wrong secret → `401 invalid signature` (the hard reject, D-007).

---

## 5. Deploy to Vercel (10 min)

1. Push this repo to GitHub, import it at <https://vercel.com/new> (Next.js auto-detected).
2. **Project → Settings → Environment Variables**: add every var from `.env.local`
   (the `NEXT_PUBLIC_*` ones are safe to expose; the rest are secret).
3. Deploy. Your webhook URL is `https://<app>.vercel.app/api/webhooks/whatsapp` — put
   that into Meta (step 4.5) and Inngest (step 3.3).
4. Do **not** flip `APP_ENV=production` for real accounting use until the owner-decision
   checklist (guide §18 / `docs/OPEN_QUESTIONS.md`) is signed off — until then the
   system creates drafts and reports but is not the statutory ledger.

Use `! <command>` in this chat for any interactive login (e.g. `! vercel login`) so the
output comes back here.

---

## 6. What I build next (after you confirm the above)

Once Supabase + OpenAI + Inngest keys exist, the **next phase** wires the consumer in
`src/inngest/functions.ts` end-to-end (all logic below is already built + tested; this
is just connecting it): load source event → `AiGateway.runExtraction` (untrusted-fenced)
→ `detectMissingFields` → `scoreDuplicate` → create `financial_events` draft →
`evaluatePolicy` → `approval_requests` → append `audit_events`. Then the approval→posting
step (guide §17 Prompt D) turns an approved draft into a balanced journal via
`buildPostedJournal`, and the finance screens/reports (guide §11–§12) render on top.

Tell me when the keys are in place and whether you want the **OpenAI transport** wired
first or the **consumer pipeline** — I'll continue from exactly here.
