# Release 1 integration reconciliation — `claude/release-1-integrated-candidate`

`origin/main` moved. This branch integrates it, reconciles the migration sequences, and reports
what that exposed.

Nothing hosted was written. No migration was applied anywhere but disposable databases. No
deployment happened. **Maximum verdict claimed: READY FOR STAGING.**

---

## 1. What was integrated

| | |
|---|---|
| `origin/main` at fetch | `fd41d30a` — verified, not assumed: fetched, SHA recorded, and the commits between the previous base and it audited |
| commits taken | 3, across 28 files |
| new migrations on main | exactly **1** (`0070_identity_backfill_and_event_lifecycle.sql`) — counted from the fetched tree, not inferred |
| candidate base | `94abe45db3b2f9d12222cfbb6524c93ef47df690` |
| preserved untouched | `origin/main`, `claude/product-recovery-r1`, `claude/product-recovery-deploy-candidate` |
| new branch | `claude/release-1-integrated-candidate` |

The requirement said not to assume only one new migration existed. One was what the fetched tree
contained.

## 2. The sequence shift

Main keeps `0070`. The candidate's own sequence moved up by one, as a single dependency-preserving
unit: **73 files, `0070`–`0142` → `0071`–`0143`**, renamed high-to-low so two files never briefly
shared a number, with `src/db/rollback/` moved in lockstep.

The dependency analyser ran **before and after: 0 ordering violations both times.**

Filename-shaped references were rewritten repo-wide. Bare prose numbers were not — "migration
0070" now means main's file on one line and the candidate's on another, and guessing is how a
record becomes wrong. `docs/release-1/candidate-sequence-shift-map.json` holds the full map.

Two documents describing the collision were corrupted by an early automated rewrite and were
rebuilt by hand; the tool now carries an explicit skip list for records about renumbering.

## 3. Main's manually-applied `0070`

Production has ledger high-water `0069`, `0070`'s effects already applied over REST, and no `0070`
ledger row.

**Verdict: safely idempotent, a clean no-op against the repaired rows. Let the runner apply it.
Do NOT hand-insert a ledger row.** Rehearsed against the exact reported production shape
(scenario 4), not read off the SQL. Full analysis, read-only predicates, expected state, per-
statement idempotency, risks of each option, rollback requirements and the approvals still
required: [MAIN-0070-RECONCILIATION.md](MAIN-0070-RECONCILIATION.md).

One thing stated rather than glossed: re-running is a no-op with respect to *the rows already
repaired*, not with respect to the world. Statements B and C are predicate-defined, so a newly
eligible row would be repaired too. That is the migration doing its job, and it is why "clean
no-op" is a claim about the repaired rows and not a promise that zero rows change.

## 4. Application conflicts

Nine conflicts, each resolved on its merits. Neither side was ever taken wholesale.

| File | Production behaviour from main | Recovery behaviour from candidate | Combined |
|---|---|---|---|
| `api/cron/ai-monitor/route.ts` | `actorId: null` fix | don't stamp on persist failure | both |
| `webhooks/whatsapp/route.ts`, `inngest/functions.ts` | main's routing | canonical-receipt orchestration | candidate's orchestration kept |
| `lib/auth.ts` | `landingPathFor` (unlocked non-admin departments) | `supabaseReadClient` (RLS-governed read) | both |
| `admin/employees/actions.ts` | `provisionEmployeeIdentity` | split read/write clients | main's call on candidate's clients |
| `app/layout.tsx` | `navDepartmentFor` | SpatialShell | both |
| `lib/order-intake.ts` | `companyId?` return field | required `companyId` | both |
| `lib/quotations.ts` | diagnostic | split `client` | main's diagnostic on candidate's client |
| two docs | — | — | both records kept |

## 5. Scheduler ownership — exactly one owner per job

There were **three** declaration sites and the tests compared two. `src/inngest/functions.ts`
declares five cron functions, four of which name work Railway already owns:

