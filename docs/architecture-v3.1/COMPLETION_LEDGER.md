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

### Slice UI1 — product surface refresh (merged to `main`, PR #17 → `eab1640`)
- **Scope:** Agentic-OS theme tokens + smoked panel surfaces (`globals.css`); staff-specific landing
  (signed-in "continue to YOUR department" strip from the real session); shared chart primitives
  (`src/components/charts.tsx`: `BarChart`, `HBarChart`, `AreaLineChart`, `agingBars`) used by the
  Command Centre (90-day cash projection, AR/AP aging) and department dashboards; living video
  background (`src/components/LivingBackground.tsx`) with a single post-mount source, mobile MP4 /
  WebM selection and a reduced-motion opt-out.
- **Defects found by rendering the built pages and looking at them** (not by assumption): trough
  marker clipped at the right edge (`padX` + label clamp), and body text unreadable over the video
  (white-film glass → smoked dark panels + `--text-dim` + body text-shadow).
- **Note:** PRs #14/#15/#16 merged into their stacked bases, not `main`; PR #17 is what actually put
  P0, P1 and this slice on `main`. Verified by reading `main`'s tree after the merge.
- **No behaviour, permission, schema or migration change.**

### Slice UI2 — Singha Central rebrand (merged to `main`, PR #18 → `f9eafb2`)
- **Scope:** brand/title/legal/package naming to **Singha Central**; landing repositioned from
  sales-first to whole-business management; "AI Manager" dropped as a feature name (nav → "Analysis").
- **Prompt-version bump:** the model-facing system prompt text changed, so
  `MANAGEMENT_PROMPT_VERSION` went `mgmt-1.0` → **`mgmt-1.1`** — recorded AI decisions must trace to
  the exact prompt that produced them.

### Slice UI3 — landing copy: reader-control voice (merged to `main`, PR #19 → `6a1a353`, then the
audience correction PR #20 → `728eab1`)
- **Branch:** `feature/owner-control-copy` (base `f9eafb2`), commits `8edfbe6` + `4bb00bd`.
- **Scope:** landing voice moved from product pitch to reader-control — outcome-for-you section
  titles; nav anchor `#how` → `#control` ("What you control"); login tagline, admin welcome line
  (which also still carried the pre-rebrand "Singha platform" name) and the site meta description
  brought into the same voice.
