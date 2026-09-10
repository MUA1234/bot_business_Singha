# Migration reconciliation decision tree

**No numbering in this document is final.** Every branch below is conditional on the
read-only hosted results from [`03-HOSTED-STATE-CHECKLIST.md`](03-HOSTED-STATE-CHECKLIST.md).
**Hosted migration state is currently UNKNOWN.** Nothing here authorises a merge, a
renumbering, a migration apply, or any hosted modification.

## The rule that governs every case

A version collision is resolved by **renumbering the whole dependent sequence in order**,
never by renaming one file.

The branch's `0070_durable_inbound_processing.sql` has **6 direct and 7 transitive
dependants** (`0076`, `0077`, `0079`, `0083`, `0087`, `0088`, `0089` — see
[`01-MIGRATION-DEPENDENCY-INVENTORY.md`](01-MIGRATION-DEPENDENCY-INVENTORY.md) §2). Moving
0069 alone to 0110 would place it *after* every one of them. `npm run migration-collision-check`
now refuses such a plan mechanically with `RENUMBER_BREAKS_DEPENDENCY_ORDER`, and
`tests/migration-collision.test.ts` locks that refusal in with a synthetic fixture.

---

## The gate question

**Q4 of the hosted checklist, cross-checked against Q2.** Two independent signals:

* **the record** — what `schema_migrations` says was applied at version `0069`;
* **the reality** — which line's object markers actually exist.

Both are needed. The R0 evidence already records that the authoritative migration-state
document contradicts the deployed code (PR-F-004), so the ledger alone is not sufficient
and the catalogue alone does not tell you what the runner will skip.

```
                       ┌─────────────────────────────────────┐
                       │ Q1: does schema_migrations exist?   │
                       └───────────────┬─────────────────────┘
                             no        │        yes
                    ┌──────────────────┘        └──────────────────┐
                    ▼                                              ▼
                 CASE D                          ┌─────────────────────────────────┐
          (no runner ledger)                     │ Q4: which 0069 is present?      │
                                                 └───────┬─────────────────────────┘
                    ┌────────────────────────────────────┼───────────────────┐
                    ▼                                    ▼                   ▼
       main markers only,                    branch markers          both / neither /
       ledger high-water ≥ 0069                 present                  mixed
                    │                              │                       │
                    ▼                              ▼                       ▼
                 CASE A                         CASE B                  CASE C
```

---

## CASE A — `main`'s 0069 is applied; none of the branch range is present

**Evidence required, all of it:**

* Q2 row at version `0069` names `0069_company_routing_and_catalogue_department.sql`.
* Q4b: `companies.whatsapp_phone_number_id` **present**; `source_events.next_attempt_at`,
  `lease_owner`, `dead_lettered_at` and `claim_source_events` **absent**.
* Q3: high-water is `0069`, with no gaps (Q3b empty).
* Q6: 0 of the 27 branch-range tables present.
* Q6c: the R1 draft track absent.

**Then, and only then:** preserve `main`'s 0069 and shift the complete dependent branch
sequence upward, preserving order.

| From (branch) | To (merge candidate) |
|---|---|
| `0070_durable_inbound_processing.sql` | `0070_durable_inbound_processing.sql` |
| `0071_channel_identity_resolution.sql` | `0071_channel_identity_resolution.sql` |
| … each shifted by exactly **+1**, order preserved … | |
| `0110_bounded_user_text.sql` | `0110_bounded_user_text.sql` |

`main`'s `0069_company_routing_and_catalogue_department.sql` is retained unchanged at 0069.
Result: **110 migrations, 0001–0110, no gaps.**

**Calculate the offset from the proven high-water mark, not from this table.** The +1
shift is correct *iff* Q3 returns high-water `0069`. If Q2/Q3 show the hosted line has
advanced past `0069` — anything the repository does not know about — the offset changes,
and the shift must start above the **proven** high-water mark.

### Status of this case: rehearsed, not authorised

