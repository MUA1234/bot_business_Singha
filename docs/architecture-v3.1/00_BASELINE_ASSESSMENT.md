# V3.1 Baseline Assessment

> **Mandatory first deliverable** for the Singha Management Intelligence V3.1 program
> (pack `00_START_HERE.md` §"Mandatory first action", item 4; `34_CLAUDE_GITHUB_MASTER_COMMAND.md`
> STEP 0). This file is written from the **actual repository state**, not from the pack's
> historical narrative. Every claimed control below was checked against SQL / TypeScript /
> tests in this tree — not against documentation alone.

## 1. Verified repository state (session start)

| Item | Verified value | How verified |
|---|---|---|
| Repository | `MUA1234/bot_business_Singha` | git remote |
| Default branch | `main` | `git branch -a` |
| Working branch (this session) | `claude/new-session-1b9vj3` | owner task instruction |
| HEAD SHA | `579057917fb2540dc83fe79154b330ad928e1d23` | `git rev-parse HEAD` |
| `main` SHA | `579057917fb2540dc83fe79154b330ad928e1d23` | `git rev-parse main` |
| Relationship to pack baseline | **identical** — HEAD == the pack's reviewed reference | SHA comparison |
| Working tree at start | clean | `git status` |
| Visibility | Public (per pack; treat as IP-exposure risk) | pack `00_START_HERE.md` |
| Toolchain | Node v22.22.2, npm 10.9.7, PostgreSQL 16 (CI service) | `node -v`, `.github/workflows/ci.yml` |

The pack's reviewed reference and the live HEAD are the **same commit**, so there is no
intervening third-party work to reconcile at start. This branch begins exactly at that commit.

## 2. Existing foundation (confirmed present, not greenfield)

Confirmed by direct inspection of the tree:

- **Framework:** Next.js 14 (App Router) + TypeScript (strict), Zod validation, Inngest jobs.
- **Data/auth:** Supabase (Postgres + RLS + Auth + Storage) via `@supabase/ssr` / `@supabase/supabase-js`.
- **Accounting Core:** internally-owned double-entry engine under `src/accounting/*` + SECURITY
  DEFINER posting RPCs. **QuickBooks is not used** (DECISIONS D-011) — no `quickbooks`/`intuit`
  imports in `src`.
- **WhatsApp:** official Meta Cloud API only. No `whatsapp-web.js` / Baileys / `venom-bot`
  anywhere in `src` or `package.json` (grep verified empty).
- **Migrations:** forward-only SQL `0001`–`0047` in `src/db/migrations/` (47 files, sequential).
- **Feature flags:** env-var convention `X === "on"`, default OFF, centralised in
  `src/config/env.ts` (`flags.rlsReads`, `flags.rlsWrites`, `flags.whatsappAsync`) and mirrored in
  `src/lib/supabase/read.ts`. Default OFF = **zero behaviour change**.
- **Tests:** 75 unit test files under `tests/*.test.ts`; disposable-Postgres integration/RLS/
  concurrency suite under `tests/integration/`.
- **CI:** `.github/workflows/ci.yml` — two required jobs: `verify` (secret-scan, migration-lint,
  typecheck, lint, unit, build, audit-check) and `db-tests` (disposable Postgres 16 + Supabase
  shim + migrations + integration suite) which **fails loud, never skips**.

## 3. Baseline gates (run this session, clean checkout of HEAD)

| Gate | Command | Result |
|---|---|---|
| Install | `npm ci` | pass (exit 0) |
| Unit tests | `npm test` | **pass — 75 files / 374 tests** |

The remaining static gates (secret-scan, migration-lint, typecheck, lint, audit-check, build) are
re-run after this slice's changes and recorded in `IMPLEMENTATION_LEDGER.md`. Database gates require
a disposable Postgres 16 (CI's `db-tests` job or a local instance); this slice adds **no migration**
and **no database-sensitive code**, so it does not depend on them, but they remain the gate before
any future V3.1 database slice.

## 4. Document contradictions found (must be reconciled, per pack WP18)

Verifying claims against reality surfaced contradictions in the existing docs. These are recorded
here rather than silently "fixed", because reconciliation of migration/verification docs is itself a
tracked work item (pack `00A` WP18):

1. **Unit-test count.** `AGENTS.md` and `CLAUDE.md` headers state *"195 passing unit tests
   (46 files)"*. The **actual** result at HEAD is **374 tests / 75 files** (`npm test`, this
   session). `docs/CURRENT_IMPLEMENTATION_STATUS.md` already states 374 / 74 files — essentially
   correct. The `AGENTS.md`/`CLAUDE.md` header numbers are **stale** and should not be trusted as
   current evidence.
