# Hosted migration state — measured, 2026-09-10

**CASE A is PROVEN.** Not inferred from deployment history: the ledger and the physical objects
were both read, and they agree.

| | |
|---|---|
| Method | `railway run --service singha-web -- node scripts/hosted/probe.mjs` |
| Endpoint | `gazjughejdzebathpscb.supabase.co` (production Supabase) |
| Operations | `GET` only. Object probes used `limit=0`, so **zero business rows** were returned |
| Rows read | `schema_migrations` only — version, filename, applied_at: deployment metadata |
| Writes / DDL / RPC | **none** |
| Raw evidence | [`evidence/hosted-state-2026-09-10.json`](evidence/hosted-state-2026-09-10.json) |

---

## The ledger

| | |
|---|---|
| `schema_migrations` exists | ✅ yes, readable, 69 rows |
| Lowest | `0001_org_and_access.sql` |
| **High-water** | **`0069` — `0069_company_routing_and_catalogue_department.sql`** |
| Gaps | **none** — contiguous 0001–0069 |
| First applied | 2026-08-06T17:16:35Z |
| Last applied | **2026-09-01T12:10:52Z** (the 0069 row) |

## The objects

| Marker | Present |
|---|---|
| `companies.whatsapp_phone_number_id` (main 0069) | ✅ **PRESENT** |
| `companies.default_price_confirmation_department` (main 0069) | ✅ **PRESENT** |
| `source_events.next_attempt_at` (recovery 0069) | ❌ absent |
| `source_events.lease_owner` (recovery 0069) | ❌ absent |
| `source_events.dead_lettered_at` (recovery 0069) | ❌ absent |
| `channel_accounts`, `channel_identities` (recovery 0071/0075) | ❌ absent |
| Branch-range tables (27 expected by 0070–0110) | ❌ **0 of 27** |
| `r1_draft_migrations`, `management_kernel_enablement`, `management_items` | ❌ absent — **the quarantine held** |

## Classification

**CASE A.** Main marker present, recovery marker absent, ledger agrees with the objects.

* Not Case B — no recovery marker exists anywhere.
* Not Case C — the ledger exists and is complete.
* Not Case D — the two lineages are not both present.
* Not a contradiction — the ledger says 0069 is main's, and main's objects are the ones there.

---

## Two records this corrects

### 1. `MIGRATION_STATE.md` understated the hosted high-water by one

That document records the 2026-09-01 production application as "0048 → 0068, 21 migrations;
ledger now **68**", and has **no row for 0069**. The live ledger holds **69** rows, and the 0069
row is stamped `2026-09-01T12:10:52Z` — the same window, twenty-three minutes before the Railway
deployment at `12:33:59Z`.

So 0069 *was* applied and the record simply stops one short.

### 2. The "production code is ahead of its schema" concern is CLOSED

PR-F-004 asked whether the deployed `main` code required a migration the database did not have —
`src/lib/whatsapp-inbound.ts` resolves the inbound company from
`companies.whatsapp_phone_number_id`, which only 0069 creates. The Release 1 banner in
`MIGRATION_STATE.md` went further and warned that **"if 0069 really is unapplied, inbound company
resolution is broken in production right now."**

It is applied. The column exists. **Production code and schema agree, and that warning is
withdrawn.** It was a correct thing to worry about given the record available at the time, and
the only way to settle it was to read the database.

---

## What this proves about the candidate

The candidate retains `main`'s `0069_company_routing_and_catalogue_department.sql` at 0069 and
shifts the recovery line **+1** to `0070–0110`. The offset was computed as one above both the
`origin/main` high-water (`0069`) and the hosted high-water — and the hosted high-water is now
**measured at `0069`**, not assumed.

`max(0069, 0069) = 0069`, so the first free number is `0070`. **The reconciliation in the
candidate is correct as it stands**, and requires no change.

| | |
|---|---|
| Pending for production | **41 migrations: `0070`–`0110`** |
| Already applied | 0001–0069 |
| Migrations that would be skipped | **none** — no version collides with a recorded one |

The earlier estimate of "42 pending (0069 then 0070–0110)" was one too many: 0069 is already
applied. The correct pending set is exactly the 41 shifted recovery migrations.

---

## Safety of the probe itself

Stated because a read against production deserves it:

* every request was a `GET` against PostgREST;
* object-existence probes used `limit=0` — **no business row was returned by any of them**;
* the only rows returned were `schema_migrations`, which contains migration filenames and
  timestamps and no customer, message, quotation, payment or ledger data;
* no RPC was called, nothing was written, no DDL ran, no migration was applied;
* credentials arrived through `railway run` and were never printed, logged or written to disk —
  the probe reports the endpoint host and the key's character count, nothing more;
* the evidence file committed alongside this document contains ledger rows and booleans only.
