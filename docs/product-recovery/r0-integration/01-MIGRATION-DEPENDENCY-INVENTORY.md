# R0 integration prep — migration dependency inventory

**Scope:** read-only analysis and disposable local rehearsal. No hosted contact, no merge,
no rebase, no renumbering of any real migration.

| | |
|---|---|
| Head | `claude/product-recovery-r1` @ `0c789d366023eca05a418348cc07923672651428` |
| Base | `origin/main` @ `acd9fbec35d3075c8faba1c6bbb9b4aaca1ab164` |
| Working tree | clean at analysis time |
| Machine-readable matrix | [`01-migration-matrix.json`](01-migration-matrix.json) |
| Generator | `npm run migration-inventory` (`scripts/migration-inventory.mjs`) |
| Gate | `npm run migration-collision-check` (`scripts/migration-lint.mjs --base origin/main`) |

The JSON matrix carries, for every migration on both branches: number, filename,
SHA-256 (CRLF-normalised), branch, objects created/altered, dependencies on earlier
migrations, and the later migrations that reference its objects.

---

## 1. The divergence is exactly one migration

| Comparison | Count |
|---|---|
| Versions present on both branches | 69 |
| …byte-identical | **68** (0001–0068) |
| …different content under the same number | **1** (0069) |
| Head-only versions | 40 (0070–0109) |
| Base-only versions | 0 |

**0001–0068 are byte-identical between `main` and the recovery branch.** The entire
migration divergence is one collision plus a clean 40-migration append. This is a much
narrower reconciliation than "324 commits ahead" suggests.

| Version | `origin/main` | `claude/product-recovery-r1` |
|---|---|---|
| 0069 | `0069_company_routing_and_catalogue_department.sql` | `0069_durable_inbound_processing.sql` |

Two entirely different migrations. Not a rename, not an edit — different subject matter.

---

## 2. Do branch 0070–0109 depend on the branch's 0069? **Yes.**

Determined from object references, not filenames or sequence.

The branch's `0069_durable_inbound_processing.sql` defines **16 objects**:

| Kind | Objects |
|---|---|
| Columns on `public.source_events` | `next_attempt_at`, `lease_owner`, `lease_acquired_at`, `lease_expires_at`, `last_error_code`, `dead_lettered_at`, `dead_letter_reason` |
| Functions | `inbound_backoff_seconds`, `claim_source_events`, `complete_source_event`, `fail_source_event`, `source_event_backlog` |
| Indexes | `source_events_eligible_idx`, `source_events_lease_idx`, `source_events_company_status_idx` |
| Constraint | `source_events_status_check` (extends the 0004 status vocabulary with `pending`, `retry_wait`, `completed`) |

**Direct dependants (6):** `0076`, `0077`, `0083`, `0087`, `0088`, `0089`
**Transitive dependants (7):** the above plus `0079`

| Dependant | Reaches 0069 via |
|---|---|
| `0076_inbound_boundary_correction.sql` | `claim_source_events`, `inbound_backoff_seconds`, `source_event_backlog`, and the `lease_*` / `next_attempt_at` / `last_error_code` columns |
| `0077_inbound_boundary_correction_2.sql` | `claim_source_events`, `lease_*`, `next_attempt_at` |
| `0083_loop2_corrections.sql` | `lease_expires_at` |
| `0087_duplicate_review_resolution.sql` | `claim_source_events`, `lease_*`, `next_attempt_at` |
| `0088_duplicate_review_boundary_corrections.sql` | `complete_source_event`, `fail_source_event`, `dead_lettered_at`, `dead_letter_reason`, `lease_*` |
| `0089_duplicate_review_sibling_and_budget.sql` | `fail_source_event`, `dead_lettered_at`, `dead_letter_reason`, `lease_*` |

Verified by hand as well as by tool: `claim_source_events` is first defined in 0069 and
`create or replace`d in 0076; 0076 also carries the comment *"separate from the consumer
processing lifecycle that 0069 governs"* — the branch's own text acknowledges the edge.

**This is why the proposed single-file rename of 0069 → 0110 was correctly refused.**
Moving 0069 to the end of the sequence would place it *after* all six of its dependants.
The gate now refuses that plan mechanically (`RENUMBER_BREAKS_DEPENDENCY_ORDER`).

---

## 3. What the runner would actually do — proven, not inferred

Rehearsed on a **disposable local PostgreSQL 16.10 container**, never on hosted state.