| Inngest | cadence | Railway | cadence |
|---|---|---|---|
| `outbox-sweep` | 2 min | `outbox` | 1 min |
| `task-follow-ups` | 15 min | `follow-ups` | 15 min |
| **`ai-manager-monitor`** | **10 min** | **`ai-monitor`** | **1 hour** |
| `management-digest` | daily | `daily-digest` | daily |

Most of that is waste. `ai-manager-monitor` is not: it is the only job that spends money on a
model, the in-process copy honours `MODEL_JOBS=off`, and the Inngest copy honoured nothing and ran
six times more often — so `MODEL_JOBS=off` would have read as "spend stopped" while it continued
every ten minutes.

`inngestJobSuppressed()` now answers one question for both hosts: ownership first (D-021 makes
Railway canonical, so Inngest schedules nothing unless `INNGEST_SCHEDULER=on`), then the same
suppression the in-process scheduler applies. Event-driven Inngest functions are untouched.

**Proved**, in `tests/scheduler-inngest-ownership.test.ts`: for each duplicated job exactly ONE
host would fire it; `MODEL_JOBS=off` refuses the model job on both paths and refuses neither the
outbox nor any recovery job. Non-vacuous — deleting one guard fails three of nine tests.

## 6. Production configuration safety

| Requirement | State | Evidence |
|---|---|---|
| refuses to start when `RLS_READS`/`RLS_WRITES` unspecified | holds | `isolationConfigProblems` refuses on ABSENCE, not only on an unsafe value; `assertProductionConfig` throws; `tests/isolation-config.test.ts` |
| model jobs disable independently of outbox/recovery | holds | `MODEL_JOBS=off` suppresses only `kind: "model"`; outbox, dispatch-drain, inbound-sweeper, directive-escalation, management-cycle all still scheduled |
| exactly one job is model spend | holds | `ai-monitor`, asserted as an exact list |
| execution disabled by default | holds | `EXECUTION_ENABLED` must equal `"on"`; the server-side `r1_exec_global_boundary` row defaults false; both required |
| enabling requires explicit configuration | holds | a server variable AND a database row; no `NEXT_PUBLIC_` form exists |
| no client can invoke service-only execution | holds | 12 hostile attempts, whole-schema digest unchanged; every `r1_exec_*` refused with `permission denied` |
| only the canonical action is eligible | holds | `ExecutionHandlerKey` is a single-member union; `r1_exec_create_internal_task` is the only handler |

No production value was set, anywhere.

## 7. What the integration exposed

Eleven defects. **None is a regression from this integration** — every one predates it and was
invisible because of where it lived or which question no gate had asked.

