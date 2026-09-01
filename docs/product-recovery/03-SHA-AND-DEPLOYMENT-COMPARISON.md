# 3. Repository and deployment SHA comparison

## 3.1 The revisions

| Ref | SHA | Date | Migrations | Spatial |
|---|---|---|---|---|
| `origin/main` (**deployed**) | `acd9fbec35d3075c8faba1c6bbb9b4aaca1ab164` | 2026-09-01 18:03 +0530 | 0001–**0069** (69) | no |
| `claude/hard-scenario-testing` (baseline) | `abc7767eb8b669433cd67a3a97e7b8673874fb49` | — | 0001–**0109** (109) | yes |
| `claude/product-recovery-audit` (this audit) | `abc7767e…` (identical) | — | 109 | yes |
| Merge base | `48bef9c` | 2026-08-18 | — | — |

**Divergence: the branch is 234 commits ahead of `main` and 11 commits behind it.**
The two lines have been developing in parallel for two weeks.

## 3.2 The deployed SHA

<a id="pr-f-014"></a>
### PR-F-014 (P2) — No build provenance

The deployed SHA **cannot be confirmed directly**. The running application exposes no
commit identifier: there is no `RAILWAY_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA` or
build-id surface anywhere in `src/`, and `/api/health` is authenticated.

What can be established:

- D-021 records that the Railway service `singha-web` deploys from
  `MUA1234/bot_business_Singha` @ **`main`**.
- The origin is live and serving (verified `200`, `Server: railway-hikari`).
- Therefore the deployed revision is, to the best available evidence, **`acd9fbe`** —
  the tip of `main` — *assuming* the most recent auto-deploy succeeded.

That assumption is unverified and should not be relied upon for a migration decision.
**Recommendation (no code change made): expose the build SHA on the health endpoint.**
Until then, deployed-versus-repository comparison rests on an inference.

## 3.3 The three blockers to merging the branch line

<a id="pr-f-001"></a>
### PR-F-001 (P0) — Migration number collision on `0069`

Both lines define a migration numbered 0069, and they are different migrations:

| Line | File |
|---|---|
| `main` | `0069_company_routing_and_catalogue_department.sql` |
| branch | `0069_durable_inbound_processing.sql` |

`scripts/migrate.mjs` keys the ledger on the **four-character numeric prefix only**:

```js
const version = (f) => f.slice(0, 4);                                   // line 26
create table if not exists schema_migrations (version text primary key, …)  // line 32
const pending = files.filter((f) => !applied.has(version(f)) && …)       // line 38
```

On any database where `main`'s 0069 has been applied, `schema_migrations` contains the
row `version = '0069'`. The branch's `0069_durable_inbound_processing.sql` is then
**filtered out of `pending` and silently skipped** — not reported, not failed. Every
subsequent migration 0070–0109 would then execute against a schema missing the durable
inbound processing objects that several of them depend on.

**This is a silent-corruption path, not a merge conflict.** It fails closed nowhere.
It must be resolved before any merge, by renumbering the branch's 0069–0109 above the
deployed high-water mark and reconciling the ledger.

<a id="pr-f-002"></a>
### PR-F-002 (P0) — The branch line would regress production

Four files exist **only on `main`** and are absent from the branch:

| File | What it fixes |
|---|---|
| `src/db/migrations/0069_company_routing_and_catalogue_department.sql` | de-hardcodes company, department and currency routing |
| `src/lib/scheduler.ts` | the in-process scheduler — without it **nothing is scheduled** on a persistent host |
| `src/lib/whatsapp-inbound.ts` | inbound company resolution from the receiving business number |
| (change in `src/lib/supabase/server.ts`) | forces `cache: "no-store"` on Supabase server reads |

The `no-store` fix is worth stating in full, because it was found **in production on
2026-09-01** and its absence from the branch is a live regression risk. Next.js patches
global `fetch` and caches GETs in its Data Cache; every Supabase REST read is a GET.
The observed symptoms were a permanently wrong `/api/health` (`outboxFailed=1` against
an empty table) and — more seriously — `wa_conversations.state` reading back as `{}` on
every conversational turn, discarding merged customer name and address. That is the
documented second root cause of the "asked my name twice" defect.

The branch has `grep -c no-store src/lib/supabase/server.ts` → **0**. Merging the
branch as it stands reintroduces that bug.

