# V3.1 Implementation Ledger

> SHA-bound record of what was implemented, verified and deferred in the V3.1 program. Update this
> file at the end of every slice. Do not claim a gate passed unless its actual output was produced
> this session. "Verified" here means **local/CI evidence**, never hosted-database or production
> evidence.

## Program invariants (carried every slice)

- Feature flags default **OFF** → zero behaviour change until an owner-approved flip.
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