2. **Hosted migration applied-state.** `docs/CURRENT_IMPLEMENTATION_STATUS.md` and
   `docs/architecture-v2/MIGRATION_STATE.md` carry qualified, partly-contradictory statements about
   which of `0038`–`0047` are applied to the hosted database. Per pack WP18, hosted state must **not**
   be inferred from file existence, local tests, or a Vercel deploy — it is **owner-confirmation-
   required** until the owner authorises reading the hosted migration ledger. This session touches
   no hosted database.

## 5. Correction prerequisite `0048+` (WP10–WP18) — status: **NOT DONE (blocking)**

Per `00_START_HERE.md` item 3 and `34_CLAUDE_GITHUB_MASTER_COMMAND.md` STEP 1, I determined whether
the security/accounting correction phase `0048+` is complete.

**Finding:** the highest migration on this branch is `0047`. There is **no `0048`** migration and
none of the pack `00A` work packages **WP10–WP18** are implemented. Therefore the correction phase is
**not done**.

Consequence (authoritative for the V3.1 program): the `0048+` correction is a **blocking
prerequisite** for any V3.1 slice that depends on financial posting, approval authority, RLS
write-cutover, or truthful outbox/quotation state. Specifically, these V3.1 capabilities MUST NOT be
cut over until `0048+` lands and is verified:

| Pack WP | Correction | Blocks V3.1 dependency on… |
|---|---|---|
| WP10 | Remove broad company-member writes on sensitive tables | Team/quotation/order/approval write paths under RLS |
| WP11 | Approval authority: org scope + currency + delegation bounds | Decision-path selection that touches financial authority |
| WP12 | Truthful quotation/order delivery state | AI Guide / Task Room reporting "sent" |
| WP13 | Posted-journal immutability allowlist | Any journal-linked task outcome |
| WP14 | Canonical-JSON idempotency fingerprints | Idempotent AI-proposed financial actions |
| WP15 | Invoice/bill document invariants | Finance events surfaced to managers |
| WP16 | Reimbursement/payment reuse validation | Expense/reimbursement task flows |
| WP17 | Explicit system-actor path | AI/worker-initiated actions in the audit trail |
| WP18 | Reconcile migration/verification docs | Trustworthy status for release gates |

**This slice does not depend on any of the above** — it is scaffolding only (see §6), so it is safe
to land ahead of `0048+`. No V3.1 automation is enabled.

## 6. Scope cleanliness (call-answering exclusion) — **CLEAN**

Per `34_CLAUDE_GITHUB_MASTER_COMMAND.md` SCOPE EXCLUSION, V3.1 is **not** the AI Call Answering
System. Grep across `src/` and `docs/` for `twilio|livekit|vapi|retell|sip|webrtc|voice
receptionist|call recording|telephony` returned **no** contaminating references. The repository's
only external-comms integration is the approved official WhatsApp management flow. Scope is clean.

## 7. First approved V3.1 slice (this session)

Following the pack completion sequence
`Baseline -> correction prerequisites -> V3 foundations -> …` and STEP 2 slice 1 ("canonical
contracts, feature flags, implementation ledger and compatibility foundation"), this session delivers
the **compatibility foundation only**:

- `src/config/flags.ts` — a typed V3.1 feature-flag **registry**, every flag default **OFF**,
  consumed by no business logic yet (shadow). Zero behaviour change.
- `src/schemas/v3_1/*` — canonical V3.1 **contracts** (Zod): Decision Path Ladder, Task Intelligence
  Profile, role-first Team Formation, shared AI Guide. **Proposals only — nothing executes.** Reuses
  the existing `AuthorityLevel` / `RiskClass` from `src/schemas/management.ts` (no competing
  authority vocabulary).
- `docs/architecture-v3.1/` — this assessment, a sanitised execution spec, and the implementation
  ledger.
- Additive precedence pointers in `AGENTS.md` / `CLAUDE.md`.

**Explicitly out of scope this session** (deferred, dependency-ordered): the `0048+` correction; any
migration; task-detection, decision-path, team-formation, AI-guide **runtime**; manager UI;
multilingual/mobile; the model-routing control plane; any hosted action or flag flip.

## 8. Owner gates recorded

- `OWNER_GATE_IP_MODE` — repository is **public**. Only a sanitised implementation subset is
  committed (see `01_V3_1_EXECUTION_SPEC.md`); the full confidential pack, prompts, evaluation
  datasets and ranking weights are **not** committed. Owner decision on making the repo private is
  still required (`29_ANTI_CLONE_AND_IP_PROTECTION.md`).
- `NO_HOSTED_DEPLOYMENT_PERFORMED` — no Vercel deploy, no hosted Supabase action, no migration
  applied, no feature flag enabled.
