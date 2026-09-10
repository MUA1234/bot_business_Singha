# Main-regression reconciliation — read-only conflict analysis

**Read-only.** No file was overwritten, no merge was performed, no implementation was
replaced. Each row records the **intended disposition** for a future merge candidate.

| | |
|---|---|
| Head | `claude/product-recovery-r1` @ `0c789d36` |
| Base | `origin/main` @ `acd9fbec` |
| Divergence | head is 324 commits ahead, 11 behind |

## Disposition vocabulary

| Disposition | Meaning |
|---|---|
| **retain main** | `main`'s implementation is correct; the branch must adopt it as-is |
| **retain recovery** | the branch's implementation is correct and supersedes `main`'s |
| **combine deliberately** | both contain something required; a new merged implementation is written and reviewed |
| **replace after data backfill** | one design wins, but only after the other's data is migrated |
| **blocked pending hosted evidence** | cannot be decided until the read-only hosted results are returned |

---

## Summary table

| # | File / area | Disposition | Owner decision it serves |
|---|---|---|---|
| 1 | `src/lib/scheduler.ts` | **retain main**, then extend | 1, 2 |
| 2 | `src/instrumentation.ts` | **retain main** | 1 |
| 3 | `vercel.json` cron block | **retain main**, reduce further | 2 |
| 4 | `src/lib/supabase/server.ts` (`no-store`) | **retain main** | — |
| 5 | `src/app/api/webhooks/whatsapp/route.ts` | **combine deliberately** | 3 |
| 6 | Company resolution (`whatsapp-inbound.ts` vs `lib/inbound/*`) | **replace after data backfill** | 3, 4 |
| 7 | Quotation department routing | **retain main** | — (CLAUDE.md standing constraint) |
| 8 | Quotation currency default | **retain main** | — |
| 9 | Migration `0069` | **blocked pending hosted evidence** | 6 |

---

## 1. `src/lib/scheduler.ts` — **retain main, then extend**

**State:** 136 lines, **`main` only**. The file does not exist on the recovery branch.

`main` introduced an in-process scheduler for a long-lived Railway process. Its header
records why: the cron endpoints were written for Vercel, whose Hobby plan allows two
schedules at daily granularity, so `vercel.json` scheduled only `heartbeat` and the outbox
drain effectively never ran. That was observed live on 2026-09-01 — a customer reply sat in
`message_outbox` at `status=failed` and was delivered only because an operator triggered
the drain by hand.

Safety properties already built in: off unless `IN_PROCESS_CRON=on`; one run of a job at a
time; failures logged and swallowed; the underlying work concurrency-safe via
`claim_outbox_batch` leasing with `FOR UPDATE SKIP LOCKED`.

`main`'s `DEFAULT_JOBS`:

| Job | Cadence |
|---|---|
| `outbox` | 1 minute |
| `follow-ups` | 15 minutes |
| `ai-monitor` | 1 hour (model calls — deliberately least frequent) |
| `daily-digest` | 24 hours |

**Gap the merge candidate must close.** The recovery branch adds three cron routes that
`DEFAULT_JOBS` does not know about:

| Branch route | Currently driven by | Under owner decisions 1 + 2 |
|---|---|---|
| `/api/cron/inbound-sweeper` | Vercel cron `*/10 * * * *` | must move into `DEFAULT_JOBS` |
| `/api/cron/dispatch-drain` | Vercel cron `*/5 * * * *` | must move into `DEFAULT_JOBS` |
| `/api/cron/directive-escalation` | **nothing** | must be scheduled, or explicitly deferred |

**This is the most consequential finding in this document.** If the branch were deployed to
Railway as it stands — Vercel disabled, no `scheduler.ts` — **nothing would drive the
inbound sweeper or the dispatch drain**. The durable inbound processing that the branch's
0069 exists to provide would never run: messages would be received and never swept,
retried or dead-lettered. The branch's central capability is inert without `main`'s
scheduler plus new entries in its job table.

