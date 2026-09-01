# 1. Current deployed-product assessment

## 1.1 What is actually running

| | |
|---|---|
| Host | Railway project `singha-central`, service `singha-web` (D-021) |
| Origin | `https://singha-web-production.up.railway.app` |
| Deploys from | GitHub `MUA1234/bot_business_Singha` @ **`main`** |
| Live? | **Yes** — verified `HTTP/1.1 200`, `Server: railway-hikari`, `x-railway-edge: sin1` |
| `/api/health` | responds `unauthorized` (correctly gated) |
| Second origin | Vercel, still live |
| Inbound webhook | **points at Vercel**, not Railway (D-021, owner action pending) |

Security headers on the live origin are correct and complete: HSTS with preload, a
restrictive CSP, `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy and a
permissions policy denying camera, microphone and geolocation. This is a well-secured
deployment.

<a id="pr-f-005"></a>
### PR-F-005 (P0) — Two live origins, one webhook

Decision D-021 records the constraint plainly: *"Meta's WhatsApp webhook can point at
only ONE origin — whichever host is not receiving it processes no inbound messages."*
It is recorded as *"Railway live and health-green; webhook still pointed at Vercel
pending owner repoint."*

Consequences while this stands:

- The Railway service — the one the owner instructed should be "a proper server" —
  **receives no inbound WhatsApp traffic at all.**
- The in-process scheduler added specifically because Railway runs a persistent process
  (`IN_PROCESS_CRON`) runs on the host that has no inbound work to schedule around,
  while the host that *does* receive messages is the serverless one whose scheduling
  limits motivated the move.
- Two origins share one Supabase project. Both can write. Cron credentials were
  deliberately not shared (`CRON_SECRET` regenerated), which is good hygiene, but it
  also means **each host schedules independently** against the same database.

This is the highest-priority operational item in the audit and it is resolved by an
owner action, not by code. See [11-OWNER-DECISIONS.md](11-OWNER-DECISIONS.md) D-1.

## 1.2 What the deployed line contains

`main` at `acd9fbe` (2026-09-01 18:03 +0530) contains:

- migrations `0001`–`0069` (69 files);
- the WhatsApp Cloud API webhook, quotation flow, price confirmations and outbox;
- the Accounting Core and finance surfaces;
- departmental dashboards;
- the exception-led Command Centre;
- **no** spatial workspace (the `/app/spatial` route does not exist on `main`);
- **no** risk register, insurance register, integration gateway, management directives,
  service-provider registry, model-gateway telemetry, inbound review queue, task
  routing/escalation chain, funding requirements, incidents or statutory obligations —
  all of those are branch-only (migrations 0070–0109).

The owner's description of the deployed system as "primarily a sales, WhatsApp and
quotation-handling application with departmental dashboards" is **accurate for `main`**.

## 1.3 Is the spatial V3/V4 work deployed?

**No — on two independent grounds.**

1. **It is not on the deployed branch.** `git cat-file -e origin/main:src/app/app/spatial/page.tsx`
   fails: the route does not exist on `main`. The spatial workspace exists only on the
   `claude/uiux-v3-v4-checkpoint` line and its descendants, including this audit branch.
2. **Even where the code exists, it is inert by default.** `/app/spatial` is gated on
   `NEXT_PUBLIC_SPATIAL_WORKSPACE === "on"` (`src/config/env.ts:48`) and renders an
   explicit "Spatial workspace is not enabled" empty state otherwise. It additionally
   requires admin.

So the answer is unambiguous: **the spatial work is not deployed and could not be
activated on the current production host by flipping an environment variable**, because
the code is not there. It comprises 21 components plus a workspace shell, reducer,
window registry and panel set — a substantial, self-contained body of work that is
currently reaching no user.

Note that the Command Centre panel is *shared*: `/app/command` renders
`CommandCentrePanel` directly, and the spatial workspace embeds the same component. The
panel is therefore live on `main`; only the spatial shell around it is not.

## 1.4 Is the AI actually operating the business?

No. This is the substantive product finding, and it is measurable.

<a id="pr-f-006"></a>
### PR-F-006 (P1) — The management loop observes one signal class

The management loop has exactly **two** entry points in the entire codebase:

| Entry point | Trigger | Signal observed |
|---|---|---|
| `src/app/app/command/analyze/actions.ts` | A human pastes text and presses a button | free text |
| `src/app/api/cron/ai-monitor/route.ts` → `analyzeConversationThread` | cron sweep | `wa_conversations` only |

`ai-monitor` selects from exactly one table:

```
.from("wa_conversations").select("id, company_id, last_inbound_at, ai_analyzed_at")
```

Nothing else is observed. There is no sweep over overdue tasks, budget variance,
stalled projects, expiring contracts, unpaid invoices, capacity shortfalls, stock
levels, vehicle documents or objective drift — **despite tables existing for every one
of those.**

Corroborating measurements:

- Only **2 of 105** authenticated app surfaces import the AI gateway (`@/ai/`): the
  inbound sweeper and the manual analyse form.
- The 23 app surfaces that import `@/management` overwhelmingly import
  `renewals.ts` (10 of 27 import sites) — a **pure, deterministic date comparator with
  zero AI involvement** that flags expiry. That is a useful detector, but it displays;
  it does not create a case, propose an action, request approval, or open a task.

So the legal, fleet and finance "intelligence" the codebase advertises is, in the main,
date arithmetic rendered into a card. The owner's framing — *conventional departmental
software with an Analyse button* — is not rhetorical. It is the literal architecture.

## 1.5 What is genuinely strong in the deployed product

This must be said plainly, because the recovery depends on not destroying it:

| Capability | Evidence |
|---|---|
| Authentication and department/admin gating | `requireAdmin` / `requireDepartment` used consistently across pages |
| Company-scoped schema and RLS policy surface | 74 of 146 tables have RLS explicitly enabled; capability-gated write matrix across migrations 0034–0048 |
| Double-entry Accounting Core | `src/accounting/*` (9 modules, 740 LOC) with settlement, reversal, periods, tax, amortization, trial balance |
| Authority and approval engine | `src/policy/*` (571 LOC) — deterministic ladder, delegation, fail-closed escalation |
| Durable outbox with lease, retry, dead-letter | migrations 0011/0031/0040/0055/0063–0067; `src/events/outbox-*.ts` |
| Idempotency discipline | canonical fingerprints, caller-supplied keys, `idempotency_keys` table |
| Security hardening depth | ten external review loops on the WP12 delivery boundary; `search_path`/`pg_temp` shadowing closed catalog-wide (0067) |
| Exception-led Command Centre | 458-LOC panel with real cash forecast, receivables/payables ageing, exception lanes |
| Test discipline | 1365 unit tests / 184 files; 75 integration files; typecheck clean |

The security and accounting foundations here are considerably better than typical.
**None of this should be rebuilt.**

<a id="pr-f-012"></a>
### PR-F-012 (P2) — RLS is bypassed at runtime

Register finding OF-012 is open: `RLS_READS` and `RLS_WRITES` default OFF, so the
application reads and writes through the service-role client, which bypasses
row-level security. The policies are written, migrated and tested — the integration
suite runs with the flags ON — but in the deployed configuration **company isolation is
enforced by application code, not by the database.**

This is not an immediate breach: the application does scope its queries. But
`CLAUDE.md` requires that cross-company leakage be "proven impossible by tests", and
the proof currently holds only in a configuration production does not run. The cutover
is an owner decision (D-4).
