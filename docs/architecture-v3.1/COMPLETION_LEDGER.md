# Completion Program Ledger (authoritative)

> The ONE compact, SHA-bound tracker for the owner-authorized completion program (2026-08-17
> authorization). Every slice appends here: branch, base/head SHAs, files, migrations, tests, review
> findings + dispositions, and unresolved owner gates. Nothing is "complete", "launch-ready" or
> "production-ready" until the FINAL DEFINITION OF DONE at the bottom is genuinely satisfied.

## Verification-state taxonomy (used everywhere in this program)

| State | Meaning | Current evidence source |
|---|---|---|
| implemented + locally verified | Code + tests green on disposable PostgreSQL 16 / unit / build in this repo | this ledger + suite outputs |
| preview-deployed | Automatic Vercel Preview built from a pushed branch (no owner action) | Vercel preview URL |
| staging-verified | A real staging environment passed role UAT / migration / drills | none yet — owner gate |
| production-verified | Monitored production pilot | none yet — owner gate |
| deliberately deferred | Explicitly excluded with owner-visible reason (health-reported where applicable) | this ledger §Deferred |

## Program baseline (Phase 0 start)

- **Reviewed reference:** PR #13 (draft, frozen), branch `feature/v3-1-phase-1-external-review-fixes`,
  head `48407bde1a655964a5d50ec9fb2ee722e6156102`, migrations 0001–0067 sequential.
- **Branch check at program start:** remote fetched; branch had NOT advanced beyond the reviewed
  head; working tree clean. One unrelated pre-existing remote branch noted:
  `feat/app-layer-dashboards-whatsapp` (not based on the reviewed head; untouched).
- **Hosted DB:** 0038–0041 only (owner-applied 2026-08-07). NOT migrated further. All flags OFF.
- **Machine inventory baseline** (`node scripts/completion-inventory.mjs`, committed snapshot
  `COMPLETION_INVENTORY.md`; wired into `npm run verify` as `--check`, report-only until Phase 2 arms
  the allowlist): **38** supabaseAdmin files (after the dead-file deletion) · **75** money-as-Number
  suspect lines · **8/8** V3.1 flags without runtime consumers · 3 TODOs · 1 stub route (email
  inbound 501) · **72** error-masking suspects (catch→empty/zero + error-discarding destructures).
- **Code-first audit findings (2026-08-17 sweeps; each file opened, not path-guessed):**
  - Service-role classification: SYSTEM-KEEP vs AUTH-READ vs AUTH-WRITE recorded per file in
    `docs/architecture-v2/SERVICE_ROLE_INVENTORY.md` (2026-08-17 update block) — Phase-2 work list.
    The flag shim `src/lib/supabase/read.ts` reaches 91 files and silently returns the ADMIN client
    while `RLS_READS`/`RLS_WRITES` are OFF.
  - Flags: the `env.flags` accessors in `src/config/env.ts` are DEAD — the three live gates
    (`read.ts`, whatsapp route) re-read `process.env` directly; `/api/health` does not surface the
    V3.1 flag snapshot. (Phase-5/health work.)
  - Command Centre (`src/app/app/command/page.tsx`) — the pre-V3.1 Manager Control Tower: uses
    `updated_at` as a check-in proxy (detector structurally under-reports), single guessed currency
    for AR/AP/cash with a silent-zero fallback, and a double error-mask (`safeSelect` discards
    `error`, catch returns []) so a full DB outage renders "All clear". Operations passes
    `lastCheckInAt: null` (same detector can never fire there). `hr/capacity` computes utilisation
    from hardcoded 40/4 weekly hours. (Phase 1C + Phase 3.6 work.)
  - Cron reconciliation: Vercel cron = heartbeat only (07:00); Inngest holds the 5 real schedules,
    which HTTP-self-call via `VERCEL_URL` and silently no-op without `CRON_SECRET`/Inngest keys — no
    fallback sweep if Inngest is unconfigured; digest collides with heartbeat at 07:00. (Phase 5.)
  - Legal placeholders (`src/app/legal-config.ts`): unverified entity name, personal contact email,
    stale lastUpdated — rendered on public privacy/terms/data-deletion pages. (Owner gate 6.)
  - Dead/test-only exports: `signedLineAmount` fully dead; the pure accounting layer
    (`buildPostedJournal`, settlement/reconciliation/tax helpers) is test-only — production posts via
    SECURITY DEFINER RPCs; kept deliberately as the executable specification the RPC tests mirror
    (recorded, not deleted). `idempotency_store.ts` deleted (zero call sites, verified twice).

## Slices