**Action:** adopt `scheduler.ts` unchanged, then add the three jobs with cadences chosen
and justified, and add a test asserting that every `src/app/api/cron/*` route is either
present in `DEFAULT_JOBS` or on a documented exclusion list — so this class of gap cannot
recur silently.

---

## 2. `src/instrumentation.ts` — **retain main**

`main` (19 lines) calls `assertProductionConfig()`, then — only under
`NEXT_RUNTIME === "nodejs"` — imports and starts the scheduler. Head (10 lines) calls
`assertProductionConfig()` and nothing else.

A pure superset. Adopt `main`'s version verbatim; it is the boot hook that makes item 1
take effect.

---

## 3. `vercel.json` cron block — **retain main, reduce further**

| Branch | Declared crons |
|---|---|
| `main` | `heartbeat` (`0 7 * * *`) |
| recovery | `heartbeat` (`0 7 * * *`), `inbound-sweeper` (`*/10 * * * *`), `dispatch-drain` (`*/5 * * * *`) |

Owner decision 2 forbids Vercel cron coexisting with the Railway scheduler. The branch's
three-cron block is the direct conflict.

**Action:** take `main`'s block, and as part of the merge candidate reduce it to **no crons
at all**, with the schedules living solely in `DEFAULT_JOBS`. Keeping even `heartbeat` on
Vercel leaves a double-run waiting for the day Vercel is re-enabled. Vercel remains
preview-only.

---

## 4. `src/lib/supabase/server.ts` — **retain main**

`main` adds 21 lines: a `noStoreFetch` wrapper forcing `cache: "no-store"` on every request
both Supabase clients make, wired into each client's construction.

Its header records the production observation: after an outbox row was delivered and the
table held zero failed rows, `/api/health` kept reporting `outboxFailed: 1` indefinitely —
still wrong 90 seconds later, across separate deployments and cache-busted URLs — driving
the overall level to `crit`. The same cache sits under every dashboard read, so a
department page could show stale data with no sign anything was wrong.

A small, self-contained addition with no counterpart on the branch and no conflict with
branch logic. Port verbatim.

---

## 5. `src/app/api/webhooks/whatsapp/route.ts` — **combine deliberately**

| | `main` | recovery |
|---|---|---|
| Lines | 123 | 152 |
| Company resolution | carries `phone_number_id` through; resolves via `companies.whatsapp_phone_number_id` (0069) | delegates to `src/lib/inbound/company-resolution.ts` → `resolve_channel_company` (0074) |
| Durability | acknowledges and processes | writes a durable `source_events` receipt for the sweeper (branch 0069) |

Both branches rewrote the same handler to fix the same original defect (a hardcoded
`DEFAULT_COMPANY_ID`), by different means. Neither is a superset.

**Action:** write a new handler that keeps the branch's durable-receipt structure and its
fail-closed resolution boundary, resolving the company through the canonical
`resolve_channel_company` path (item 6). Review it as new code, not as a merge artifact —
this is the single most security-sensitive request path in the system, and a mechanical
merge of two rewrites is exactly how a cross-company leak gets introduced.

---

## 6. Company resolution — **replace after data backfill**

| | `main` | recovery |
|---|---|---|
| Mechanism | `companies.whatsapp_phone_number_id` (unique partial index, migration 0069) | `channel_accounts` + `resolve_channel_company()` (migration 0075) |
| Location of the mapping | a column on `companies` | auditable configuration rows, resolved in the database |
| Ambiguity handling | one number → one company by unique index | typed `CompanyMatch`: `exact`, `single_tenant_fallback`, `unmapped`, `ambiguous`, `empty`, `lookup_error` |
| Failure behaviour | — | **fail-closed**: only `exact` and `single_tenant_fallback` may carry a message into business processing |

**Owner decision 3 selects the branch's design as canonical.** It is also the one that
satisfies the CLAUDE.md standing constraint *"never silently default an unresolved inbound
message to Sales or to any company"* — `unmapped` and `ambiguous` are explicit,
non-dispatchable outcomes rather than a fallback.