- **Audience correction (owner, same slice):** the first pass addressed the owner only ("Your
  business, under your control", "your team", "you set who can approve what"), but this page is the
  entry point for **every** employee. Rewritten to address the reader at their own level — hero
  "Your work, your call, your team behind you"; the sub-copy names both cases ("whether you run the
  company or run one part of it"); device widgets de-owner-ised ("Cleared this week", "Working with
  you today"); the authority card reframed from *you set the limits* to *you know what is yours to
  decide*; and the signed-in strip now branches on the real session role (admin → whole business in
  view; staff → their department).
- **Claims kept tied to implemented behaviour:** WhatsApp orders/quotations, authority-limited
  approvals with recorded decisions, double-entry core with no silent edits, department-scoped
  access, assistant observes/proposes only.
- **Legibility defect found by rendering and reading (not by assumption):** the one line of prose
  that sits directly on the living background was unreadable over the video's bright passages — it
  now gets the same smoked ground as every other panel (new `.on-bg` utility, built from the
  existing `--panel` / `--panel-border` / `--panel-blur` tokens).
- **Gates (both commits):** typecheck ✓ lint 0 errors ✓ build ✓ `npm run verify` **438 unit
  (80 files)** ✓; production build rendered headlessly and read at each pass.
- **No behaviour, permission, schema or migration change** (copy, one anchor id, one session-role
  branch on the signed-in strip, one CSS utility).

## Blocked-preflight checkpoints (durable)

> A blocked preflight is a run that STOPPED BEFORE implementing anything because a mandatory input
> was absent or a mandatory precondition (e.g. the required checkout target) was unmet. It is
> recorded here so the block is durable rather than re-discovered, and so the
> next run resumes from a stated action instead of re-deriving one. A checkpoint in this section
> changes NO requirement status: nothing here marks any item done, blocked-forever, waived or
> descoped, and nothing here is evidence for or against any gate above.

### BP-001 — v5 preflight, 2026-08-20 — BLOCKED on checkout target (v5 pack input satisfied)

**Correction (2026-08-20, same day, later session).** As first written, this checkpoint recorded all
three mandatory v5 documents as ABSENT. That was accurate about the tracked repository tree and
FALSE as a statement about this run's available inputs: the three documents were attached to the run
inside Conductor's brief directory, which is git-excluded and therefore invisible to the
repository-only searches originally run. All three have since been opened and read in full. The
missing-input claim is **withdrawn**. The separate checkout-target blocker below is unaffected and
still stands.

#### 1. Mandatory v5 documents — PRESENT in the attached Conductor pack, all three READ IN FULL

Source: `.conductor/brief/SINGHA_AI_BUSINESS_MANAGER_CONDUCTOR_DEV_PACK_v5.zip` — an attached run
input, **not** repository content: it is untracked and git-excluded by the `.git/info/exclude` rule
`/.conductor/`, which is why it did not appear in any tracked-file search. It must not be committed
into the repository.

| Mandatory document (exact filename) | In attached pack | Bytes | Read completely this session |
|---|---|---|---|
| `SINGHA_AI_BUSINESS_MANAGER_MASTER_AUTONOMOUS_DEV_GUIDE_v5.md` | yes | 52,883 | **yes** — all 1,288 lines, sections 0 through 31 |
| `SINGHA_AI_BUSINESS_MANAGER_CURRENT_HANDOFF_v5.md` | yes | 5,359 | **yes** — all 8 sections |
| `SINGHA_AI_BUSINESS_MANAGER_USAGE_OPTIMISATION_POLICY_v5.md` | yes | 6,671 | **yes** — all 9 sections |

All three were readable and parsed as Markdown; none was truncated, encrypted or unreadable. The
pack also carries `SINGHA_AI_BUSINESS_MANAGER_CONDUCTOR_BOOT_BRIEF_v5.md` (7,108 bytes; present, not
read this session — it is the Conductor boot instruction, not one of the three mandatory documents)
and `SINGHA_AI_BUSINESS_MANAGER_CONDUCTOR_DEV_PACK_v5_MANIFEST.md` (1,358 bytes; read), whose file
list matches the four documents above.

**The authoritative v5 pack is therefore no longer an outstanding preflight input.** Nothing in this
checkpoint should be read as the pack being unavailable.

#### 2. The same three files are still absent from the tracked repository tree

This is a statement about repository content, not about run inputs, and it is not a blocker: each of
the three exact filenames returns no match anywhere in the checkout; there is no
`docs/architecture-v5/` directory (`docs/` holds `architecture-v2` and `architecture-v3.1` only); and
no tracked filename contains `v5`. The pack is supplied per run by Conductor and is not expected to
be in-tree.

#### 3. Observed checkout (exact, as read in the working clone)

| Fact | Observed value |
|---|---|
| Branch | `main` |
| Head commit | `48bef9c1552e9595d0a924fcdc4d37d22bf40a7a` (`48bef9c`) |
| Head subject | `Merge PR #21 — ledger records UI slices, merge authorization, hosted-migration truth` |
| Head commit date | 2026-08-18 01:26:47 +1000 |
| Working tree | clean (`git status --porcelain` empty) |
| Migrations in the working tree | `src/db/migrations/0001…0068`, sequential, **68** files; highest = `0068_ai_atomic_case_persistence.sql` |
| PR #27 head object in this clone | **present** as remote-tracking ref `origin/feature/of-016-duplicate-review-resolution` = `1b679e20990e6b58d048e036645e3f5647b4f3d2`, carrying **89** migrations (…`0087_duplicate_review_resolution.sql`, `0088_duplicate_review_boundary_corrections.sql`, `0089_duplicate_review_sibling_and_budget.sql`) — read via `git ls-tree`, without checkout |
| PR #27 base in this clone | **present** as `origin/feature/found-006-caller-trust-boundary` = `be2f13ee9ede90b58a69a86069bbd10f9d9c5106` |

Both remote SHAs match the values the handoff document states for PR #27's head and base. A second
correction to the original entry: it claimed no ref in this clone corresponded to a PR #27 head —
that came from a bad check (grepping ref *names* for the string "27" instead of resolving the branch
named in the handoff) and is withdrawn.

#### 4. STANDING BLOCKER — this run is on `main` through 0068, not PR #27's configured stacked head

The working tree is `main` @ `48bef9c` with migrations through **0068**. The configured target is
PR #27's stacked head `feature/of-016-duplicate-review-resolution` @ `1b679e2` (base
`feature/found-006-caller-trust-boundary` @ `be2f13e`) with migrations through **0089**. The v5
master guide section 2 is explicit — "Do not start from `main`. The current work is a stacked branch
series. Checking out `main` would omit accepted and reviewed migrations and application changes" —
and section 2.1 requires the preflight to check out that head and confirm its SHA before substantive
work.

Migrations `0069`–`0089` and the whole FOUND-006 / OF-016 application stack are therefore outside
this working tree. This session did not switch to that head: branch and checkout operations for this
clone are owned by Conductor, not by this run. Having fetched the objects is not the same as being
at the head — the preflight target is unmet, so the blocker stands.

#### 5. PR #27 was NOT technically accepted

The run did not accept PR #27 as its working target: it never resolved to the PR #27 head, and the
independent diff inspection and exact-head gate reproduction the pack requires before local
technical acceptance (master guide section 2.2 and Stage 0) were not performed. Nothing in PR #27
was reviewed, approved, rejected, merged, closed, or otherwise dispositioned by this run. "Not
technically accepted" is a statement about this run's intake only and carries no judgement about the
PR's content or merit; in particular, the OF-016 correction-loop budget recorded as 2/2 spent is
untouched by this checkpoint.

#### 6. No v5 implementation was attempted

No runtime code, migration, schema, contract, feature flag, test, or requirement status was created,
edited or deleted. No migration number beyond 0068 was reserved or written. No hosted database
action, deployment, flag flip, or branch/PR operation was performed. The only changes made under
this checkpoint are this ledger entry and its counterpart in `IMPLEMENTATION_LEDGER.md`.

#### 7. Not claimed (explicitly)

This checkpoint does NOT claim that repository permission is missing. The non-mutating write-access
check the pack requires (master guide section 2.1; handoff section 8 — contents read/write, pull
requests read/write, metadata read, Actions read where available) has not been run in this session,
so no conclusion about access — present or absent — is recorded. Any future statement about
repository access must cite an actual observed check.

#### 8. EXACT NEXT RESUMABLE ACTION

Rerun the v5 preflight against the **configured PR #27 head** —
`feature/of-016-duplicate-review-resolution`, expected
`1b679e20990e6b58d048e036645e3f5647b4f3d2`, or a newer verified head if the remote has advanced
(inspect the newer head; do not reset the branch to this SHA) — **not** `main`, **not** `48bef9c`.
Carry forward:

1. the **authoritative v5 pack** — supplied and read in full this session (section 1 above); it is no
   longer an outstanding input and must be re-attached to the resuming run; and
2. **GitHub write-access evidence** — the actual observed result of the non-mutating write-access
   check for `MUA1234/bot_business_Singha`, produced during that run and quoted in its report.

The rerun preflight passes only when the working tree actually resolves to the PR #27 head (SHA
confirmed, or the advance documented) and the write-access evidence has been produced. If the
checkout target is still unmet, stop again and append the next BP-nnn checkpoint here rather than
proceeding from `main` or any other substitute base.

