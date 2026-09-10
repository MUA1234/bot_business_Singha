# Release 1 — deployment readiness

> **Verdict: READY FOR STAGING is NOT claimed.** Two of the definition-of-done conditions
> cannot be met from here, and one is an environment that does not exist. Details in
> §Verdict. Nothing has been deployed, merged, or applied to any hosted database.

| | |
|---|---|
| Candidate branch | `claude/product-recovery-deploy-candidate` |
| Base | `origin/main` @ `acd9fbec35d3075c8faba1c6bbb9b4aaca1ab164` |
| Recovery line integrated | `claude/product-recovery-r1` @ `b3e43b3e4b468482bcbe2be50e8bb881c0436f55` — **preserved unchanged, never rebased** |
| Hosted contact | Railway metadata only, read-only. **No hosted database was read or written.** |

---

## Verdict

**Not `READY FOR STAGING`.** Three blockers, in order of who can clear them:

| # | Blocker | Who clears it |
|---|---|---|
| **B-1** | **No staging environment exists.** `singha-central` has one environment: `production`. The brief forbids silently creating a paid or production-connected one | **Owner** — see [STAGING-REQUIREMENTS.md](STAGING-REQUIREMENTS.md) |
| **B-2** | **Hosted migration state is still UNKNOWN.** The read-only probe was written and is ready, but `railway run` was refused by this session's permission sandbox | **Owner or a permission grant** — see [09-HOSTED-EVIDENCE-OBTAINED.md](../product-recovery/r0-integration/09-HOSTED-EVIDENCE-OBTAINED.md) §D |
| **B-3** | **`r1-draft-schema` is broken two ways** (below). Excluded from both campaigns so it cannot decide other suites' results, but not fixed | Engineering — bounded, not started |

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
| **Kernel integration** | `npm run test:kernel` | see §Kernel campaign |
| Browser / accessibility | `npm run browser-check` | ⚠️ **not run** — no application server in this environment |

All database work ran on **disposable local PostgreSQL 16.10** in uniquely labelled containers
on OS-assigned ports. No pre-existing container was touched.

### Migration rehearsals

| Scenario | Result |
|---|---|
| Fresh database, candidate 0001–0110 | ✅ 110 applied, then 28 draft units |
| `main`-seeded ledger + the +1 shift | ✅ 41 applied, high-water 0110, both lineages coexist |
| Recovery line **unshifted** over a `main`-seeded ledger | ❌ halts at old-0076, partial migration at 0075 — the defect the shift removes |

The third is the evidence that the reconciliation was necessary, kept because it is the thing
that would have happened.

**Not rehearsed:** the production-ledger-seeded run against the *real* ledger (blocked by B-2 —
seeding from a document rather than the live ledger would rehearse a hypothesis), and the
restore-and-retry drill (needs a hosted environment; the procedure is in
[RUNBOOK.md](RUNBOOK.md) §A).

---

## Kernel campaign

The R1/R2 kernel suites started this work at **5 files / 13 tests failing** under their own
canonical harness. All thirteen were diagnosed; twelve were stale assertions and one uncovered
two genuine kernel defects.

| Defect | Fix |
|---|---|
| `readOnePage` returned early when the whole-cycle budget was spent, **before** the reconcile and rescan passes — which hold their own budgets. With 12 sources × 200 rows against a 1550 budget, that happened every cycle by construction, so a source with data could stay partial for ever | The incremental page is skipped without skipping the other two passes |
| `runLifecycleSweep` set `partial` whenever its 25-item budget ran out with items remaining — but an item awaiting a human decision is open for ever, so any company with >25 items was permanently `partial` | `partial` now asks the remaining items what *would* happen and is set only if one could actually have been advanced |

The remaining twelve asserted a finding (R2F-F-014, "nothing moves an item past `observed`")
that R5 had **closed**. Those assertions were inverted, not deleted — the item must now have
moved, and moved exactly one step per cycle.

---

## Open defects — recorded, not resolved

### D-1 (B-3): `r1-draft-schema` cannot run under either of its two setups

| | |
|---|---|
| Its dedicated runner (`scripts/r1/run-draft-schema-tests.mjs`) gives it a **bare** database | The draft chain outgrew that: `R1_DRAFT_023_authority_and_scope` needs `public.permissions`, so `--up` fails at 023 |
| On a database carrying the released migrations | Its rollback fails: `R1_DRAFT_008_accountable_owner.down.sql` drops `memberships_id_company_uq`, which released objects depend on — the down undoes more than its up created |

It is excluded from both campaigns as self-managed, so one broken suite cannot decide the
result of thirty others. **That is containment, not a fix.** Both defects are real and bounded.

### D-2: unauthorised model spend is live in production

`OPENAI_API_KEY` is set and `IN_PROCESS_CRON=on`, so `ai-monitor` has been making model calls
hourly since 2026-09-01. No paid model calls were authorised during R0–R3. **Owner decision
required** — accept the spend, or unset the key. Turning the scheduler off is not a neutral
option: it would also stop the outbox drain, the only recovery path for a failed customer
message.

### D-3: the deployed production revision is unavailable

The active Railway deployment carries **no commit hash** (`meta.cliCaller: "claude_code"`), so
it cannot be reproduced or audited from git. The connected GitHub repository describes what
*would* build, not what *is* running. Its only durable identifier is the image digest
`sha256:897348ef806c244b1e8dd2e36c7a7a90c48f5c8c609f9494196169fa2c3e0a05`. This is PR-F-014,
confirmed rather than inferred.

### D-4: the Meta webhook destination is unverified

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
| **The real hosted schema state** | ❌ **UNKNOWN** — probe blocked (B-2) |

A disposable container is not a deployment. It proves the code and the schema agree; it proves
nothing about a hosted environment, its configuration, or its data. Nothing in this release is
`staging_verified`, and nothing is `production_verified`.