**Owner decision 4 confines `companies.whatsapp_phone_number_id` to a legacy backfill
source during reconciliation.** Rehearsal C confirmed both coexist on the reconciled schema,
so the backfill is mechanically possible: read the existing column, write `channel_accounts`
rows.

**Sequenced action:**

1. Retain `main`'s 0069 column (it is already applied under the Case A hypothesis).
2. Backfill `channel_accounts` from every non-null `companies.whatsapp_phone_number_id`.
   Hosted check Q5b counts how many rows that is.
3. Verify each mapping resolves `exact` through `resolve_channel_company`.
4. Cut the runtime over to the canonical path.
5. Only then consider retiring the column — a separate, later decision. It stays as
   evidence and rollback until the cutover is proven.

Steps 2–5 touch production data and are **each** a separate production-boundary approval.

---

## 7. Quotation department routing — **retain main**

**A live regression on the branch.**

`src/lib/quotations.ts` on the recovery branch, at two sites:

```
215:  const awaitingPrice = await priceQuotation(input.companyId, quote.id, input.routeDepartment ?? "sales", client);
227:    routeDepartment = "sales",            // default parameter of priceQuotation
```

`main` passes `input.routeDepartment` through and resolves the department from data: the
matched catalogue product's `department`, else the company's
`default_price_confirmation_department`, else `sales`.

The branch's `?? "sales"` sends **every** price confirmation to Sales regardless of what
was ordered — the exact defect `main`'s 0069 removed, and a direct violation of the
CLAUDE.md standing constraint against silently defaulting to Sales.

**Action:** adopt `main`'s call site and signature. Note the dependency: the data-driven
resolution needs `main`'s 0069 columns, which the Case A reconciliation retains.

---

## 8. Quotation currency default — **retain main**

Also branch-only, same file:

```
170:  const currency = (input.currency ?? "LKR").toUpperCase().slice(0, 3);
```

`main`:

```
103:  const currency = (input.currency ?? (await companyBaseCurrency(db, input.companyId)) ?? "LKR")
```

`main` reads `companies.base_currency` and keeps the literal only as last-resort defence.
The branch hardcodes it, so a company whose base currency is not LKR would be quoted in the
wrong currency.

This matters more than it looks: migration 0067's enqueue guard requires each quotation
item's currency to equal the locked quotation currency, or the quotation never sends. A
wrong default here becomes a silent delivery failure downstream.

**Action:** adopt `main`'s currency resolution and `companyBaseCurrency` helper.

---

## 9. Migration `0069` — **blocked pending hosted evidence**

See [`02-MIGRATION-DECISION-TREE.md`](02-MIGRATION-DECISION-TREE.md). Under Case A the
disposition becomes "retain main 0069, shift the branch sequence +1", already rehearsed.
It is not final until the hosted results are returned.

---

## Regression-guard tests the merge candidate must carry

Dispositions decay unless something enforces them. Each of these fails if the corresponding
regression returns:

| Guard | Asserts |
|---|---|
| department routing | no `?? "sales"` / `= "sales"` default survives in the quotation path; routing resolves from catalogue then company default |
| currency | quotation currency comes from `companies.base_currency` when the caller gives none |
| scheduler coverage | every `src/app/api/cron/*` route is in `DEFAULT_JOBS` or a documented exclusion list |
| single scheduler | `vercel.json` declares no cron whose job also appears in `DEFAULT_JOBS` |
| no-store | both Supabase clients are constructed with the `no-store` fetch |
| company resolution | the webhook path reaches `resolve_channel_company`; `unmapped` / `ambiguous` never dispatch |
| migration collision | `npm run migration-collision-check` passes against `origin/main` |

The last one exists and passes its own behavioural tests today
(`tests/migration-collision.test.ts`, 18 tests). The other six are to be written with the
merge candidate.
