# Release 1 — deployment readiness

> **Verdict: READY FOR STAGING is NOT claimed** — see §Verdict for what remains.
> **Nothing has been deployed, merged, or applied to any hosted database.** The one hosted
> operation performed was a SELECT-only probe, which the owner authorised explicitly and which
> proved **CASE A**: [HOSTED-MIGRATION-EVIDENCE.md](HOSTED-MIGRATION-EVIDENCE.md).

| | |
|---|---|
| Candidate branch | `claude/product-recovery-deploy-candidate` |
| Base | `origin/main` @ `acd9fbec35d3075c8faba1c6bbb9b4aaca1ab164` |
| Recovery line integrated | `claude/product-recovery-r1` @ `b3e43b3e4b468482bcbe2be50e8bb881c0436f55` — **preserved unchanged, never rebased** |
| Hosted contact | Railway metadata, and one **SELECT-only** database probe (owner-authorised). No hosted write, DDL, RPC or business-data read. |

---

## Verdict

**Not `READY FOR STAGING`.** Of the three blockers originally recorded, **two are now cleared**; the one that remains is an environment that does not exist and cannot be created without an owner decision.

| # | Blocker | Who clears it |
|---|---|---|
| **B-1** | **No staging environment exists.** `singha-central` has one environment: `production`. The brief forbids silently creating a paid or production-connected one | **Owner** — see [STAGING-REQUIREMENTS.md](STAGING-REQUIREMENTS.md) |
| ~~B-2~~ | ~~Hosted migration state is UNKNOWN~~ — **CLEARED 2026-09-10.** The SELECT-only probe ran. **CASE A proven**: ledger high-water `0069` is main's migration, recovery markers absent, ledger and physical objects agree. The candidate's +1 reconciliation is correct as it stands; pending for production is exactly `0070`–`0110` (41 migrations, none colliding) | — [HOSTED-MIGRATION-EVIDENCE.md](HOSTED-MIGRATION-EVIDENCE.md) |
| ~~B-3~~ | ~~`r1-draft-schema` is broken two ways~~ — **CLEARED.** Both defects fixed at the root; it runs green as its own third campaign, **31 tests**, repeatably, with clean teardown (§D-1) | — |

Everything the brief listed that *can* be done from here has been done and measured. The
migration reconciliation is applied and rehearsed, the deterministic kernel failures are fixed,
the campaigns are isolated and order-independent, `main`'s production fixes are retained, the
lifecycle runs through real composition, company resolution is canonical, Railway is the sole
scheduler, and RLS now fails closed.

---

## Gate results — all at `HEAD` of the candidate

| Gate | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | ✅ clean |
| Unit suite | `npm test` | ✅ **2506 passed**, 4 skipped, **0 failed** (234 files) |
| Build | `npm run build` | ✅ succeeds, all routes compile |
| Lint | `npx next lint` | ✅ no errors (2 pre-existing `<img>` warnings) |
| Secret scan | `npm run secret-scan` | ✅ no tracked secrets |
| Migration lint | `npm run migration-lint` | ✅ 110 migrations, 0001–0110, no gaps |
| **Migration collision** | `npm run migration-collision-check` | ✅ **no collision against `origin/main`** (was 2 errors) |
| Completion inventory | `node scripts/completion-inventory.mjs --check` | ✅ `supabaseAdmin` confined to the allowlist |
| Requirements audit | `node scripts/autonomy/audit-requirements.mjs` | ✅ pass |
| IP boundary | `node scripts/autonomy/check-ip-boundary.mjs` | ✅ pass |
| Dependency audit | `npm run audit-check` | ✅ 2 advisories, both covered by approved exceptions |
| **Core integration** | `npm run test:integration` | ✅ **76 files, 677 tests, 0 failed** — randomised order, draft-free DB |
| **Kernel integration** | `npm run test:kernel` | ✅ **34 files, 644 tests, 0 failed** — randomised order, drafts applied once |
| **Draft-schema campaign** | `npm run test:draft-schema` | ✅ **31 tests, 0 failed** — builds and drops its own database; run twice, clean both times |
| Browser / accessibility | `npm run browser-check` | ⚠️ **not run** — no application server in this environment |

All database work ran on **disposable local PostgreSQL 16.10** in uniquely labelled containers
on OS-assigned ports. No pre-existing container was touched.

### Migration rehearsals

| Scenario | Result |
|---|---|
| Fresh database, candidate 0001–0110 | ✅ 110 applied, then 28 draft units |
| `main`-seeded ledger + the +1 shift | ✅ 41 applied, high-water 0110, both lineages coexist |
| Recovery line **unshifted** over a `main`-seeded ledger | ❌ halts at old-0076, partial migration at 0075 — the defect the shift removes |
| **Production-ledger-shaped** — the real 69-row ledger, filenames and all | ✅ **41 applied, 0070→0110, final high-water 0110** |

