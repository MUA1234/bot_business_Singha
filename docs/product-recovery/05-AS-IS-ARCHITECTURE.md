# 5. As-is architecture

## 5.1 Inventory

| Layer | Count | Location |
|---|---|---|
| Pages | 114 total; **105** authenticated under `/app` | `src/app/**/page.tsx` |
| API routes | 19 (8 cron, 2 webhooks, 6 mobile v1, health, exports, inngest) | `src/app/api/**/route.ts` |
| React components | 66 (of which 21 are the spatial workspace) | `src/components/` |
| Domain modules | 14 directories, 42 files, ~3,600 LOC | `src/modules/` |
| Accounting Core | 9 modules, 740 LOC | `src/accounting/` |
| Policy / authority | 3 modules, 571 LOC | `src/policy/` |
| AI layer | 11 files (gateway, transports, routing, pricing, prompts, evals) | `src/ai/` |
| Management layer | 18 files (16 AI-manager, 1 policy, 1 routing) | `src/management/` |
| Event workers | 9 | `src/events/` |
| Durable jobs | Inngest client + 2 modules | `src/inngest/` |
| Migrations | 109 files, 16,501 lines | `src/db/migrations/` |
| Tests | 189 unit files + 75 integration files, 33,733 LOC | `tests/` |
| **Application code** | **51,603 LOC** | `src/` |

## 5.2 The shape of the system today

```
                        ┌──────────────────────────────────────┐
  Meta WhatsApp ──────► │ /api/webhooks/whatsapp               │
  Cloud API             │  signature verify → source_events    │
                        └───────────────┬──────────────────────┘
                                        │
                             ┌──────────▼───────────┐
                             │ order-intake /       │
                             │ quotation flow       │  ◄── the deployed product
                             │ price confirmations  │
                             └──────────┬───────────┘
                                        │
                             ┌──────────▼───────────┐
                             │ message_outbox       │──► WhatsApp send
                             │ lease/retry/DLQ      │    (drain worker)
                             └──────────────────────┘

  ┌────────────────────────────────────────────────────────────────────┐
  │  105 authenticated pages                                           │
  │                                                                    │
  │  finance(31) admin(13) sales(10) procurement(10) legal(9)          │
  │  operations(5) hr(5) command(5) fleet(4) marketing(3) …            │
  │                                                                    │
  │      95 of 105 query Supabase DIRECTLY from the page               │
  │                    │                                               │
  └────────────────────┼───────────────────────────────────────────────┘
                       ▼
              ┌────────────────────┐
              │ Supabase Postgres  │  146 tables · 109 functions · RLS on 74
              │ (service-role      │  RLS_READS/RLS_WRITES currently OFF
              │  client — RLS      │
              │  bypassed)         │
              └────────────────────┘

  ── the AI, in full ───────────────────────────────────────────────────
  /app/command/analyze  ──┐
  (a human presses a      ├──► runManagerObservation ──► planFromObservation
   button, pastes text)   │         (AI gateway)          (deterministic)
                          │                                     │
  /api/cron/ai-monitor ───┘                                     ▼
  (sweeps wa_conversations                          management_cases + tasks
   ONLY — nothing else)                             (status: needs_routing)
                                                              │
                                                              ▼
                                                        ⛔ stops here
                                                   (no assignee recommender)
```

## 5.3 The structural problem

<a id="pr-f-009"></a>
### PR-F-009 (P1) — Page-centric data access leaves no seam for the loop

**95 of 105** authenticated pages query Supabase directly. Only 37 files under
`src/app/app` import anything from `@/modules`. The domain layer, where it exists at
all, is thin:

| Module | Files | LOC |
|---|---|---|
| `finance` | 14 | 1,028 |
| `project` | 6 | 672 |
| `work` | 6 | 663 |
| `management` | 2 | 301 |
| `identity` | 2 | 183 |
| `procurement` | 3 | 131 |
| `crm` | 2 | 129 |
| `calendar` | 1 | 139 |
| `commercial` | 2 | 104 |
| `governance` | 1 | 82 |
| `legal` | 1 | 41 |
| `workforce` | 1 | 40 |
| `comms` | 1 | 37 |
| `fleet` | 1 | 31 |

`src/modules/fleet` is a single pure function computing kilometres per litre.
`src/modules/legal` is 41 lines. These are not domain services; they are helpers that a
page happens to call. The *business logic for the legal domain lives inside the legal
pages.*