## Deferred (deliberate, owner-visible)

| Item | Why deferred | Where reported |
|---|---|---|
| Email provider integration | No provider configured/purchased (owner gate) | `/api/health` (`email: not_configured`) — Phase 5 wires this |
| GPS / CCTV / facial recognition / bank-transfer execution / autonomous legal-HR | Separately gated (legal/privacy review) — excluded by standing instruction | CLAUDE.md restrictions |
| Hosted migrations, flag flips, merge, production promotion | Owner-only actions | this ledger, every slice |

## Owner gates outstanding (program-wide)

1. ~~Merge authorization for PR #13 and each stacked completion PR.~~ **GRANTED** (owner, 2026-08):
   PR #13 merged (`9d16921`); standing instruction is now "every slice merges to `main`", with
   `main` deployed to the stable production URL. Merge is no longer a per-slice gate; the gates
   below still are.
2. Hosted migration application — **handed to the owner, NOT observed applied.** The owner asked for
   the SQL separately: `docs/architecture-v2/HOSTED_MIGRATION_0042_TO_0068.sql` (one transaction;
   PART 0 guards + `REVOKE CREATE ON SCHEMA public FROM anon, authenticated, service_role`; ledger
   baseline; 0042→0068). Verified only on a disposable PostgreSQL 16 (fresh + upgrade). **No hosted
   evidence exists in this repo and none may be claimed.** Until it is applied, the hosted database
   is missing the delivery/approval RPCs these slices assume.
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