The third is the evidence that the reconciliation was necessary, kept because it is the thing
that would have happened.

The fourth is the strongest evidence available short of touching production, and it only became
possible once the probe proved Case A. `scripts/hosted/rehearse-from-ledger.mjs` stages a
disposable database to the hosted high-water, rewrites its ledger to the **exact rows and
filenames** read from production, and then applies whatever the runner considers pending. The
runner reported `applied: 69  pending: 41` and applied all 41. Post-state verified: the 0070
lease columns and `claim_source_events` exist, `channel_accounts` and `resolve_channel_company`
exist, `companies.whatsapp_phone_number_id` is **retained**, and **no R1 draft object leaked in**.

A skipped migration is silent by design — `migrate.mjs` keys on the four-digit prefix — so
reproducing the real ledger and looking at the objects afterwards is the only way to see one.
None was skipped.

---

## Kernel campaign

The R1/R2 kernel suites started this work at **5 files / 13 tests failing** under their own
canonical harness. All thirteen were diagnosed; twelve were stale assertions and one uncovered
two genuine kernel defects.

**Final: 34 files, 644 tests, 0 failed** on a fresh disposable database with the released
migrations and the draft chain applied once, in randomised file order.

| Defect | Fix |
|---|---|
| `readOnePage` returned early when the whole-cycle budget was spent, **before** the reconcile and rescan passes — which hold their own budgets. With 12 sources × 200 rows against a 1550 budget, that happened every cycle by construction, so a source with data could stay partial for ever | The incremental page is skipped without skipping the other two passes |
| `runLifecycleSweep` set `partial` whenever its 25-item budget ran out with items remaining — but an item awaiting a human decision is open for ever, so any company with >25 items was permanently `partial` | `partial` now asks the remaining items what *would* happen and is set only if one could actually have been advanced |

The remaining twelve asserted a finding (R2F-F-014, "nothing moves an item past `observed`")
that R5 had **closed**. Those assertions were inverted, not deleted — the item must now have
moved, and moved exactly one step per cycle.

---

## Open defects — recorded, not resolved

### ~~D-1 (B-3): `r1-draft-schema` cannot run under either of its two setups~~ — **FIXED**

Both defects are repaired at the root, and the suite now runs green as its own third campaign:
**31 tests passed**, twice in succession, with its scratch database dropped each time.

| Defect | Root cause | Fix |
|---|---|---|
| Its runner gave it a **bare** database | The draft chain outgrew that — `R1_DRAFT_023_authority_and_scope` needs `public.permissions`, so `--up` failed at 023 | The suite builds its **own** database: shim → 110 released migrations → the seed rows the released FKs require → the draft chain. The runner now supplies only a bare *server* |
| Its rollback failed on a released-schema database | `R1_DRAFT_008_accountable_owner.down.sql` dropped `memberships_id_company_uq` **unconditionally**. Released migration `0024` builds that name dynamically (`parent \|\| '_id_company_uq'`) and hangs **eight** composite FKs off it. The up adds it only `if not exists`; the down removed it regardless — undoing more than the up created | The down drops it only when **nothing depends on it**. By then the reverse rollback has removed units 017 and 016, whose tables were the only draft-side dependants — so anything still depending on it belongs to the released schema, which is exactly the case where the up did not create it |

Two test assumptions were stale for the same reason and are now correct rather than lenient:
`accountable_owner_id` must be a **real membership of the same company** (unit 008's composite
FK), and that membership must hold `operations.task.work` or `.manage` (`r1_draft_membership_can_own`).
A random UUID passed only while the suite ran on a database with no `memberships` table at all.

### D-2: unauthorised model spend is live in production — **the control now exists**

`OPENAI_API_KEY` is set and `IN_PROCESS_CRON=on`, so `ai-monitor` has been making model calls
hourly since 2026-09-01. No paid model calls were authorised.

**What changed.** There used to be one switch, and turning it off would also have stopped
`outbox` — the single recovery path for a failed customer message — and both inbound sweeps.
Stopping unauthorised spend by silently dropping customer messages is not a fix, so the honest
answer was "this needs an owner decision". That was a poor answer to what is really a missing
control, and the control now exists:

| Variable | Effect |
|---|---|
| `MODEL_JOBS=off` | suppresses every job declared `kind: "model"` — currently exactly `ai-monitor` |
| `CRON_DISABLED_JOBS=a,b` | suppresses jobs by name, for surgical control |

Both fail **safe in one direction only**: an unset or misspelled value leaves the job RUNNING,
because accidentally disabling recovery is worse than accidentally continuing to spend. Spend
appears on a bill; a message that was never retried appears to nobody. Suppression is logged at
error level on boot, naming the job and which control did it.

