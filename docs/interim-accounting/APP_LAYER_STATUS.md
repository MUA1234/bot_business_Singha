# App layer — employee dashboards + WhatsApp quotation flow

**As of 2026-08-04.** This is the operational web app built on top of the finance
core (see `BUILD_STATUS.md`). Decisions: `DECISIONS.md` D-016 (auth + departments)
and D-017 (fully-AI quotation with department price-confirmation fallback).

## What was built (✅ code complete, builds green, 66 core tests still pass)

### Auth & departments
- Username + password login (`/login`), mapped to `<username>@singha.local` for
  Supabase Auth. Cookie sessions via `@supabase/ssr`; `src/middleware.ts` gates `/app/*`.
- `profiles` + `departments_catalog` tables (migration `0007`), department-aware RLS.
- On login, each employee is redirected to their department dashboard.

### Admin panel (`/app/admin`)
- Create employees (username, full name, department, temp password, optional admin).
- Enable/disable accounts; reset passwords. Uses the service-role `auth.admin` API.
- Departments overview; **Products & Prices** catalog (the AI quoting engine prices
  against this).

### Department dashboards (`/app/<dept>`)
- **Sales**: overview, orders, quotations (link to branded quote page), price-confirmation
  queue, customers + WhatsApp chat thread.
- **Finance**: overview, invoices, approvals log, price-confirmations, **Excel/CSV exports**
  (`/api/exports/<kind>`).
- **Marketing / Operations / HR / Procurement**: on-brand scaffolds, wired to auth + isolation.

### WhatsApp order → quotation pipeline
- Webhook (`/api/webhooks/whatsapp`) enqueues each inbound customer text to Inngest
  (`whatsapp/customer_message.received`, idempotent on the provider message id).
- `onCustomerWhatsAppMessage` runs the intake AI turn (`src/ai/quotation.ts` — **never
  prices**), collects name/address/items, then builds a quotation:
  - all items priced from catalog → finalize + WhatsApp the branded quote link;
  - any price unknown → a `price_confirmation` routed to a department; the customer keeps
    chatting and **every message carries the `(Quotation is being generated. Please wait)`
    footer** until staff confirm the price, which auto-finalizes and sends the quote.
- Branded customer quotation page at `/q/<token>` (Singha logo + theme, Print/Save-as-PDF).

### Design
- "Evolution" purple→magenta theme + Singha lion (`src/app/globals.css`, `/public/brand`).
- Phone inputs auto-detect the country and show a dial-code dropdown (`src/components/PhoneInput.tsx`).

## To go live (owner configuration — not code)

1. **Run the DB migration.** Paste `docs/interim-accounting/ALL_MIGRATIONS.sql` (now
   includes `0007`) into the Supabase SQL editor. This also seeds the Singha company +
   departments.
2. **Create the first admin.** In Supabase Auth, add a user with email
   `admin@singha.local` + a password, then insert a `profiles` row for that user id with
   `department='admin'`, `is_admin=true` (SQL snippet below). After that, all other
   accounts are created from the in-app admin panel.
3. **Add the missing WhatsApp secrets in Vercel** (only `WHATSAPP_VERIFY_TOKEN` is set
   today): `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`.
   Without these, inbound signature verification and outbound sending stay disabled (the
   pipeline still records everything; it just can't reply).
4. **Inngest keys** (`INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`) so the durable queue runs
   in production; register `/api/inngest`.
5. Confirm `APP_BASE_URL` is the Vercel URL so quote links resolve.

```sql
-- First admin (run after creating the auth user admin@singha.local):
insert into profiles (id, username, full_name, department, is_admin)
values ('<auth-user-uuid>', 'admin', 'Owner', 'admin', true);
```

## Not yet built (next)
- Staff-initiated outbound WhatsApp replies from the chat thread (currently the bot replies;
  the thread is read-only for staff).
- Deep Marketing/Operations/HR/Procurement features (scaffolds only).
- Native Android wrapper (the app is responsive/PWA-ready; wrap later).