**Why this matters more than ordinary code-organisation preference:** a management loop
must observe and act on domain state without going through a browser. When the only
path to "what is the state of legal obligations" is a React server component that also
renders a table, the loop has nowhere to attach. Every observer would have to
re-implement the query, and every action the loop proposes would have to re-implement
the write, its validation, its permission check and its audit event.

This is the single largest reason the system reads as "conventional departmental
software": **it is architecturally departmental.** Each page is a self-contained
vertical from HTML to SQL. There is no horizontal layer for an operating system to be.

The counter-example, and the proof that the fix is achievable, is finance: 14 modules
and 1,028 LOC of extracted logic, which is also the domain with the deepest tests and
the only one that is genuinely "complete and operational".

## 5.4 What is well-architected

Stated plainly, because the recovery preserves it:

**The trust boundary.** Sensitive transitions are RPC-only, `SECURITY DEFINER`,
`service_role`-gated, with signature-exact allowlists and owner-derived positive trust
checks rather than role-name denylists. `search_path` is pinned canonically across every
application-owned function with a permanent regression gate. Ten external review loops
produced this and it is better than most production systems.

**The event spine.** `source_events` with leases, bounded retry, dead-letter and error
categories; `message_outbox` with claim/complete fencing, quotation-aware claim
eligibility, and content freezing after send. A failed process does not lose the
original event, and a duplicate event does not create a duplicate anything — exactly
what `CLAUDE.md` demands.

**The authority engine.** Deterministic, fail-closed, delegation-aware, with an explicit
ladder and audit reasons. The AI proposes; the ladder decides what needs a human. The
pipeline `schema validation → deterministic authority → permission → audit` is real and
enforced, not aspirational.

**The accounting core.** Internally owned double-entry with canonical-JSON fingerprint
idempotency, posted-journal immutability, controlled reversals and period locks.

**The Command Centre.** Exception-led rather than counter-led. It shows what needs
attention, in four severity lanes, with a cash trough forecast and ageing — and it
degrades honestly ("Data degraded — no all-clear can be given") rather than rendering
zeros. This is already the right *interaction model* for an OS; it simply lacks inputs.

## 5.5 Dead ends and duplicates

The owner asked for these specifically. The honest answer is that there are **few**:

| Surface | Assessment |
|---|---|
| `/app/finance/price-requests` vs `/app/sales/price-requests` | **Not a duplicate.** Same `PriceRequests` component, different department scope (`requireDepartment("finance")` vs `("sales")`). Intentional and correct. |
| `/app/finance/invoices` vs `/app/finance/customer-invoices` | Overlapping. `invoices` is quotation-linked; `customer-invoices` is ledger-linked. Worth consolidating, low priority. |
| `/app/ai` | **Not a shell.** Reads `ai_runs` for cost, validation rate and authority boundary, and explicitly states what it is *not* (no agent builder, no agent control room) rather than implying absent capability. Good practice. |
| `/dev/design-lab/*` | Development-only, flag-gated, 404s when off. Verified working in both directions during the hard-scenario campaign. Retain. |
| `/app/spatial` | Not dead — **undeployed**. 21 components, flag-gated, absent from `main`. |
| `docs/architecture-v2/RUN_*.sql`, `docs/interim-accounting/ALL_MIGRATIONS.sql` | **Genuine drift risk**, flagged by the repo's own docs: duplicate runnable migration copies that can diverge from canonical migrations. Should be retired. |
| Marketing (352 LOC / 3 pages) | Thin but real (campaigns, audiences, lead scoring). Not a shell; incomplete. |

There is no significant graveyard of empty counter dashboards. The pages generally
query real tables and degrade honestly. The problem is not junk surfaces — it is that
**real surfaces are not connected to a management loop.**

## 5.6 Deployment topology (as-is)

```
   Meta webhook ──► Vercel  ── heartbeat cron only (daily 07:00)
                      │        no outbox drain, no ai-monitor, no follow-ups
                      │
                      ├──────► Supabase (shared)
                      │
   (no inbound)      Railway ── in-process scheduler: outbox 1m, follow-ups 15m,
                               ai-monitor 1h, digest 24h   [IN_PROCESS_CRON=on]
```

Two origins, one database, one webhook, and the scheduling is on the origin without the
traffic. See PR-F-005 and §3.4 of the SHA comparison.