### Rehearsal A — branch applied over a ledger seeded with `main` 0001–0069

This models the hypothesis that production has `main`'s 0069 applied. It is a hypothesis,
not an established fact — see [`03-HOSTED-STATE-CHECKLIST.md`](03-HOSTED-STATE-CHECKLIST.md).

```
ledger seeded: 69 rows, version 0069 = 0069_company_routing_and_catalogue_department.sql
apply branch:  ✅ 0070 … ✅ 0075   (6 migrations COMMITTED)
               ❌ 0076_inbound_boundary_correction.sql
                  → column "next_attempt_at" does not exist
```

**Resulting state — verified by catalogue query:**

| Check | Result |
|---|---|
| Ledger high-water | `0075`, 75 rows |
| Branch-0069 columns on `source_events` | **absent** |
| Branch-0069 functions | **absent** |
| Main-0069 objects (`companies.whatsapp_phone_number_id`) | present |

### Correction to the earlier characterisation

An earlier report in this recovery line (and my own first summary) said 0070–0109 "would
then run against a schema missing its objects", implying the whole sequence proceeds
silently. **That is not what happens, and the difference matters.**

What actually happens: the branch's 0069 is silently skipped, **six migrations (0070–0075)
apply and commit**, and the run then **halts loudly** at 0076. Each migration runs in its
own transaction, so the six are durable. The database is left **partially migrated** —
carrying `main`'s 0069 line, six migrations of the branch's line, and neither line's
inbound-processing objects. It is not `main`'s schema and not the branch's schema, and the
ledger reports `0075` as if that were a coherent state.

So the failure is *loud but not clean*: it does not corrupt data silently, and it does
leave a database that no forward path expects. Recovery from that state requires a
restore or a hand-written repair, which is why the collision must be resolved before any
apply, not discovered during one.

### Rehearsal B — branch alone on a fresh database

```
fresh database + supabase shim + branch 0001–0109 → Applied 109 migration(s). ✅
```

The branch line is internally consistent. The defect is purely the collision with an
already-recorded `0069`.

### Rehearsal C — the candidate reconciliation (see the decision tree)

Retain `main` 0069; shift the branch's 0069–0109 up by one to 0070–0110, preserving order.

```
ledger seeded: main 0001–0069  (69 rows)
apply shifted candidate:        Applied 41 migration(s). ✅
ledger high-water:              0110, 110 rows
```

Both lineages' objects coexist afterwards, verified by catalogue query:

| Object | Present |
|---|---|
| `companies.whatsapp_phone_number_id` (main 0069 — legacy backfill source) | ✅ |
| `source_events.next_attempt_at` / `lease_owner` / `dead_lettered_at` (branch 0069) | ✅ |
| `claim_source_events`, `fail_source_event` (branch 0069) | ✅ |
| `channel_accounts` table, `resolve_channel_company` function (branch 0074 — canonical design) | ✅ |

This is a rehearsal of a **candidate**, staged in a temporary directory. **No real
migration file was renumbered**, and the mapping is not final until the hosted read-only
results are supplied.

---

## 4. A separate, quarantined migration track

`src/db/draft-migrations-r1/` holds **28 draft units** applied only by
`scripts/r1/draft-migrate.mjs`, recorded in `r1_draft_migrations`, never in
`schema_migrations`. The runner refuses any non-loopback `DATABASE_URL` and requires
`R1_DRAFT_CONFIRM=disposable-local-only`.

Its header records the reason: **owner decision R1-D-1 — the R1 kernel tables may not take
production migration numbers while the 0069 collision and the unknown hosted state are
unresolved.**

Two consequences for planning:

1. The R1/R2/R5 management-kernel tables are **not** in the numbered sequence and are not
   part of the 0069 reconciliation. They are a later, separate numbering decision.
2. The integration suite needs both tracks applied. Migrations alone leave
   `management_kernel_enablement` and its siblings missing.

---

## 5. Method and its limits

Dependency edges come from a conservative DDL scan (`scripts/lib/migration-graph.mjs`):
comments stripped with string/dollar-quote awareness, function bodies retained as code,
and a column reference credited only when its owning table is also named.

**An absent edge means "no dependency proven", never "proven independent."** The tool is
tuned so a missed edge is possible and a fabricated edge is unlikely. Every edge asserted
in §2 was additionally confirmed by direct inspection of the SQL, and the end-to-end
consequence was confirmed by execution in Rehearsal A.
