# Product Recovery Audit — Singha AI Management Operating System

**Phase 0 — preserve and audit. No application code was modified.**

| | |
|---|---|
| Repository | `MUA1234/bot_business_Singha` — **verified** |
| Audit branch | `claude/product-recovery-audit` — created and pushed |
| Baseline branch | `claude/hard-scenario-testing` — **verified** |
| Baseline HEAD | `abc7767eb8b669433cd67a3a97e7b8673874fb49` — **verified, exact match** |
| Working tree at audit start | clean; nothing unpushed |
| Audit date | 2026-09-01 |

## Deliverables

| # | Deliverable | Document |
|---|---|---|
| 1 | Current deployed-product assessment | [01-DEPLOYED-PRODUCT-ASSESSMENT.md](01-DEPLOYED-PRODUCT-ASSESSMENT.md) |
| 2 | Original-vision capability matrix | [02-CAPABILITY-MATRIX.md](02-CAPABILITY-MATRIX.md) |
| 3 | Repository and deployment SHA comparison | [03-SHA-AND-DEPLOYMENT-COMPARISON.md](03-SHA-AND-DEPLOYMENT-COMPARISON.md) |
| 4 | Database and migration-state assessment | [04-DATABASE-AND-MIGRATION-STATE.md](04-DATABASE-AND-MIGRATION-STATE.md) |
| 5 | As-is architecture | [05-AS-IS-ARCHITECTURE.md](05-AS-IS-ARCHITECTURE.md) |
| 6 | Target AI Management OS architecture | [06-TARGET-ARCHITECTURE.md](06-TARGET-ARCHITECTURE.md) |
| 7 | Reusable management-loop specification | [07-MANAGEMENT-LOOP-SPEC.md](07-MANAGEMENT-LOOP-SPEC.md) |
| 8 | Data and integration gap analysis | [08-DATA-AND-INTEGRATION-GAPS.md](08-DATA-AND-INTEGRATION-GAPS.md) |
| 9, 11 | Dependency-ordered roadmap, phases and verification criteria | [09-RECOVERY-ROADMAP.md](09-RECOVERY-ROADMAP.md) |
| 10 | Retain / adapt / replace / retire | [10-COMPONENT-DISPOSITION.md](10-COMPONENT-DISPOSITION.md) |
| 12 | Owner decisions genuinely required | [11-OWNER-DECISIONS.md](11-OWNER-DECISIONS.md) |

## Phase R0 (authorised 2026-09-02)

| Document | Purpose |
|---|---|
| [13-OWNER-DECISIONS-RECORD.md](13-OWNER-DECISIONS-RECORD.md) | **The owner's rulings D-1…D-10**, amendments, safeguards and the R0 permission boundary. Authoritative — overrides conflicting guidance elsewhere. |
| [12-R0-EVIDENCE.md](12-R0-EVIDENCE.md) | R0 evidence, findings and completion status. **Contains R0-F-001 (P0): the Vercel origin is `DEPLOYMENT_DISABLED`** — if Meta still points there, inbound messaging is down. |
| [14-VISION-RECONCILIATION.md](14-VISION-RECONCILIATION.md) | **Original Vision Reconciliation (2026-09-02).** The owner's twelve preserved requirements mapped to 20 new stable IDs; the five-way separation (retained / adapt / missing / future-gated / provider incidents); what the reconciliation deliberately did not resolve. |

**Authorised work is Phase R0 only.** R1, R2 and all new management capability are not
authorised. Every production boundary is a full stop.

## Executive summary

**The owner's diagnosis is correct about the deployed product and incorrect about the
repository — and the gap between those two facts is the most important finding in this
audit.**

What is deployed is a sales / WhatsApp / quotation application. What is in the
repository is a substantially broader management system: finance, operations, HR,
procurement, legal, fleet, marketing, governance and a command centre — 105
authenticated pages, 146 tables, 109 database functions, 51,603 lines of application
code and 33,733 lines of tests.

