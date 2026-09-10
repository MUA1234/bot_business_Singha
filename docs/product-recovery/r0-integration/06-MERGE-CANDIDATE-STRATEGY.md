# Merge-candidate strategy

**Nothing in this document is authorised to execute.** It is the plan that becomes
actionable once the hosted read-only facts are returned. No merge, no rebase, no
renumbering, no deployment.

## Governing constraint: do not destructively rebase

The recovery line is **324 commits**. Rebasing it onto `main` would rewrite all 324, break
every existing SHA reference in `docs/product-recovery/` and `docs/autonomy/`, and force
the 41-migration reconciliation to be resolved commit-by-commit through hundreds of
conflicts. The audit trail those commits carry — the R1/R2/R5 checkpoints, the mutation
verdicts, the corrections ledgers — is itself a deliverable.

**The recovery branch is preserved unchanged as the historical record.** The merge
candidate is a *new* branch built forward from `origin/main`.

```
origin/main ─────●──────────────────────▶  (untouched, deployed line)
                 │
                 └──▶ claude/merge-candidate-r0   (new; built forward)
                          ▲
                          │ content imported deliberately, in reviewed slices
                          │
claude/product-recovery-r1 ●─────────────▶  (preserved unchanged, never rebased)
```

---

## Phase 0 — preconditions (all must hold before Phase 1 opens)

| # | Precondition | Status |
|---|---|---|
| 0.1 | Hosted checklist Q1–Q9 returned in writing and recorded here | **outstanding** |
| 0.2 | Railway checklist R1–R6 returned in writing | **outstanding** |
| 0.3 | Decision-tree case identified from that evidence (A, B, C or D) | **blocked on 0.1** |
| 0.4 | If not Case A: stop and re-plan; this document assumes A | **blocked on 0.3** |
| 0.5 | Owner approves the specific numbered migration plan in writing | **blocked on 0.3** |
| 0.6 | Independent Codex review of this R0 integration-prep package | **outstanding** |

Phase 0 is where this work currently stops.

---

## Phase 1 — the branch, and migration reconciliation

Branch `claude/merge-candidate-r0` from the latest `origin/main`.

1. **Retain `main`'s 0069** unchanged.
2. **Shift the branch's 0069–0109 → 0070–0110**, in dependency order, offset calculated
   from the **proven** hosted high-water mark (§CASE A of the decision tree). Every file
   moves; no file is renamed in isolation.
3. Update every in-repo reference to a shifted number — migration headers cross-reference
   each other by number, and `docs/architecture-v2/MIGRATION_STATE.md` must be rewritten
   rather than patched.
4. `npm run migration-collision-check` must pass against `origin/main`.
5. `npm run migration-lint` must report 0001–0110, no gaps.

**Gate:** fresh-database migration test — shim, then all 110, then the full integration
suite. Rehearsed green for the Case A hypothesis; must be re-run on the real plan.

---

## Phase 2 — main-only production fixes

Port each disposition from
[`05-MAIN-REGRESSION-RECONCILIATION.md`](05-MAIN-REGRESSION-RECONCILIATION.md). Because
the candidate is built **from** `main`, these arrive automatically — Phase 2's real work is
ensuring the imported recovery content does not overwrite them.

| Item | Action |
|---|---|
| `scheduler.ts` + `instrumentation.ts` | inherited from `main`; extend `DEFAULT_JOBS` with `inbound-sweeper`, `dispatch-drain`, `directive-escalation` |
| `supabase/server.ts` `no-store` | inherited; assert with a test |
| quotation department routing | inherited; assert no `"sales"` default returns |
| quotation currency | inherited; assert `companies.base_currency` is read |
| `vercel.json` | reduce to **no crons** |

**Gate:** the six regression guards listed at the end of document 05 exist and pass.

---

## Phase 3 — recovery functionality, in reviewed slices

Import recovery content as deliberate slices, each independently reviewable, each with its
migrations already renumbered by Phase 1. Suggested order, dependency-first:

1. durable inbound processing (branch 0069 → 0070, plus 0076/0077 corrections)
2. channel identity + company resolution (0070–0074 → 0071–0075)
3. inbound review queue and boundary corrections (0075–0090 → 0076–0091)
4. model-gateway telemetry and budget policy (0091–0092 → 0092–0093)
5. registers: risk, insurance, service providers, compliance (0093–0102 → 0094–0103)
6. directives, escalation, commitments (0096–0100 → 0097–0101)
7. remaining surfaces (0103–0109 → 0104–0110)

**Not in scope for this candidate:** the R1/R2/R5 management kernel in
`src/db/draft-migrations-r1/`. It stays quarantined under owner decision R1-D-1 and takes
production numbers as a **separate** decision, after this reconciliation lands.

