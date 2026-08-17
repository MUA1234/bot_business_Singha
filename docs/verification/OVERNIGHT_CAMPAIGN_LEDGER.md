# Overnight Verification Campaign — checkpoint ledger

> Bounded, autonomous verification campaign authorised by the owner (2026-08-17). This ledger is
> the recovery point: if the worker restarts, resume from the last CHECKPOINT row. Nothing in this
> campaign merges a PR, applies a hosted migration, deploys production, enables a flag, touches real
> data, or sends a real message.

## Scope anchors

| Item | Value |
|---|---|
| Base / tested head | `48bef9c` (merge of PR #21) — campaign branch cut from `main` at this SHA |
| Campaign branch | `claude/new-session-1b9vj3` |
| Migration range | 0001–0068 (sequential, no gaps — verified by `migration-lint`) |
| Database under test | **disposable** PostgreSQL 16.13, `127.0.0.1:55433/singha_fresh` — local only |
| Hosted DB | 0038–0041 only; **NOT migrated during this campaign** and not contacted |
| Feature flags | all 8 V3.1 flags OFF; not flipped during this campaign |
| Model provider | **none configured** — no `OPENAI_API_KEY`; live-model evaluation is BLOCKED (see §Blocked) |

## Preflight truth (established by inspection, not by document)

These reshape the campaign: several requested test areas target layers that do not exist. Per the
campaign's own rule they are recorded as **missing links**, never as regressions or failures.

| Requested area | Reality | Evidence |
|---|---|---|
| Asset registry / custody / reservation / meter readings / utilization / optimization | **NOT IMPLEMENTED.** No `assets`, `reservations`, `custody`, `meter_readings` table exists in any migration. | `grep -riE "create table .*asset" src/db/migrations` → no match |
| Fleet | IMPLEMENTED (narrow): `vehicles`, `drivers`, `trips`, `fuel_logs`, `vehicle_documents` | migrations |
| Multilingual EN / SI / TA | **NOT IMPLEMENTED.** "sinhala"/"tamil" occur only inside a flag *description string*. | `src/config/flags.ts` only |
| V3.1 runtime (task intelligence, decision-path ladder, team formation, AI guide, …) | **SHADOW ONLY.** 8/8 flags have zero runtime consumers; `src/schemas/v3_1/*` are contracts with no callers. | `grep -rn "V3_1_" src` outside `flags.ts` → only a version constant |
| Task Intelligence Profile / decision-path ladder / team recommendation / AI Guide | **NOT IMPLEMENTED** as runtime behaviour (contracts only) | as above |

Consequence: the cross-layer pipeline can be verified for stages 1–6 and 12–16 only. Stages 7, 8,
10, 11 and 17 are **missing links**, and are reported as such rather than tested.

## Checkpoints

| # | Checkpoint | State | Evidence |
|---|---|---|---|
| C0 | Preflight: branch/SHA/migration range/implemented-surface inventory | **DONE** | this file, §Scope + §Preflight |
| C1 | Deterministic gate battery on the tested head | **DONE** | §Gate results |
| C2 | Scenario pack + cross-layer evidence suite implemented | in progress | `tests/campaign/**` |
| C3 | Adversarial + fault/degradation suite implemented | in progress | `tests/campaign/**` |
| C4 | Independent Opus reviews (4 bounded assignments) | in progress | §Independent review |
| C5 | Defect fixes + targeted regression (≤2 correction loops) | pending | §Defect ledger |
| C6 | Final report + draft PR on tested head | pending | — |

## Gate results — tested head `48bef9c`, disposable PostgreSQL 16.13

| Gate | Command | Result |
|---|---|---|
| whitespace/conflict | `git diff --check` | clean |
| secret scan | `npm run secret-scan` | ✅ no tracked secrets |
| migration lint | `npm run migration-lint` | ✅ 68 migrations, sequential 0001–0068, no gaps/duplicates |
| inventory check | `node scripts/completion-inventory.mjs --check` | ✅ admin-files=38 · money-suspects=12 · flags-no-consumer=**8/8** · todos=3 · stubs=1 · mask-suspects=70 |
| typecheck | `npm run typecheck` | ✅ clean |
| lint | `npx next lint` | ✅ 0 errors (2 pre-existing `<img>` warnings) |
| unit | `npx vitest run` | ✅ **438 passed / 80 files** |
| production build | `npm run build` | ✅ compiled successfully |
| fresh migration chain | `node scripts/migrate.mjs` on empty DB | ✅ 0001→0068 applied |
| integration (fresh) | `vitest -c vitest.integration.config.ts` | ✅ **327 passed / 42 files** |
| dependency audit | `npm audit --omit=dev` | ⚠️ **2 high** (see D-001) |

### Notable gate observation (not a defect — designed behaviour, now proven)

Staging the disposable database with Supabase's **real** default grant
(`grant all on schema public to anon, authenticated, service_role`) made migration **0067 abort**:

```
0067 fail-closed: role anon has CREATE on schema public — a persistent shadow object could be
planted there. REVOKE CREATE (owner-approved) before applying; this migration does not alter
hosted privileges.
```

The chain completed only after applying the same `REVOKE CREATE` that PART 0 of
`docs/architecture-v2/HOSTED_MIGRATION_0042_TO_0068.sql` performs. This is direct evidence that the
hosted pack's REVOKE is **required**, not decorative, and that the guard cannot be skipped silently.

## Blocked / not verifiable in this environment (never claimed as passed)

| Area | Why blocked | Owner action to unblock |
|---|---|---|
| Live-model intelligence quality | No `OPENAI_API_KEY`; no provider configured. Generative repeatability (3–5 runs/scenario), token cost and latency cannot be measured. | Provider selection + credentials (owner gate) |
| Vercel Preview / production URL checks | This sandbox's egress policy denies `*.vercel.app` (proxy returns 403 to CONNECT) | Run from a network that can reach the deployment |
| GitHub Actions CI | Known systemic `runner_id:0` failure; the campaign brief forbids retrying | Repository/account runner settings (owner gate) |
| Staging verification | No staging environment exists | Staging environment + credentials (owner gate) |
| Hosted DB behaviour | Hosted DB is at 0038–0041 and must not be migrated by this campaign | Owner applies the migration pack |

**All database evidence in this campaign is local/disposable. No staging or production verification
is claimed anywhere in this report.**