Both statements are true because **the broad system was never deployed.** The deployed
line is `main`. The management-system work sits on a 234-commit branch line that has
never been merged, whose 41 additional migrations have never been applied to any hosted
database, and which — critically — **cannot be merged as it stands** (PR-F-001,
PR-F-002, PR-F-003).

So the drift is not primarily that the wrong thing was built. The drift is that:

1. **Delivery stopped.** Breadth accumulated on a branch, verified only against
   disposable local PostgreSQL. The requirement register records **zero** of 90
   requirements at `staging_verified` or `production_verified`.
2. **The AI is genuinely not the operating layer.** Where AI *is* wired, it observes
   exactly one signal class — WhatsApp conversation threads — plus a manual paste-text
   form at `/app/command/analyze`. The owner's characterisation of "an Analyse button
   added to conventional departmental software" is literally accurate: that button
   exists, and it is one of only two entry points into the management loop.
3. **The loop does not close.** Steps 1–8 of the eleven-step loop exist in some form.
   Step 9 (intervene when work stalls) is partial, step 10 (verify outcomes) is
   partial, and **step 11 (learn) is entirely absent** — four requirements, no code.

The recovery is therefore **less about new departmental software and more about
(a) making one line deployable again, and (b) attaching the departments that already
exist to a management loop that already partly exists, then closing that loop.**

## Findings

Severity: **P0** blocks recovery or risks production; **P1** defeats the product
intent; **P2** correctness or hygiene.