Similarly, the branch still contains at `src/lib/quotations.ts:215`:

```ts
const awaitingPrice = await priceQuotation(input.companyId, quote.id, input.routeDepartment ?? "sales", client);
```

`main` removed exactly this fallback (its 0069 commit names `routeDepartment ?? "sales"`
as defect 2 of 3: *"every price confirmation was routed to sales"*). The branch would
put it back.

<a id="pr-f-003"></a>
### PR-F-003 (P0) — Two incompatible solutions to inbound company resolution

Both lines independently fixed the same critical defect — a compiled-in
`DEFAULT_COMPANY_ID` that attributed **every** inbound WhatsApp message to one hardcoded
company UUID, which is the cross-company leakage failure `CLAUDE.md` classifies as
critical. They fixed it in **different, mutually incompatible ways**:

| | `main` | branch |
|---|---|---|
| Mechanism | `companies.whatsapp_phone_number_id` maps the receiving Meta business number to a company | `channel_accounts` + `channel_identities` + the `resolve_channel_company` RPC |
| Migrations | 0069 (main) | 0070, 0074 |
| Code | `src/lib/whatsapp-inbound.ts`, `src/lib/order-intake.ts` | `src/lib/inbound/*`, adapters, dispatch state machine |
| Generality | WhatsApp-specific | channel-agnostic (designed for email, upload, bank file) |
| Deployed | **yes** | no |

The branch's design is the better long-term fit for an AI Management OS, because the
target architecture requires many inbound channels, not one. But **`main`'s design is
the one carrying live customer traffic and live data.** Reconciliation requires a
deliberate choice plus a data migration mapping existing `companies.whatsapp_phone_number_id`
values into `channel_accounts`. This is owner decision **D-2**.

## 3.4 The scheduling split — a compounding operational defect

This deserves separate statement because it is the mechanism by which PR-F-005 hurts.

| | Vercel | Railway |
|---|---|---|
| Receives the Meta webhook | **yes** | no |
| `vercel.json` crons | **`heartbeat` only**, daily at 07:00 | n/a |
| In-process scheduler (`IN_PROCESS_CRON=on`) | **off** (deliberately — "so Vercel, CI and tests are unaffected") | on |
| Therefore runs `outbox` drain | **never, automatically** | every 1 min |
| Therefore runs `follow-ups` | **never** | every 15 min |
| Therefore runs `ai-monitor` | **never** | every 1 hour |
| Therefore runs `daily-digest` | **never** | every 24 h |

The host that receives customer messages schedules nothing except a daily heartbeat.
The host that schedules everything receives no customer messages.

`main`'s own commit message records the consequence already observed in production:
*"on 2026-09-01 a real customer reply sat in `message_outbox` at `status=failed` and was
delivered only because an operator triggered the drain by hand."* The in-process
scheduler was written to fix precisely this — and it is running on the wrong host.

Note also that `ai-monitor` is the **only** automated trigger of the management loop.
While the webhook stays on Vercel, the AI manager does not run on a schedule at all;
it runs only when a human presses Analyse.

**This is fixed by an owner action (repoint the webhook to Railway) plus verification,
not by new code.** See [11-OWNER-DECISIONS.md](11-OWNER-DECISIONS.md) D-1.

## 3.5 What the branch line contributes that main lacks

For balance — the 234 commits are not waste. Branch-only, undeployed:

- **41 migrations (0070–0109)**: durable inbound processing with leases and
  dead-letter; channel identity resolution; task identity dedup, routing state and
  escalation chains; inbound review queue; owner configuration surface; caller trust
  boundary; duplicate review resolution; model-gateway telemetry and budget policy;
  risk register; insurance register; integration gateway; management directives and
  conflict/escalation handling; commitments and expected payments; service-provider
  registry; counterparty compliance; communication preferences; funding requirements
  and investments; incidents and statutory obligations; project risks, decisions and
  scenarios; push subscriptions; bounded user text.
- **The spatial workspace** (21 components).
- **The provider-neutral model gateway** with budget policy and failover.
- **The hard-scenario verification harness** and a much larger test suite.

The recovery must carry these forward — renumbered, reconciled and rebased on main's
production fixes. It must not discard them, and it must not merge them as they stand.