Rehearsed on a disposable PostgreSQL 16.10 container by staging the shift in a temporary
directory. **No real migration file was renumbered.**

```
ledger seeded with main 0001–0069 (69 rows)
apply shifted candidate            → Applied 41 migration(s). ✅
ledger high-water                  → 0110, 110 rows
```

Both lineages' objects coexist afterwards — `companies.whatsapp_phone_number_id` (the
legacy backfill source owner decision 4 preserves) alongside `channel_accounts` and
`resolve_channel_company` (the canonical design owner decision 3 selects).

The same rehearsal, run **without** the shift, reproduces the failure:

```
apply branch unshifted → ✅ 0070…0075 committed, then
                         ❌ 0076 → column "next_attempt_at" does not exist
                         ledger left at 0075: a partially migrated database
```

---

## CASE B — the branch's 0069 is what is present

**Evidence:** `source_events.next_attempt_at` / `lease_owner` / `claim_source_events`
present, and `companies.whatsapp_phone_number_id` absent.

**Meaning:** the hosted database was migrated from the recovery branch line, not from
`main`. That would contradict D-021 and the whole deployment record, and it would mean
`main`'s 0069 fixes are **not** on the database even though `main` is the deployed branch —
so the deployed code would be running against a schema it does not match.

**Action: STOP.** Do not renumber, do not merge, do not apply anything. Report the
contradiction, establish how the branch line reached a hosted database, and re-open the
deployment-provenance question (PR-F-014 / R0-F-007) before any plan is drawn.

---

## CASE C — both present, neither present, or a mixture

**Evidence:** any combination other than A or B, including a Q3b gap list that is not
empty, or Q6 showing some of the 27 branch-range tables present.

**Meaning:** the hosted schema was not produced by a clean run of either line. Possibilities
include hand-applied SQL, a partially failed migration run, a Supabase-dashboard change, a
restored backup, or a third line nobody has recorded.

**Action: STOP.** The offset cannot be calculated from a schema whose history is unknown.
Establish the true state first — the object-level probes in Q4b, Q6 and Q6b are the
starting point, and a full catalogue dump compared against the rehearsal schema is the
next step.

---

## CASE D — no `schema_migrations` table at all

**Meaning:** the runner has never applied a migration to this database. The schema was
created some other way, and `MIGRATION_STATE.md` describes a process that never ran here.

**Action: STOP.** Do not run `npm run migrate` against it and **do not run
`migrate.mjs --baseline`**: baselining marks every current file as applied *without
running it*, which on an unknown schema would permanently record a state that was never
established and destroy the only remaining evidence. Establish provenance first.

---

## What must be true before ANY case proceeds to action

Even under Case A, the numbering decision alone does not authorise anything:

1. The hosted results are supplied in writing and recorded in this directory.
2. `npm run migration-collision-check` passes against `origin/main` on the merge candidate.
3. A fresh-database migration test passes end to end.
4. A production-ledger-seeded rehearsal passes, seeded from the **actual** Q2 ledger rows.
5. A rollback rehearsal is performed and documented.
6. The owner approves the specific numbered plan, in writing, as a separate decision.
7. Applying it to a hosted database is a further, separate production-boundary approval.

Steps 3 and 4 have been rehearsed for the Case A hypothesis on disposable databases. They
must be repeated against the real ledger contents once Q2 is returned, because a rehearsal
seeded from a hypothesis proves only that the hypothesis is self-consistent.

---

## A note on the quarantined R1 draft track

`src/db/draft-migrations-r1/` (28 draft units) is deliberately outside the numbered
sequence under owner decision R1-D-1, precisely because this collision is unresolved.
Those units take production numbers only **after** the 0069 reconciliation lands and as a
**separate** numbering decision. They must never be applied to a hosted database; the
runner enforces this by refusing any non-loopback `DATABASE_URL`.

Hosted check Q6c exists to confirm that quarantine has held.
