# V3.1 Implementation Ledger

> SHA-bound record of what was implemented, verified and deferred in the V3.1 program. Update this
> file at the end of every slice. Do not claim a gate passed unless its actual output was produced
> this session. "Verified" here means **local/CI evidence**, never hosted-database or production
> evidence.
>
> **2026-08-17 — completion program started (owner-authorized).** Slice 1 (the `0048+` correction
> prerequisite) is IMPLEMENTED + locally verified as migrations 0048–0067 after ten external-review
> rounds (PR #13, draft, head `48407bd`); slices 2–10 are being implemented as stacked PRs. Live
> program tracking (branches, SHAs, tests, owner gates, verification-state taxonomy) moved to
> `COMPLETION_LEDGER.md` — this file remains the per-slice V3.1 history.

## Program invariants (carried every slice)

- Feature flags default **OFF** → the **flag-gated cutover** they control (RLS reads/writes, async
  delivery mode) stays inert until an owner-approved flip. This does **not** make every migration
  inert: security/accounting hardening (e.g. `decide_approval`, composite FKs, the currency catalogue,
  the WP12 sync delivery path) is active for any caller once the DB is migrated — the containment for
  unreviewed work is the **un-migrated hosted DB**, not the flags (see `PHASE1_CONSOLIDATION_REPORT.md`).
- Forward-only migrations; applied migrations are immutable; next free number discovered from the
  branch.
- AI output: Zod → deterministic authority/policy → permission → audit. Nothing free-text executes.
- No hosted deployment / migration / flag flip without explicit owner authorisation.

## Slice 0 — Compatibility foundation (flags + canonical contracts + docs)

- **Branch:** `claude/new-session-1b9vj3`
- **Base SHA:** `579057917fb2540dc83fe79154b330ad928e1d23` (== pack reviewed reference)
- **Final SHA:** _stamped in the slice commit; see `git log` on the branch._

### Scope

Compatibility scaffolding only — no migration, no database-sensitive code, no runtime wiring, no UI.

### Files added

| Path | Purpose |
|---|---|
| `docs/architecture-v3.1/00_BASELINE_ASSESSMENT.md` | Evidence-based baseline, 0048 gap, doc contradictions, scope-clean proof. |
| `docs/architecture-v3.1/01_V3_1_EXECUTION_SPEC.md` | Sanitised (public-safe) execution spec + slice plan. |
| `docs/architecture-v3.1/IMPLEMENTATION_LEDGER.md` | This ledger. |
| `src/config/flags.ts` | Typed V3.1 feature-flag registry, all default OFF, shadow-only. |
| `src/schemas/v3_1/index.ts` | Barrel + `V3_1_CONTRACTS_VERSION`. |
| `src/schemas/v3_1/decision-path.ts` | Decision Path Ladder contract (4 rungs, one recommended). |
| `src/schemas/v3_1/task-intelligence-profile.ts` | Task Intelligence Profile contract. |
| `src/schemas/v3_1/team-formation.ts` | Role-first Team Formation contract. |
| `src/schemas/v3_1/ai-guide.ts` | Shared AI Guide contract. |
| `tests/v3_1-flags.test.ts` | Flags default-off + parsing proofs. |
| `tests/v3_1-contracts.test.ts` | Contract accept/reject proofs. |

### Files edited (additive only)

| Path | Change |
|---|---|
| `AGENTS.md` | Additive V3.1-program pointer + 0048 prerequisite note. |
| `CLAUDE.md` | Additive V3.1-program pointer + 0048 prerequisite note. |

### Behaviour-change assertion

No existing runtime module imports `src/config/flags.ts` or `src/schemas/v3_1/*`. The new flags are
read nowhere. Therefore this slice is provably **zero behaviour change** with all flags OFF (which is
their only state).

### Gate results (this session, clean checkout of HEAD + slice)

| Gate | Command | Result |
|---|---|---|
| Baseline unit tests (pre-change) | `npm test` | pass — 75 files / 374 tests |
| Secret scan | `npm run secret-scan` | **pass** — no tracked secrets |
| Migration lint | `npm run migration-lint` | **pass** — 47 migrations, sequential 0001–0047 |
| Typecheck | `npm run typecheck` | **pass** |
| Lint | `npm run lint` | **pass** — pre-existing `<img>` warnings only |
| Unit tests (post-change) | `npm test` | **pass — 77 files / 396 tests** (+2 files / +22 tests, all new) |
| Dependency audit | `npm run audit-check` | **pass** — 2 approved exceptions (next, postcss) |
| Build | `npm run build` | **pass** (placeholder public env) |
| Database suite | `npm run test:integration` | **not run locally** — no DB provisioned this session; N/A for this slice (no migration, no DB-sensitive code). CI's `db-tests` job runs it unchanged on push. |

Toolchain: Node v22.22.2, npm 10.9.7. Run from a clean checkout of the branch after the slice.

**Zero-behaviour-change proof:** no runtime module under `src/` imports `src/config/flags.ts` or
`src/schemas/v3_1/*` (grep verified); the only importers are the V3.1 barrel and the two new test
files. All flags are default OFF with no other state. The `AGENTS.md`/`CLAUDE.md` edits are additive
(18 insertions, 0 deletions).

### CI history (PR #3) — pre-existing GitHub Actions provisioning failure (OWNER ACTION)

Observed via the Actions API this session: **every** `ci.yml` run in this repository — run **#1
(2026-08-05) through #17 (this PR)**, on both `push` and `pull_request` — has ended in `failure`
after **0–10 seconds with no runner ever assigned** (`runner_id: 0`, no steps executed, job logs
return HTTP 404). The workflow YAML is valid (GitHub parses both `verify` and `db-tests` jobs); the
runners simply never attach. Vercel's own integration built commit `6e3f9aa`/`eb051e4` successfully,
so the application code is sound.

Conclusion: this is a **repo/account-level GitHub Actions runner-provisioning problem that predates
V3.1** — not a code or workflow failure, and not fixable by any commit. CI has **never** passed in
this repository. Most likely cause on a public repo (where GitHub-hosted minutes are free): Actions
is disabled/restricted, or the owning account (created 2026-07) is not yet verified for GitHub-hosted
runners, or a $0 spending policy blocks runner provisioning.

**Owner action required** (repo `Settings → Actions → General`, and account
`Settings → Billing → Actions`): confirm Actions is enabled with "Allow all actions", GitHub-hosted
`ubuntu-latest` runners are permitted, and the account is verified with a spending limit that allows
runner provisioning. Until then, CI evidence for this PR is the **local** gate run recorded above;
the automated `verify` + `db-tests` jobs cannot go green regardless of PR content.

The re-run API is not available to this integration (`403 Resource not accessible by integration`);
run #17 was a follow-up push confirming the failure reproduces identically on a fresh run.

## Blocked-preflight checkpoint BP-001 — v5 preflight, 2026-08-20 (no v5 work attempted)

Recorded in full in `COMPLETION_LEDGER.md` §"Blocked-preflight checkpoints (durable)" → **BP-001**,
including the 2026-08-20 correction described below. Summary, so this ledger stands alone:

- **Mandatory v5 documents — PRESENT as attached run input, all three read in full.**
  `SINGHA_AI_BUSINESS_MANAGER_MASTER_AUTONOMOUS_DEV_GUIDE_v5.md` (52,883 bytes, all 1,288 lines),
  `SINGHA_AI_BUSINESS_MANAGER_CURRENT_HANDOFF_v5.md` (5,359 bytes) and
  `SINGHA_AI_BUSINESS_MANAGER_USAGE_OPTIMISATION_POLICY_v5.md` (6,671 bytes) were all readable and
  were read end to end from the attached pack
  `.conductor/brief/SINGHA_AI_BUSINESS_MANAGER_CONDUCTOR_DEV_PACK_v5.zip`. The pack is an attached
  run input, **not** repository content — it is untracked and git-excluded (`/.conductor/`), which is
  why the repository-only searches did not see it, and it must not be committed.
  **Correction:** this checkpoint originally recorded all three as absent. That was true of the
  tracked tree but false as a missing-input claim; the claim is withdrawn. The three files remain
  absent from the tracked repository tree (no `docs/architecture-v5/`, no tracked filename containing
  `v5`) — a fact about repository content, not a blocker.
- **Observed checkout:** branch `main`, head `48bef9c1552e9595d0a924fcdc4d37d22bf40a7a` (`48bef9c`,
  "Merge PR #21 …", 2026-08-18), working tree clean, migrations `0001…0068` sequential (68 files,
  highest `0068_ai_atomic_case_persistence.sql`).
- **STANDING BLOCKER — wrong checkout target.** The run is on `main` through migration 0068, not
  PR #27's configured stacked head `feature/of-016-duplicate-review-resolution` @
  `1b679e20990e6b58d048e036645e3f5647b4f3d2` (base `feature/found-006-caller-trust-boundary` @
  `be2f13ee9ede90b58a69a86069bbd10f9d9c5106`), which carries migrations through **0089**. Both remote
  SHAs were resolved in this clone via remote-tracking refs and `git ls-tree`, without checkout — the
  original entry's claim that no ref corresponded to a PR #27 head came from a bad check and is also
  withdrawn. Having the objects fetched is not being at the head; migrations `0069`–`0089` and the
  FOUND-006/OF-016 stack are outside this working tree, and the v5 master guide §2 forbids starting
  from `main`. Branch/checkout operations for this clone are Conductor's, not this run's.
- **PR #27 was not technically accepted** by that run: it never resolved to the PR #27 head, and the
  independent diff inspection plus exact-head gate reproduction required before local technical
  acceptance were not performed. Nothing in PR #27 was reviewed, merged, closed or otherwise
  dispositioned; the OF-016 2/2 correction-loop budget is untouched.
- **No v5 implementation was attempted.** No runtime code, migration, schema, flag, test or
  requirement status changed; no migration number beyond 0068 reserved; no hosted, deployment or
  branch/PR action taken. The only changes are the checkpoint texts themselves.
- **Not claimed:** the non-mutating GitHub write-access check required by the pack was not run, so no
  claim about repository permission is made in either direction.
- **Exact next resumable action:** rerun against the **configured PR #27 head**
  (`feature/of-016-duplicate-review-resolution`, expected `1b679e2…`, or a newer verified head if the
  remote advanced), carrying (1) the **authoritative v5 pack** — already supplied and read, to be
  re-attached — and (2) **GitHub write-access evidence** actually observed during that run. If the
  checkout target is still unmet, stop and append the next `BP-nnn` checkpoint rather than proceeding
  from `main`.

This checkpoint changes no V3.1 slice status, no deferral, and no owner gate below.

## Deferred (dependency-ordered) — see `01_V3_1_EXECUTION_SPEC.md` §5

1. **`0048+` correction prerequisite (WP10–WP18)** — blocking for all finance/RLS/outbox-dependent
   slices.
2. Task detection + Task Intelligence Profile runtime.
3. Decision Path Ladder runtime + authority-checked selection.
4. Role-first team formation runtime.
5. Shared AI Guide runtime + scoped visibility.
6. Improvement/outcome loop (shadow).
7. Manager Mission Control.
8. Responsive/PWA + versioned mobile APIs + EN/SI/TA.
9. Runtime model-routing control plane.
10. Deployment-readiness docs/config (no hosted action).

## Owner gates still open

- `OWNER_GATE_IP_MODE` — make the repository private (recommended) or keep the confidential pack out
  of GitHub. Only the sanitised subset is committed.
- Hosted migration application (`0044`–`0047` and future `0048+`) — owner action.
- Any feature-flag flip — owner action after staging UAT.
