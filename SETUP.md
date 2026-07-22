# SETUP.md — manual steps you must do yourself

This file lists everything a human must do outside the codebase. It is updated
whenever a new manual step appears. **Phase 0 is documentation only** — nothing here
needs to be done to review the docs. The steps below are the full pilot setup, staged
by phase; do each phase's steps when that phase begins.

For each value you obtain, the exact **env var** it goes into is named. All secrets go
in `.env.local` (local) and Vercel/Supabase env settings (deployed) — **never commit
them**. See `.env.example` for the full list.

> Tip: to run a command in this Claude Code session so its output is captured, type
> `! <command>` at the prompt (e.g. an interactive login).

## Terminal (once the app scaffold exists — Phase 1+)

```bash
npm install
npx supabase login
npx supabase link --project-ref <YOUR_SUPABASE_PROJECT_REF>
npx supabase db push
npx inngest-cli dev        # local Inngest dev server (separate terminal)
npm run dev
npm run test
vercel --prod              # only with explicit approval
```

## 1. Supabase (Phase 1)

1. Create a project at https://supabase.com → **New project** (create **two**: one
   `-staging`, one `-prod`).
2. Project Settings → API → copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL` (and `SUPABASE_URL`)
   - `anon` public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY` (server-only, never client)
3. Project Settings → General → copy the **Reference ID** → used in
   `supabase link --project-ref <ref>`.
4. Enable Auth providers you need (email at minimum); require MFA for finance/admin
   roles per `docs/SECURITY_AND_PRIVACY_MODEL.md`.

## 2. Meta WhatsApp Cloud API (Phase 8)

1. https://developers.facebook.com → **Create App** → type **Business**.
2. Add the **WhatsApp** product. The number must be a registered **WhatsApp Business**
   number (not a personal account). Recommended: a **separate** number from the Sasiri
   sales bot (see `docs/OPEN_QUESTIONS.md` Q7).
3. From WhatsApp → API Setup copy:
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - a **permanent access token** (via a System User) → `WHATSAPP_ACCESS_TOKEN`
   - **App Secret** (App Settings → Basic) → `WHATSAPP_APP_SECRET` (for signature checks)
4. Configure the **webhook**: Callback URL `https://<your-app>/api/whatsapp`, Verify
   token = a value you choose → `WHATSAPP_VERIFY_TOKEN`. **Subscribe to the `messages`
   field.**
5. Respect the 24-hour customer-service window; create approved **message templates**
   for business-initiated messages.

## 3. OpenAI (Phase 3)

1. https://platform.openai.com → API keys → **Create key** → `OPENAI_API_KEY`.
2. Billing → **set a spending limit** (cost rule; see `docs/MODEL_ROUTING.md` §5).

## 4. Inngest (Phase 2)

1. https://www.inngest.com → create account/app → get:
   - **Event Key** → `INNGEST_EVENT_KEY`
   - **Signing Key** → `INNGEST_SIGNING_KEY`
2. Connect the Vercel app; functions are served from `/api/inngest`. Use separate
   Inngest environments for staging and production.

## 5. Vercel (Phase 1)

1. https://vercel.com → **New Project** → import this repo.
2. Add **all** env vars from `.env.example` (Production + Preview scopes).
3. Deploy. `git push` auto-deploys. Production promotion requires explicit approval.

## 6. QuickBooks / Intuit (Phase 11)

1. https://developer.intuit.com → **Create an app** → start with a **SANDBOX** company.
2. Get **Client ID** → `QUICKBOOKS_CLIENT_ID`, **Client Secret** →
   `QUICKBOOKS_CLIENT_SECRET`.
3. Set the **OAuth redirect URI** → `https://<your-app>/api/quickbooks/callback` →
   also `QUICKBOOKS_REDIRECT_URI`.
4. Set `QUICKBOOKS_ENVIRONMENT=sandbox` for staging; production is **draft-only**.
   Never test financial behaviour against production data.

## Sign-off owners to identify (see `docs/OPEN_QUESTIONS.md`)

Management (scope), finance (accounting/payments), privacy/legal (gated GPS/CCTV
features). Gated features do not enter staging without their owner's sign-off.
