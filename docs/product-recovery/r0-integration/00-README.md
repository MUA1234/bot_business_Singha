# R0 integration preparation

**Authorised scope: Phase R0 — establish truth. Read-only analysis and safe local
tooling.** No merge, no rebase, no renumbering of any real migration, no deployment, no
hosted contact of any kind.

| | |
|---|---|
| Head | `claude/product-recovery-r1` @ `0c789d366023eca05a418348cc07923672651428` |
| Base | `origin/main` @ `acd9fbec35d3075c8faba1c6bbb9b4aaca1ab164` |
| Date | 2026-09-10 |
| Hosted contact | **none** |
| Production changes | **none** |

---

## Documents

| # | Document | What it settles |
|---|---|---|
| 01 | [Migration dependency inventory](01-MIGRATION-DEPENDENCY-INVENTORY.md) | What collides, what depends on what, and what the runner actually does — proven by execution |
| — | [`01-migration-matrix.json`](01-migration-matrix.json) | The machine-readable matrix: number, filename, SHA-256, branch, objects, dependencies, dependants |
| 02 | [Migration decision tree](02-MIGRATION-DECISION-TREE.md) | What to do for each possible hosted answer. Case A is **not** assumed |
| 03 | [Hosted-state checklist](03-HOSTED-STATE-CHECKLIST.md) | Exact read-only SQL for the owner/developer to run against hosted Supabase |
| — | [`03-expected-objects-0069-0109.json`](03-expected-objects-0069-0109.json) | The 27 tables / 63 functions / 56 columns the branch range defines, per migration |
| 04 | [Railway evidence checklist](04-RAILWAY-EVIDENCE-CHECKLIST.md) | Non-secret deployment, provenance and scheduler evidence to collect |
| 05 | [Main-regression reconciliation](05-MAIN-REGRESSION-RECONCILIATION.md) | Per-file disposition for every conflicting implementation |
| 06 | [Merge-candidate strategy](06-MERGE-CANDIDATE-STRATEGY.md) | The non-destructive path from here to a proposable candidate |
| 07 | [Corrections](07-CORRECTIONS.md) | Unverified production facts and wrong failure descriptions, corrected |
| 08 | [Local verification](08-LOCAL-VERIFICATION.md) | Every gate, rehearsal and mutation result measured at this SHA |

---

## The three findings that matter

**1. The divergence is one migration, not forty.** 0001–0068 are **byte-identical**
between `main` and the recovery branch. The entire migration divergence is one collision at
`0069` plus a clean 40-migration append. This is a far narrower reconciliation than "324
commits ahead" implies.

**2. The collision's consequence was described wrongly everywhere, and is now measured.**
Applying the branch over a ledger seeded with `main` 0001–0069 does **not** silently run
0070–0109. It applies and commits **0070–0075**, then **halts loudly at 0076**
(`column "next_attempt_at" does not exist`), leaving a **partially migrated** database at
ledger high-water `0075` that is neither line. The numbered sequence has **no
down-migrations**, so recovery means restore-from-backup — which makes a proven rollback a
*precondition* of any apply, not a follow-up.

**3. The branch's central capability is inert without `main`'s scheduler.** `scheduler.ts`
exists only on `main`. The branch's `inbound-sweeper` and `dispatch-drain` are declared
**only** as Vercel crons and are absent from `main`'s `DEFAULT_JOBS`. Deployed to Railway as
it stands, with Vercel disabled, nothing would drive them — the durable inbound processing
that the branch's 0069 exists to provide would never run.

**4. The test picture, measured rather than assumed** (details in
[08-LOCAL-VERIFICATION.md](08-LOCAL-VERIFICATION.md)):

| Scope | Result |
|---|---|
| Unit | ✅ 2443 passed, 0 failed |
| **Core integration** (74 files, clean CI-faithful DB) | ✅ **671 passed, 0 failed** |
| **R1/R2 kernel** (own canonical harness) | ❌ **5 files / 13 tests failed**; 12 reproduce in 11.8s |
| Whole `tests/integration/**` in one run | ❌ fails either way — cross-test pollution |

The kernel failures **pre-date this work** (`b3e1516` touches no `src/` file) and contradict
the "Verified at this SHA" table in `../AUTONOMOUS-STATE.md`, now corrected. The three
`r1-security-baseline` failures are legitimate access **refused**, not data exposed; no
isolation assertion failed. And CI's integration job cannot be green as configured, because
it sweeps 35 quarantined kernel files.

---

## Tooling added

| Command | Purpose |
|---|---|
| `npm run migration-inventory` | Generates the dependency matrix (read-only; git + working tree only) |
| `npm run migration-collision-check` | Base-aware collision gate against `origin/main` |
| `npm run verify:merge-candidate` | `verify` plus the collision gate |

**`npm run migration-collision-check` currently FAILS, by design.** It reports the real
`0069` collision. That is the finding this work exists to surface, not a regression.

It is deliberately **not** yet part of `npm run verify`: `verify` must stay usable for
unrelated work while the collision is unresolved. Once the merge candidate exists and the
gate passes on it, fold it into `verify` and CI so no future branch can reintroduce the
class.

Source: `scripts/lib/migration-graph.mjs` (parser core), `scripts/lib/migration-collision.mjs`
(the five failure conditions), `scripts/lib/migration-git.mjs` (git I/O),
`scripts/migration-inventory.mjs`, `scripts/migration-lint.mjs --base`.
Behavioural tests: `tests/migration-collision.test.ts` — synthetic main/branch sets, 18 tests,
all four disable-the-check mutations caught.

---

## What is required from outside this repository

Nothing further can be settled from inside the repository. Two evidence packages are needed:

1. **[Hosted-state checklist](03-HOSTED-STATE-CHECKLIST.md) Q1–Q9** — catalogue metadata
   and the migration ledger. No customer or business records.
2. **[Railway checklist](04-RAILWAY-EVIDENCE-CHECKLIST.md) R1–R6** — deployment provenance
   and scheduler configuration. Names and presence only; **never secret values**.

The single decisive item is **Q2** (every `schema_migrations` row) cross-checked against
**Q4** (which 0069's object markers are actually present). Until both are returned, hosted
migration state is **UNKNOWN** and no numbering decision is final.

---

## Precedence note

Where this package conflicts with an older document, the owner's decisions of 2026-09-02
(`../13-OWNER-DECISIONS-RECORD.md`) and the architecture decisions recorded in the
2026-09-10 instruction govern:

1. Railway is the intended single application/scheduler host.
2. Vercel cron scheduling must not coexist with the Railway scheduler.
3. `channel_accounts` + `resolve_channel_company` is the canonical channel/company design.
4. `companies.whatsapp_phone_number_id` is a legacy **backfill source only**, not a
   competing permanent routing model.
5. Database tenant isolation/RLS must be enabled and proven in isolated staging before
   production.
6. **None of these decisions authorises deployment or hosted modification.**