**Still an owner decision, and NOT applied to production overnight.** Setting `MODEL_JOBS=off`
on the production service is a production configuration change. The candidate simply makes it
possible to stop the spend without stopping message recovery.

### D-3: the deployed production revision is unavailable

The active Railway deployment carries **no commit hash** (`meta.cliCaller: "claude_code"`), so
it cannot be reproduced or audited from git. The connected GitHub repository describes what
*would* build, not what *is* running. Its only durable identifier is the image digest
`sha256:897348ef806c244b1e8dd2e36c7a7a90c48f5c8c609f9494196169fa2c3e0a05`. This is PR-F-014,
confirmed rather than inferred.

### D-4: the management cycle's own audit writes are not verified

Throughout the kernel campaign every cycle logs:

```
{"level":"error","msg":"audit write threw","fields":{"event":"audit.write_threw",
 "action":"management_cycle.completed","error":"Missing NEXT_PUBLIC_SUPABASE_URL"}}
```

`writeAudit` goes through the Supabase REST client, and the kernel campaign has a database but
no PostgREST endpoint, so the write throws. It is caught and logged — correctly, since an audit
failure must not abort a cycle — but the consequence is that **no test asserts the cycle writes
an audit row**.

**Scope, stated precisely so this is not read as worse than it is:** audit *is* verified
elsewhere. Five core integration suites assert `audit_events` rows directly in SQL
(`ai-case-atomic`, `authority-adversarial`, `campaign-cross-layer`, `case-task-dedup-wiring`,
`duplicate-review-and-approval-visibility`), and those pass. What is unverified is specifically
the `management_cycle.*` audit actions.

Closing it means either giving the kernel campaign a PostgREST endpoint, or letting `writeAudit`
take an injected client the way the rest of the kernel does. The second is smaller and matches
the existing dependency-injection pattern. Not started.

### D-5: the Meta webhook destination is unverified

Every Vercel path returned HTTP 402 `DEPLOYMENT_DISABLED` on 2026-09-01, including
`/api/webhooks/whatsapp`. Whether Meta still points there needs the Meta console. If it does,
inbound customer messages are being lost now. Procedure in [RUNBOOK.md](RUNBOOK.md) §F.

---

## Configuration manifest — names only

**No secret value is recorded anywhere in this repository.** Values appear below only for
non-secret operational flags.

### Production, as found 2026-09-10 (26 variables set)

| Variable | Set | Value |
|---|---|---|
| `APP_ENV` | ✅ | `production` |
| `IN_PROCESS_CRON` | ✅ | `on` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | withheld |
| `CRON_SECRET`, `APP_BASE_URL` | ✅ | withheld |
| `OPENAI_API_KEY` | ✅ | withheld — see **D-2** |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` | ✅ | withheld |
| `NIXPACKS_NODE_VERSION`, `RAILPACK_NODE_VERSION` | ✅ | withheld |
| `RAILWAY_*` (11, platform-injected) | ✅ | platform |
| **`RLS_READS`** | ❌ **unset** | — |
| **`RLS_WRITES`** | ❌ **unset** | — |
| **`DATABASE_URL`** | ❌ **unset** | — |
| `MANAGEMENT_KERNEL` | ❌ unset | the cycle reports `disabled` |
| `V3_1_*` | ❌ none set | — |

### ⚠️ Required before this candidate is deployed anywhere

`RLS_READS` and `RLS_WRITES` must be set **explicitly** to `on` or `off`. The candidate refuses
to start otherwise, and that is deliberate: production was found running with both unset, which
under the `=== "on"` convention silently means off — company separation resting on application
code with nothing recording that as a decision (H-2 / PR-F-012).

Owner decision 5 requires isolation proven in staging before production, so the honest
production value **today** is `off`, set explicitly, until staging proves `on`.

---

## What is verified, and what that is worth

| Axis | Status |
|---|---|
| Code and schema agree | ✅ proven on disposable PostgreSQL 16.10 |
| The migration reconciliation applies cleanly | ✅ proven, both fresh and `main`-seeded |
| Deterministic test failures | ✅ fixed — kernel 13 → see §Kernel campaign |
| CI can be green | ✅ both campaigns isolated and order-independent |
| **A hosted environment** | ❌ **none** — no staging, and production untouched |
| **The real hosted schema state** | ✅ **MEASURED** — CASE A, high-water `0069`, ledger and objects agree |

A disposable container is not a deployment. It proves the code and the schema agree; it proves
nothing about a hosted environment, its configuration, or its data. Nothing in this release is
`staging_verified`, and nothing is `production_verified`.