**Gate per slice:** unit + integration green; independent review; no slice merged that
reintroduces a Phase 2 regression.

---

## Phase 4 — one canonical design each

| Concern | Canonical | Retired / demoted |
|---|---|---|
| Company resolution | `channel_accounts` + `resolve_channel_company` (owner decision 3) | `companies.whatsapp_phone_number_id` → legacy **backfill source only** (decision 4); not removed |
| Scheduler | Railway in-process `DEFAULT_JOBS` (decisions 1, 2) | Vercel cron → none |
| Application host | Railway (decision 1) | Vercel → preview only |
| Accounting | internal double-entry core | — (QuickBooks already void, D-011) |

The backfill is a **data** step with its own production-boundary approval; see document 05
§6 for its five-step sequence.

---

## Phase 5 — RLS, staging-first

Owner decision 5: tenant isolation must be enabled and **proven in isolated staging**
before production.

Current baseline (PR-F-012): `RLS_READS` / `RLS_WRITES` default off; the application reads
and writes through the service-role client, so company isolation rests on application code,
not the database. Hosted check Q8 establishes the true hosted baseline; the reconciled
schema carries **454 policies with RLS enabled on 143 of 147 tables** (measured on the
Rehearsal C database), so the policies largely exist — they are simply not exercised.

1. Stand up an isolated staging database from the reconciled migration set.
2. Seed multi-company fixtures.
3. Turn `RLS_READS` on; run the full integration and company-isolation suites.
4. Turn `RLS_WRITES` on; repeat.
5. Prove cross-company reads and writes are refused **by the database**, with the service
   role no longer the runtime path.
6. Record evidence, then treat production enablement as a separate approval.

**Gate:** cross-company isolation proven at the database boundary, not the application one.

---

## Phase 6 — rehearsals and rollback

| Rehearsal | Method | Status |
|---|---|---|
| Fresh-database migration | disposable PG 16.10; shim → 110 migrations → integration suite | rehearsed for the hypothesis (Rehearsal B/C) |
| Production-ledger-seeded | seed `schema_migrations` from the **actual** Q2 rows, then apply pending | rehearsed for the hypothesis; **must be redone against real ledger rows** |
| Rollback | restore-from-backup drill; verify the app runs against the pre-migration schema | **not yet performed** |
| Failure-mid-sequence | interrupt at a chosen migration; confirm the ledger and schema agree | **not yet performed** |

The rollback rehearsal is the one with no substitute. Rehearsal A demonstrated what an
unplanned failure leaves behind: six migrations committed, the run halted, the ledger
reporting `0075` for a database that is neither line. Recovering from that requires a
restore — so the restore must be proven to work *before* any apply, not after.

**Down-migrations do not exist for the numbered sequence.** Only the quarantined R1 draft
track has `.down.sql` files. Rollback therefore means restore-from-backup, and the drill
must confirm the backup exists, is current, and restores to a schema the deployed code runs
against.

---

## Phase 7 — full gates before the candidate is proposed

| Gate | Command | Current status on the recovery branch |
|---|---|---|
| Format / lint | `npm run lint` | not re-run in this pass |
| Types | `npm run typecheck` | **clean** |
| Unit | `npm test` | **2425 passed, 4 skipped, 0 failed** (226 files) |
| Secret scan | `npm run secret-scan` | **clean** |
| Migration lint | `npm run migration-lint` | **clean** (0001–0109) |
| Migration collision | `npm run migration-collision-check` | **FAILS as designed** — 0069 collision, the finding this work exists to surface |
| Integration / RLS / concurrency | `npm run test:integration` | run locally against a disposable PG 16.10 — see the R0 evidence record for the result |
| Browser | `npm run browser-check` | not run |
| Security review | `/security-review` on the candidate diff | not run |
| Full verify | `npm run verify:merge-candidate` | blocked by the collision gate, correctly |

`verify:merge-candidate` is deliberately a **separate** script from `verify`:
`verify` is what unrelated work runs today and must stay usable, while the collision gate
must fail loudly until the reconciliation lands. Once the candidate exists and the gate
passes on it, fold `migration-collision-check` into `verify` itself and into CI, so no
future branch can reintroduce this class.

---

## What is explicitly NOT in this plan

* Any deployment, or any change to a production configuration.
* Any hosted migration apply, DDL or write.
* Repointing the Meta webhook (a production boundary; see the Railway checklist R5).
* Enabling any `V3_1_*` flag.
* Paid model calls (unauthorised during R0–R3).
* Promoting the R1 draft migrations to production numbers.
* Removing `companies.whatsapp_phone_number_id`.
* Rebasing or force-pushing `claude/product-recovery-r1`.
