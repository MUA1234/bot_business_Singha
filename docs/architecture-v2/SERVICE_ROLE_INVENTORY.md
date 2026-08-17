# Service-role (`supabaseAdmin()`) inventory — WP D

> Production Security & Reliability Gate, Work Package D item 1–2. Inventory of every
> direct `supabaseAdmin()` / service-role call and its classification for the RLS cutover.
> Generated 2026-08-07. Count at this date: **~67 call sites across 40 files.**
>
> **COMPLETION-PROGRAM UPDATE (2026-08-17, Phase 0):** the authoritative, regenerable file list is
> now machine-generated — `docs/architecture-v3.1/COMPLETION_INVENTORY.md` §1 via
> `node scripts/completion-inventory.mjs` (**39 files** excluding the `src/lib/supabase/` shim layer
> at the Phase-0 baseline; `--check` will fail the build against
> `scripts/allowlists/supabase-admin-system.json` once Phase 2 arms it). A fresh code-first
> re-classification (every file opened, 2026-08-17) refines the tables below; where the two disagree,
> the 2026-08-17 classification wins:
>
> - **SYSTEM-KEEP confirmed:** whatsapp webhook, 4 cron routes (+`/api/health`), `src/inngest/functions.ts`,
>   `src/events/outbox-drain.ts`, `src/lib/audit.ts` (service_only table), `src/lib/notify.ts`
>   (service_only), `src/lib/outbox-enqueue.ts` (service-only RPC), `src/lib/order-intake.ts`
>   (no user session), `src/app/app/admin/outbox/*` (service_only table),
>   `src/app/app/admin/audit/page.tsx` + `admin/health/page.tsx` (service_only tables),
>   `admin/employees/actions.ts` `auth.admin.*` calls only.
> - **AUTH-READ to cut over (Phase 2):** `src/lib/auth.ts` (`getProfile`/`resolveCapability` read the
>   caller's own rows), `src/lib/task-access.ts`, `src/lib/ledger-report.ts`,
>   `src/components/PriceRequests.tsx`, admin dashboard/employees/departments/catalog/objectives
>   pages, hr pages (4), the non-audit kinds of `src/app/api/exports/[kind]/route.ts`,
>   `login/actions.ts` post-auth profile read (session already exists — 2026-08-07 called it S;
>   re-audit reclassifies it R).
> - **AUTH-WRITE to cut over (Phase 2):** `operations/tasks/actions.ts` (15 refs),
>   `_actions/price.ts` (`dismissPrice`), `admin/employees/actions.ts` profiles DML,
>   `command/analyze/actions.ts` tasks inserts, `resolvePriceConfirmation` in `src/lib/quotations.ts`,
>   `src/lib/documents.ts` documents-row DML (storage ops stay S), `messages/[id]/actions.ts`
>   conversation check (R) vs service_only writes (S), `hr/capacity/actions.ts` reads (R) vs
>   `capacity_snapshots` upsert (S).
> - The flag shim `src/lib/supabase/read.ts` reaches **91 files**; `supabaseReadClient`/
>   `supabaseWriteClient` silently return the ADMIN client while `RLS_READS`/`RLS_WRITES` are OFF —
>   those 91 files are the cutover's blast radius, gated by the flags, and are NOT double-counted
>   above.
>
> Classification legend:
> - **S** — legitimate service/worker/admin operation (service role is correct; keep).
> - **R** — normal authenticated READ that should move onto the RLS client (`supabaseServer`).
> - **W** — normal authenticated WRITE that should move onto RLS or a capability RPC.
> - **X** — temporary legacy exception (has owner, reason, removal trigger).
>
> Cutover is staged behind `RLS_READS` / `RLS_WRITES` (both OFF today). The finance
> money-path actions already use `supabaseWriteClient()` (flag-gated) and the central
> `requireFinanceAccess()` capability gate — they are NOT in the service-role list below.

## Infrastructure / definitions (S — keep)

| File | Use | Class | Note |
|---|---|---|---|
| `src/lib/supabase/server.ts` | defines `supabaseAdmin` | S | Infra. The one place the service key is used. |
| `src/lib/supabase/read.ts` | defines `supabaseReadClient` / `supabaseWriteClient` | S | Flag-gated cutover clients (RLS_READS/RLS_WRITES). |

## Workers / system / no-user-session (S — keep; service role is correct)

| File | Use | Class | Note |
|---|---|---|---|
| `src/app/api/webhooks/whatsapp/route.ts` | persist source event | S | No user session; system actor. Persist-first (WP C). |
| `src/lib/order-intake.ts` | WhatsApp intake engine | S | Bot runs as system; there is no authenticated user. |
| `src/lib/quotations.ts` | quotation build/send | S | Bot/system flow. |
| `src/inngest/functions.ts` | durable workers + schedules | S | Service workers (WP C sweeps, consumer pipeline). |
| `src/events/outbox-drain.ts` | outbox claim/send | S | Service worker (claim RPC is service_role-only). |
| `src/lib/outbox-enqueue.ts` | transactional outbox enqueue | S | Tightly-scoped worker write. |
| `src/lib/notify.ts` | create notifications | S | System-generated notifications. |
| `src/lib/audit.ts` | append-only audit write | S | Audit is append-only; financial audit is now in-RPC (WP B/E). |
| `src/app/api/cron/outbox/route.ts` | drain outbox | S | CRON_SECRET job. |
| `src/app/api/cron/follow-ups/route.ts` | task follow-ups | S | CRON_SECRET job. |
| `src/app/api/cron/daily-digest/route.ts` | digest | S | CRON_SECRET job. |
| `src/app/api/cron/ai-monitor/route.ts` | AI monitor | S | CRON_SECRET job. |
| `src/app/login/actions.ts` | read profile pre-auth | S | Runs before a session exists (bootstrap). |

## Identity resolution (S now → R after cutover)

| File | Use | Class | Note |
|---|---|---|---|
| `src/lib/auth.ts` | `getProfile` (profiles), `resolveCapability` (memberships) | S→R | Session bootstrap needs a service read; candidate for a session-bound RLS read once `RLS_READS` is on and `profiles`/membership read policies are validated. |

## Authenticated READS that must move to RLS (R)

| File | Use | Class | Removal trigger |
|---|---|---|---|
| `src/app/app/hr/page.tsx` | HR dashboard reads | R | `RLS_READS` on + HR read UAT. |
| `src/app/app/hr/staff/page.tsx` | staff list | R | `RLS_READS` on. |
| `src/app/app/hr/staff/[id]/page.tsx` | staff detail | R | `RLS_READS` on. |
| `src/app/app/hr/capacity/page.tsx` | capacity read | R | `RLS_READS` on. |
| `src/app/app/admin/*/page.tsx` (page, outbox, objectives, health, employees, departments, catalog, audit) | admin dashboards | R | `RLS_READS` on + `admin.identity.manage` capability check replacing `is_admin`. |
| `src/components/PriceRequests.tsx` | price-request read | R | `RLS_READS` on. |
| `src/lib/ledger-report.ts` | finance ledger report | R | `RLS_READS` on + `export`/`view` capability. |
| `src/lib/task-access.ts` | task access checks | R | `RLS_READS` on. |
| `src/lib/documents.ts` | document metadata | R | `RLS_READS` on (storage signed URLs may stay service). |
| `src/app/api/exports/[kind]/route.ts` | data export | R | `RLS_READS` on + `export` capability. |

## Authenticated WRITES that must move to RLS/capability RPC (W)

| File | Use | Class | Target capability / removal trigger |
|---|---|---|---|
| `src/app/app/operations/tasks/actions.ts` | task CRUD (14 uses) | W | `operations.task.manage` / `operations.task.work` + `RLS_WRITES`. |
| `src/app/app/admin/employees/actions.ts` | identity/employee writes (5) | W | `admin.identity.manage` + `RLS_WRITES`. |
| `src/app/app/hr/capacity/actions.ts` | capacity writes | W | `hr.staff.manage` + `RLS_WRITES`. |
| `src/app/app/admin/outbox/actions.ts` | admin outbox replay | W (S ok) | Admin/service action; must be audited (replay). |
| `src/app/app/admin/objectives/page.tsx` | objective writes | W | `RLS_WRITES` + capability. |
| `src/app/app/messages/[id]/actions.ts` | message actions | W | `RLS_WRITES` + capability. |
| `src/app/app/_actions/price.ts` | price confirmation write | W | capability + `RLS_WRITES`. |
| `src/app/app/command/analyze/actions.ts` | command analyze | W | capability + `RLS_WRITES`. |

## Temporary legacy exceptions (X)

| File | Use | Owner | Reason | Removal trigger |
|---|---|---|---|---|
| `src/lib/idempotency-store.ts` | `claimIdempotencyKey` | dev | **DELETED 2026-08-17** (completion-program Phase 0) — zero call sites re-verified before deletion. | Done. |

## Method note

Entries for files that were read in full during this phase (finance actions, order-intake,
outbox, audit, auth, webhook, cron/outbox, inngest) are verified by reading. The remaining
page/action files are classified by their path role and single call-site; each must have its
specific reads/writes confirmed during the corresponding role UAT before its `RLS_READS`/
`RLS_WRITES` cutover (see `RLS_CUTOVER_PLAN.md`). No file is asserted "cutover complete"
here — this is the inventory that gates that work.
