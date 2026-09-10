# Branch and PR reconciliation — where the Asset Management and multilingual work went

> Performed **before any code was written** for the follow-up program, as required.
> Method: `git fetch --all --prune`, then a tree scan of **every** remote ref (not just `main`),
> plus an enumeration of **all 22 pull requests** in every state.
> Date: 2026-08-17. Follow-up branch base: `7669ce1` (frozen PR #22 head).

## Answer

**Neither feature exists anywhere in this repository.** They were **never implemented** — not on
another branch, not in an unmerged commit, not in a closed or open PR. They exist only as
*aspirational sentences inside specification prose*, and — for multilingual — as a feature-flag
*description string*.

This is not "committed but not included in PR #22", and it is not "documentation of a built
feature". There is no runtime code, no migration, no table, no UI and no test for either.

## Evidence — every remote branch scanned

Scan: for each ref, list the full tree and count paths matching
`asset|reservation|custody|meter|utilization` and `i18n|locale|sinhala|tamil|translat`.

| Branch | Head | Migrations | Highest migration | asset-ish files | i18n-ish files |
|---|---|---|---|---|---|
| `origin/main` | `48bef9c` | 68 | `0068_ai_atomic_case_persistence.sql` | **0** | **0** |
| `origin/claude/new-session-1b9vj3` (PR #22) | `7669ce1` | 68 | 0068 | **0** | **0** |
| `origin/docs/ledger-ui-slices` | `070dadc` | 68 | 0068 | 0 | 0 |
| `origin/feature/owner-control-copy` | `4bb00bd` | 68 | 0068 | 0 | 0 |
| `origin/feature/singha-central-rebrand` | `22aef1a` | 68 | 0068 | 0 | 0 |
| `origin/feature/v3-2-completion-ui-refresh` | `38344a5` | 68 | 0068 | 0 | 0 |
| `origin/feature/v3-2-completion-phase0-truth-reset` | `8cc2cc5` | 68 | 0068 | 0 | 0 |
| `origin/feature/v3-2-completion-phase1-correctness` | `ca79ffc` | 68 | 0068 | 0 | 0 |
| `origin/feature/v3-1-phase-1-external-review-fixes` | `26da52d` | 67 | 0067 | 0 | 0 |
| `origin/feature/v3-1-phase-1-wp12-truthful-delivery` | `da032cf` | 55 | 0055 | 0 | 0 |
| `origin/feature/v3-1-phase-1-wp18-migration-state-docs` | `509685b` | 55 | 0055 | 0 | 0 |
| `origin/feature/v3-1-phase-1-wp11-approval-scope` | `7bfacf6` | 54 | 0054 | 0 | 0 |
| `origin/feature/v3-1-phase-1-wp16-reimbursement-reuse` | `d62d798` | 53 | 0053 | 0 | 0 |
| `origin/feature/v3-1-phase-1-wp15-invoice-bill-invariants` | `74aa0ff` | 52 | 0052 | 0 | 0 |
| `origin/feature/v3-1-phase-1-wp14-canonical-fingerprints` | `edcc60d` | 51 | 0051 | 0 | 0 |
| `origin/feature/v3-1-phase-1-wp13-journal-immutability` | `8dad0ff` | 50 | 0050 | 0 | 0 |
| `origin/feature/v3-1-phase-1-wp17-system-actor` | `4f6022b` | 49 | 0049 | 0 | 0 |
| `origin/feature/v3-1-phase-1-corrections-0048` | `a2ff75c` | 48 | 0048 | 0 | 0 |
| `origin/feat/app-layer-dashboards-whatsapp` | `e0a8c55` | 7 | 0007 | 0 | 0 |

**No branch anywhere carries a migration beyond 0068.** An asset registry, custody, reservation,
meter-reading or utilization feature would require tables; no such migration exists on any ref.

## Evidence — all 22 pull requests

| PRs | Subject | Relevance |
|---|---|---|
| #1, #2 | App-layer dashboards + WhatsApp (2026-08-04) | no asset/multilingual |
| #3, #4 | V3.1 slice 0 (flags + contracts), WP10 RLS | no |
| #5–#12 | Phase-1 WP13–WP18 stacked drafts — **still open**, superseded | no |
| #13 | Phase-1 integrated corrections (0048–0067) — closed, content reached `main` via #17 | no |
| #14–#17 | Completion P0/P1/UI → `main` | no |
| #18–#21 | Singha Central rebrand, landing copy, ledger | no |
| #22 | Overnight verification campaign — **open draft, frozen at `7669ce1`** | no |

## What DOES exist (documentation only)

| Claim | Location | Nature |
|---|---|---|
| "supports English/Sinhala/Tamil" | `docs/architecture-v3.1/01_V3_1_EXECUTION_SPEC.md:17` | A goal sentence in a program vision paragraph. No slice, no schema, no code. |
| Sinhala/English mixing quality supervision | `docs/AI_BUSINESS_MANAGER_MASTER_SPEC.md:433` | Aspirational; part of the customer-facing-agent scope that is **explicitly gated/forbidden** by CLAUDE.md. |
| `V3_1_MULTILINGUAL`-style flag text | `src/config/flags.ts` | A *description string* for a default-OFF flag with **zero runtime consumers**. |
| Asset Management / Utilization / Optimization | **nowhere** | No spec section, no flag, no contract, no table. The word "asset" in `src/` refers to accounting asset accounts and to a free-text `involved.assets[]` field the AI fills in and nothing reads. |

Note the asymmetry worth stating plainly: multilingual at least appears as an intention in a spec.
**Asset Management does not appear even as a specification** in this repository — there is no
document defining an asset registry, its lifecycle, custody, reservations, meter readings, or a
utilization/optimization engine. If such a specification was written, it is not in this repo.

## Consequence for this follow-up program

1. Nothing to reconcile, stack or integrate — there is no asset branch and no multilingual branch.
   The instruction "do not mix it into the architectural blocker PR" is satisfied vacuously.
2. Neither feature may be described as complete, partial, or in progress. They are **not started**.
3. Section 7's conditional evaluation dimensions ("asset recommendations *if* the asset branch is
   later included", "multilingual consistency *if* the multilingual branch is later included")
   remain **inapplicable** and are recorded as such rather than scored.
4. Building either is a **new feature program** requiring its own owner-approved specification —
   explicitly out of scope for an architectural-blocker PR, and not attempted here.

## Housekeeping observation (not acted on without instruction)

PRs **#5–#12 are still open** against stacked bases whose content was long ago integrated into
`main` via PR #17. They are stale and will never merge as they stand. Closing them would make the
PR list reflect reality, but closing another person's PRs is not something this program will do
unprompted — recorded here as an owner decision.