### Slice P0 — truth reset + machine-checkable inventory
- **Branch:** `feature/v3-2-completion-phase0-truth-reset` (base `48407bd`, stacked on PR #13's branch)
- **Head:** _stamped at commit_
- **Scope:** code-first re-audit; `scripts/completion-inventory.mjs` (+ committed snapshot);
  doc truth reset (baseline §5 superseded — 0048+ implemented through 0067; exec-spec slice table;
  staging runbook 0001→0067; RLS cutover plan → machine inventory; package.json description;
  this ledger created); deleted dead `src/lib/idempotency-store.ts` (zero call sites, verified).
- **No behavior change** (docs + dead-file deletion + a new read-only script only).
- **Tests:** full static/unit/build at slice checkpoint (this slice has no runtime change; integration
  suite unaffected — run at the next code slice checkpoint per the usage rules).
- **Owner gates opened:** none. **Findings:** see `COMPLETION_INVENTORY.md`.

### Slice P1 — application correctness blockers (money, atomic AI persistence, error visibility)
- **Branch:** `feature/v3-2-completion-phase1-correctness` (base = P0 head `8a8170f`)
- **Commits:** checkpoint `fa7ae8e` (correctness core + migration 0068 + P1C) + the mechanical
  money tail & docs commit (head stamped at commit).
- **1A — decimal money integrity:** authority comparison (`route-decision exceeds()`),
  `positiveDecimalString`, settlement RPC args (canonical strings, no float round-trip), journal-line
  filtering, tax factors, AI cost math, pipeline-value module, plus the mechanical tail across ~40
  page/action files: aggregations via `dec/decSub/decSum/decGtZero`, form money inputs via
  `parseMoneyInput`, every money display via the ONE shared exact formatter `fmtMoney`. Machine
  inventory money-suspects: **75 → 12**, all 12 remaining sanctioned non-money (quantities, rates,
  litres, counts, comments). New `tests/money-adversarial.test.ts` (17) covers fractional, >2^53,
  negative, half-even rounding boundaries, mixed currencies, and the one-cent-over-authority-ceiling
  case at float-breaking magnitude.
- **1B — atomic AI persistence:** migration **0068** (`create_management_case_atomic`, service-only
  SECDEF, canonical search_path, in-function fail-closed jwt gate; `management_cases.idempotency_key`
  UNIQUE per company; `tasks.management_case_id`); both analysis paths cut over with content-derived
  idempotency identities (constant "manual" gone); persistence failure fails the analysis; app-side
  task loop + log-and-continue helper removed. `tests/integration/ai-case-atomic.test.ts` (6): 
  atomic rollback, idempotent replay, two-connection identical-submission race → exactly one logical
  case/task set, forced `captured` status, 20-task cap, hostile roles 42501.
- **1C — error visibility:** `/api/health` probes the 8 dashboard-critical tables
  (ok/unavailable per table; folds into overall level; logs `health.table_unavailable`); the Command
  Centre names+logs failed sources (`command.query_failed`) and renders a degraded banner — a DB
  outage can no longer present as "All clear".
- **Gates (slice checkpoint):** typecheck ✓ lint 0 errors ✓ secret-scan ✓ migration-lint **68** ✓
  unit **438 (80 files)** ✓ fresh 0001→0068 integration **42 files / 327** ✓ upgrade 0058→0068
  **42 files / 327** ✓ build ✓ (final battery re-run at the tail+docs commit). Focused
  security/concurrency review: see the dated note appended at commit time.
- **Owner gates opened:** hosted application of migration 0068 (with 0042→0067).

## Deferred (deliberate, owner-visible)

| Item | Why deferred | Where reported |
|---|---|---|
| Email provider integration | No provider configured/purchased (owner gate) | `/api/health` (`email: not_configured`) — Phase 5 wires this |
| GPS / CCTV / facial recognition / bank-transfer execution / autonomous legal-HR | Separately gated (legal/privacy review) — excluded by standing instruction | CLAUDE.md restrictions |
| Hosted migrations, flag flips, merge, production promotion | Owner-only actions | this ledger, every slice |

## Owner gates outstanding (program-wide)

1. Merge authorization for PR #13 and each stacked completion PR.
2. Hosted/staging migration authorization (0042→0067 + any new completion migrations).
3. Flag activation per slice (each V3.1 flag; RLS_READS/RLS_WRITES/WHATSAPP_ASYNC).
4. GitHub Actions runner remediation (runner_id:0 systemic failure — repo/account settings; CI green
   on final SHA is a hard done-gate that local PostgreSQL cannot substitute).
5. Email/model provider selection + credentials.
6. Legal identity/contact values for the legal pages.
7. Staging environment + credentials for UAT/drills; production pilot approval.

## FINAL DEFINITION OF DONE (verbatim gates; none may be claimed by proxy)

All eight V3.1 flags have tested runtime implementations · no unauthorized authenticated
service-role path · no money decision on JS float `Number` · AI case/task persistence atomic,
durable, audited, idempotent · stubs/TODOs implemented or owner-accepted + health-reported · docs
match code/migrations/env · full unit/static/build/fresh/upgrade suites pass · GitHub Actions green
on final SHA (both jobs) · staging passed role UAT, migration verification, WhatsApp tests,
backup/restore + rollback drills · owner-approved legal/config values installed · owner approved
merge, hosted migrations, each flag, production promotion · monitored production pilot with rollback
window.
