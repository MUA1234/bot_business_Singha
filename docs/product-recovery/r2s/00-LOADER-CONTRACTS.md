# Loader contract inventory — all twelve domains

Every contract below is verified against the live disposable PostgreSQL by two permanent gates
(`scripts/r1/check-loader-columns.mjs`, `scripts/r1/check-loader-types.mjs`) and proven
behaviourally end to end by `tests/integration/r2s-loader-contract.test.ts`.

**Every loader is company-scoped by `.eq("company_id", companyId)` and bounded at 500 rows.** No
loader joins across tables, so duplicate rows from a join are structurally impossible. The company
id comes from the authorised server session, never from a request.

## Legend

`ISO` = normalised to an ISO instant (`iso`) · `DAY` = normalised to `YYYY-MM-DD` from **local**
components (`isoDate`, see R2S-F-007) · `DEC` = exact `Decimal`.

---

| # | Domain | Table(s) | Selected columns → detector field | Freshness anchor | Resolved / stale rule |
|---|---|---|---|---|---|
| 1 | **finance** | `customer_invoices` + `payment_allocations` | `id`→`id`; `due_date`→`due_date` **DAY**; `total_amount − amount_settled`→`outstanding` **DEC**; `currency`→`currency` (default LKR); `status`→`status` | **last `payment_allocations.created_at`** for that invoice **ISO**, else `null` | `paid`/`cancelled`/`credited` resolved; outstanding ≤ 0 resolved |
| 2 | **workforce** | `capacity_snapshots` | `id`→`snapshotId`; `membership_id`→`membershipId`; `utilization_pct`→`utilizationPct`; `status`→`status`; `created_at`→`capturedAt` **ISO**; `week_start` used for ordering only | `created_at` **ISO** — a SAMPLE, so staleness genuinely applies | **latest `week_start` per membership only**; older weeks are history |
| 3 | **operations** | `tasks` | `id`, `title`*, `status`, `due_date`→`dueDate` **DAY**, `estimate_hours`, `updated_at`→`updatedAt`/`lastCheckInAt` **ISO** | `updated_at` **ISO** | terminal task statuses resolved |
| 4 | **crm** | `wa_conversations` + `wa_messages` | `id`, `last_inbound_at` **ISO**, `status`; **outbound derived** from `max(wa_messages.created_at) where direction='outbound'` **ISO** | `last_inbound_at` | `closed` resolved; **`message_outbox` is never consulted — a draft or failed send is not a sent message** |
| 5 | **system** | `message_outbox` | `status`, `created_at` → aggregate counts | `sampledAt` (now) — a SAMPLE | n/a; a probe, not a row list |
| 6 | **governance** | `management_directives` | `id`, `status`, `response_required_by` **ISO**, `escalation_chain`, `escalation_level`, `acknowledged_at` **ISO**, `updated_at`→`updatedAt` **ISO** | `updated_at` **ISO** | `closed`/`acknowledged` resolved |
| 7 | **objectives** | `objectives` | `id`, `target_value`, `current_value`, `period_start`/`period_end` **DAY**, `status` | **`null` (unknown)** — no update column exists | `done`/`achieved`/`closed`/`cancelled`/`abandoned` resolved; ended period skipped |
| 8 | **marketing** | `campaigns` | `id`, `status`, `audience_id`, `sent_count`, `created_at` **ISO** | **`null` (unknown)** — `created_at` is the stall MEASURE | `completed`/`sent`/`cancelled`/`archived`/`closed` resolved |
| 9 | **procurement** | `inventory_items` | `id`, `quantity_on_hand`, `reorder_level`, `created_at` **ISO** | detector-supplied | above reorder level = resolved |
| 10 | **assets** | `vehicle_documents` | `id`, `vehicle_id`, `doc_type`, `expiry_date` **DAY**, `created_at` **ISO** | **`null` (unknown)** — a stored date does not decay | not expiring = no observation |
| 11 | **legal** | `licences`, `contracts`, `insurances`, `obligations` | each → `{id, kind, due_date` **DAY**`, status}` | **`null` (unknown)** | `closed`/`cancelled`/`superseded`/`renewed`/`completed`/`archived` resolved |
| 12 | **providers** | `service_providers` | `id`, `status`, `compliance_status`, `insurance_status`, `insurance_expiry` **DAY**, `updated_at` **ISO** | **`null` (unknown)** | `archived`/`terminated`/`inactive` resolved |

\* `tasks.title` is loaded because the detector's type requires it. The **adapter copies it
nowhere** — it never reaches an observation, asserted by the malicious-text test.

---

## The freshness principle

`ingest` skips a `stale` observation that has no existing item, on the sound reasoning that
acting on month-old evidence without re-reading it produces confidently wrong instructions.

**That reasoning holds only for a SAMPLED MEASUREMENT whose value decays** — a capacity snapshot,
a health probe. A condition derived from a stored **date or status** that the loader re-reads
**every cycle** does not decay: the expiry either has passed or it has not, and the row was read
moments ago.

Five adapters previously anchored freshness to a due date, an expiry date or a window start.
That conflated *"the record is old"* with *"our information is old"*, and because `freshnessFor`
then returned `stale`, **the longest-overdue conditions were the ones most reliably discarded**
(defect R2S-F-006). Where no genuine update timestamp exists the honest answer is `null`, which
`freshnessFor` reads as **unknown** — and unknown neither suppresses nor downgrades.

## Units, currency and decimals

- `customer_invoices.total_amount` / `amount_settled` are `numeric(20,4)` and arrive as **strings**.
  The outstanding balance is computed with `Decimal`, never a JS float (R2S-F-002).
- `currency` is `char(3)`, defaulted to `LKR` only when absent. **No conversion is ever applied**
  anywhere in the kernel.
- `capacity_snapshots.utilization_pct` is `numeric(6,2)` — a **percentage**, not a fraction.
- `inventory_items.quantity_on_hand` / `reorder_level` are counts in the item's own unit; the
  detector compares them to each other only, so no unit conversion arises.

## Timestamp meanings, stated

| Column | What it actually means |
|---|---|
| `customer_invoices.created_at` | when the invoice ROW was written — **not** when the invoice changed |
| `payment_allocations.created_at` | when money was applied to an invoice — genuine mutation evidence |
| `capacity_snapshots.week_start` | the week the reading DESCRIBES |
| `capacity_snapshots.created_at` | when the reading was TAKEN — the freshness anchor |
| `campaigns.created_at` | when the campaign was created — the stall measure, not evidence age |
| `objectives.period_start` | when the measurement window OPENED |
| `wa_messages.created_at` | when a message existed on the conversation |
| `service_providers.updated_at` | when the provider record was last maintained |

## Nullability and unknown values

Every loader returns `null` rather than a substitute for an absent or unreadable temporal value.
`freshnessFor(null)` is **unknown**, which is honest and also the safe reading:
`priorityFor(warn, unknown)` is `high`, not the `normal` that `stale` would produce.

## What is NOT covered

- **Task-level completion timestamps** (F-R2B-1): `tasks` has no `completed_at`, `verified_at` or
  `verified_by`, so on-time performance is not computable at task level. Recorded as a schema gap.
- **Incremental cursors**: every loader is a FULL SCAN of up to 500 company-scoped rows each
  cycle. Mutations are therefore observed without any cursor — but a company with more than 500
  rows in one domain would have the remainder unread, and nothing currently reports that.