| ID | Sev | Finding |
|---|---|---|
| [PR-F-001](03-SHA-AND-DEPLOYMENT-COMPARISON.md#pr-f-001) | **P0** | **Migration number collision on `0069`.** `main` and the branch line each define a *different* migration numbered 0069. `scripts/migrate.mjs` keys `schema_migrations` on the 4-character prefix, so on the production database the branch's `0069_durable_inbound_processing.sql` would be silently **skipped**, and 0070–0109 would then run against a schema missing its objects. |
| [PR-F-002](03-SHA-AND-DEPLOYMENT-COMPARISON.md#pr-f-002) | **P0** | **The branch line would regress production.** Four production fixes exist only on `main`: de-hardcoded company/department/currency routing (0069), the in-process scheduler, the Supabase `no-store` cache fix, and `whatsapp-inbound.ts`. The branch still carries `routeDepartment ?? "sales"` — the exact defect main fixed. |
| [PR-F-003](03-SHA-AND-DEPLOYMENT-COMPARISON.md#pr-f-003) | **P0** | **Two divergent, incompatible solutions to inbound company resolution.** `main` resolves company from `companies.whatsapp_phone_number_id`; the branch resolves it from `channel_accounts` + `resolve_channel_company`. Both are production-bound. One must be chosen and the other's data migrated. |
| [PR-F-004](04-DATABASE-AND-MIGRATION-STATE.md#pr-f-004) | **P0** | **The authoritative migration-state record contradicts the deployed code.** `MIGRATION_STATE.md` records everything from 0042 onward as "owner confirmation required" (never applied), yet the deployed `main` code *requires* 0069. Either the record is stale or production runs code ahead of its schema. This cannot be resolved from inside the repository. |
| [PR-F-005](01-DEPLOYED-PRODUCT-ASSESSMENT.md#pr-f-005) | **P0** | **Two live origins, one webhook.** Railway (`singha-web-production.up.railway.app`, verified live) and Vercel both run the app. Meta's webhook can point at only one; per D-021 it still points at Vercel. The host the owner treats as "the server" processes no inbound messages. |
| [PR-F-006](01-DEPLOYED-PRODUCT-ASSESSMENT.md#pr-f-006) | **P1** | **The management loop observes one signal class.** Only `wa_conversations` is swept. Finance, tasks, projects, HR, procurement, legal, fleet and inventory tables exist and are never observed. Only 2 of 105 app surfaces import the AI gateway. |
| [PR-F-007](02-CAPABILITY-MATRIX.md#pr-f-007) | **P1** | **Loop step 11 (learning) is entirely absent.** AIM-008, IMP-001, IMP-002, IMP-003 — no implementation. The only occurrence of "improvement loop" in `src/` is a feature-flag description string. |
| [PR-F-008](02-CAPABILITY-MATRIX.md#pr-f-008) | **P1** | **Loop step 8 (assignment) has no recommender.** Register finding OF-008 is open: nothing proposes an assignee, so every captured task lands in `needs_routing` and stops. |
| [PR-F-009](05-AS-IS-ARCHITECTURE.md#pr-f-009) | **P1** | **Page-centric data access leaves no seam for the loop.** 95 of 105 pages query Supabase directly. Domain modules outside finance/project/work are near-empty (fleet 31 LOC, workforce 40, legal 41, comms 37). There is no service layer for a management loop to attach to. |
| [PR-F-010](02-CAPABILITY-MATRIX.md#pr-f-010) | **P1** | **The V3.1 management-intelligence flags are declared but unwired.** Of eight flags, only `aiGuide` is read by runtime code. `taskDetection`, `decisionPaths`, `teamFormation`, `improvementLoop`, `managerControlTower` and `multilingual` are read by nothing. |
| [PR-F-011](04-DATABASE-AND-MIGRATION-STATE.md#pr-f-011) | **P2** | **41 migrations (0069–0109) have no per-environment state record at all.** `MIGRATION_STATE.md`, declared authoritative, stops at 0068. |
| [PR-F-012](01-DEPLOYED-PRODUCT-ASSESSMENT.md#pr-f-012) | **P2** | **RLS is bypassed at runtime.** `RLS_READS`/`RLS_WRITES` default OFF; the app reads and writes through the service-role client. Company isolation currently rests on application code, not on the database. (Register OF-012, open.) |
| [PR-F-013](02-CAPABILITY-MATRIX.md#pr-f-013) | **P2** | **One unit test fails on the required HEAD.** 1362 passed / 1 failed / 2 skipped across 184 files. Root cause: 12 test files assert on *source text*, and the repository has no `.gitattributes`, so CRLF checkouts break multi-line assertions. Source-text assertions are not behavioural verification. |
| [PR-F-014](03-SHA-AND-DEPLOYMENT-COMPARISON.md#pr-f-014) | **P2** | **No build provenance.** The running application exposes no commit SHA, so the deployed revision cannot be confirmed from outside — only inferred from Railway's `main` auto-deploy. |
| [PR-F-015](02-CAPABILITY-MATRIX.md#pr-f-015) | **P2** | **`CLAUDE.md` is materially stale.** It states migrations 0048–0067 are "NOT merged, hosted DB NOT migrated" — they are on `main` and deployed — and cites "unit 419 (79 files)" against a measured 1365 tests / 184 files. |

## Method and honesty statement

Every claim above was derived by inspecting this repository and by two read-only
network probes of the owner's own public Railway URL.

* **Verified by execution:** `npm ci`; `npm test` (1362 passed / 1 failed / 2 skipped,
  184 files); `npm run typecheck` (clean); `git` history and tree comparisons;
  `curl -I` and `curl /api/health` against the live Railway origin.
* **Verified by inspection:** route, table, function and flag inventories; call-graph
  searches for the management loop; the migration runner's version-keying logic.
* **Not verified, and stated as such wherever relied upon:** the live Supabase schema
  (the Supabase connector is unauthenticated in this session), the Railway dashboard,
  the Vercel deployment, and any owner-side environment variable.

Nothing in this audit asserts hosted database state as fact. Where the repository's own
records conflict with deployed code, the conflict is reported rather than resolved by
guess.

**No second requirement register was created.** Per `CLAUDE.md`,
`docs/autonomy/ORIGINAL_VISION_REQUIREMENTS.yaml`,
`docs/autonomy/OPEN_FINDINGS_REGISTER.md` and
`docs/autonomy/AUTONOMOUS_DEVELOPMENT_STATE.json` remain the only register, findings
store and state controller. Deliverable 2 is a **mapping view** onto the existing
register, using its existing requirement IDs.