| # | Finding | Severity | Closed by |
|---|---|---|---|
| 1 | **Any signed-in user could grant themselves any permission, and forge a migration ledger row** | **Critical** | `0145` |
| 2 | The Ask-AI retention purge was callable by any signed-in user, across all companies | High | `0144` |
| 3 | `management_task_idempotency`: RLS off, full DML for `authenticated` | High | `0144` |
| 4 | 38 promoted functions carried a non-canonical `search_path` | Medium | source, 30 files |
| 5 | 17 worker-only tables kept write GRANTS behind RLS | Medium | `0144` |
| 6 | 28 kernel trigger functions executable by `anon` | Low | `0144` |
| 7 | `skill_record_events` tenant-integrity gap | Medium | `0146` |
| 8 | 23 migrations self-committed, breaking runner atomicity | Medium | 22 files (main's `0070` deliberately excepted) |
| 9 | The hard-scenario campaign skipped 93 of 120 tests and reported success | **High (test integrity)** | `run.sh`, self-check |
| 10 | Two migration attacks had stopped attacking | High (test integrity) | derived, not hardcoded |
| 11 | A suite leaked one orphan profile per run | Medium (test integrity) | teardown |

Details: [PROMOTION-BOUNDARY-FINDINGS.md](PROMOTION-BOUNDARY-FINDINGS.md).

### The critical one, stated plainly

Against the hard-scenario stack — real GoTrue, real PostgREST, real RLS — a genuine token for the
**lowest-privilege** fixture user:

```
POST /rest/v1/role_permissions
{"role_key":"staff_submitter","permission_key":"admin.organisation.manage"}   → HTTP 201
```

After that one request `actor_has_capability(…, 'admin.organisation.manage')` returned **true for
every staff member in both companies**. The capability engine joins `membership_roles` to
`role_permissions` and asks whether a row exists; the attacker supplied the row. There is no
second check to fail.

The same token inserted a `schema_migrations` row for a version that never ran. The runner skips a
recorded version **silently**, so a client could make any future migration never happen.

After `0145`, both requests return **403 / 42501** and the capability stays false.

### Why every gate missed it

`roles`, `permissions`, `role_permissions` and `schema_migrations` have no `company_id`, so the
RLS-coverage gates — which enumerate company-scoped tables — never saw them. The bounded-text and
write-policy gates select tables that *have* a write policy, so "RLS off, no policy" read to them
as "not user-writable", exactly backwards. The SECURITY DEFINER allowlists govern functions, and
this attack needs none.

**Every gate assumed a table was protected by RLS. None asked which tables were not.**
`tests/integration/catalogue-and-ledger-boundary.test.ts` now asks that of every table in `public`.

The same shape recurred twice more: `0143`'s tenant-integrity assertion was true about a
population that excluded `skill_` tables (finding 7), and the hard-scenario runner's per-suite
skip protection was defeated one level above it, where nothing was checking (finding 9). **A
self-verifying gate proves what it looked at, never what it did not.**

## 8. Rehearsals — eight scenarios, 30 checks, all passing

Each on a disposable PostgreSQL 16, reporting starting ledger, starting markers, attempted,
committed, ending high-water, object checks, data-integrity checks and rollback result.

| # | Scenario | Ending high-water |
|---|---|---|
| 1 | fresh database | `0146` |
| 2 | main-only line | `0146` |
| 3 | production ledger before the manual repair | `0146` |
| 4 | **the actual reported production shape** | `0146` |
| 5 | ledger already reconciled | `0146` |
| 6 | interrupted migration, then repaired | `0146` |
| 7 | rollback from snapshot | restored copy back to `0069` |
| 8 | fresh install plus rollback chain | `0146` |

Scenario 4 is the decisive one:

```
defects before the manual repair : profiles_without_users 2, without_membership 2,
                                   suspended_but_active 1, company_authored_tasks 1
after the manual repair          : all 0   — memberships 3, role grants 4, users 3
ledger after the manual repair   : 69 rows, high-water 0069      ← the production shape
release run                      : applied, INCLUDING main's 0070
after the release run            : all 0   — memberships 3, role grants 4, users 3
ending ledger                    : high-water 0146, no duplicates
```

Counts identical before and after: nothing duplicated, nothing corrupted, nothing partial.

## 9. The gate set

Every campaign was proved to DISCOVER tests before its result was believed. A run reporting
"no test files found", or quietly skipping most of its suites, is a failure and not a green
result — which is finding 9, and it had been passing as success.

## 10. What remains open

* **The 102 pre-existing F-009 tenant-integrity gaps on the released chain.** Untouched
  deliberately: they are on tables carrying production data, and bundling them here would make one
  reviewable change into two unreviewable ones. `0143` asserts the count has not GROWN.
* **`0070` is still self-committing.** It is main's file; see §7 finding 8.
* **Two paid Anthropic live-evaluation tests remain skipped.** They are external paid-model
  evaluations and conceal no local integration or security behaviour.
* **Nothing has been verified on staging or production.** Every result here is from disposable
  databases and a local stack.

## 11. Verdict

**READY FOR STAGING.**

Not staging-verified, and not production-ready. No hosted database was read or written, no
deployment occurred, and the production reconciliation in §3 requires its own approval —
specifically including a `pg_dump`-capable path and a *performed* restore, which does not yet
exist.
