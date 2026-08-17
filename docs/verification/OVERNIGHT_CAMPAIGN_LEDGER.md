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
| C2 | Scenario pack + cross-layer evidence suite implemented | **DONE** | `tests/campaign/**`, `tests/integration/campaign-cross-layer.test.ts` (commit `e6534b5`) |
| C3 | Adversarial + fault/degradation suite implemented | **DONE** | `tests/campaign/ai-trust-boundary.test.ts` (commit `e6534b5`) |
| C4 | Independent Opus reviews (bounded assignments) | **DONE (3 of 4 run)** | §Independent review |
| C5 | Defect fixes + targeted regression (correction loop 1 of 2) | **DONE** | `CAMPAIGN_DEFECT_LEDGER.md`, commit `60e36c3` |
| C6 | Final report + draft PR on tested head | **DONE** | this file + the draft PR |

## Cross-layer traceability — the 17 pipeline stages

Verified by code trace (primary agent + independent architecture review, each claim re-derived
against source before being recorded).

| # | Stage | State | Note |
|---|---|---|---|
| 1 | Input/event received | IMPLEMENTED | HMAC-verified, persist-first, retryable 503. **Text only** — images/documents are 200-acked and dropped (D-017) |
| 2 | Identity + company resolved | PARTIAL | Internal surfaces yes; inbound WhatsApp stores `company_id: null` and falls back to a hardcoded pilot company |
| 3 | Context / organisational memory | PARTIAL | One conversation's messages only. No retrieval layer, no prior-case lookup |
| 4 | Facts / evidence identified | IMPLEMENTED | Confirmed vs inferred kept separate, Zod-validated, trusted scope injected over model output |
| 5 | Task candidate detected | IMPLEMENTED (thin) | Title + note + requires_evidence; no scope, dedupe key, due date or assignee |
| 6 | Duplicate task prevented | PARTIAL | Event and case level strong; **task level absent** (D-010) |
| 7 | Task Intelligence Profile | **MISSING** | Shadow contract only, no producer |
| 8 | Decision-path ladder | **MISSING** | Shadow contract only |
| 9 | Deterministic authority | PARTIAL — **improved this campaign** | `routeDecision` remains unwired (D-001); a deterministic `authorityFloor` now constrains the live path (D-004 fix) |
| 10 | People/teams/resources recommended | **MISSING** | `involved` is collected then dropped |
| 11 | AI Guide next actions | PARTIAL | Computed on the manual path, rendered once, never persisted; dropped entirely on the thread path |
| 12 | Directive routed to a human | PARTIAL | Price confirmations route by department; **AI output routes to nobody** (D-011, D-012) |
| 13 | Sensitive action waits for approval | PARTIAL | Structurally safe (only `captured` tasks, forced at the DB) but nothing waits — no request, queue or owner |
| 14 | Atomic persistence + audit | **IMPLEMENTED** | Strongest link: service-only SECDEF RPC, all-or-nothing, audit in-transaction, proven with two live connections |
| 15 | Notification without false delivery | PARTIAL — **improved this campaign** | Quotations truthful end to end; the conversational reply was not (D-005 fix) |
| 16 | Dashboard reflects state | PARTIAL | Command Centre is honest about degradation but carries **no** AI-case/`requires_human`/captured-task signal |
| 17 | Outcome / feedback loop | **MISSING** | Cases are write-once with no outcome column; `ai_runs` is read only for a cost tally |

## Independent review (Opus, bounded assignments)

| # | Assignment | State | Outcome |
|---|---|---|---|
| 1 | Cross-layer architecture and scenario review | complete | 17-stage trace, 11 broken links, 13 coherence defects, 15 proposed scenarios. Findings re-verified by the primary agent before acceptance |
| 2 | Security, authority and prompt-injection review | complete | 1 blocker (D-001, reclassified **latent** — see below), 5 material, 8 limitations. Systematic result worth recording: of 319 `.from(...)` call sites under `src/app/**`, 300 carry `company_id` in the same statement and **only one** (D-008) was a genuine unscoped access; all 35 `.update()`/`.delete()` are company-scoped |
| 3 | Business-intelligence / decision-quality evaluation | **not run as a model assignment** | Its subject — the quality of live model decisions — is BLOCKED (no provider). Substituted with the deterministic scenario pack, which evaluates the part that has an exact answer. Stated plainly rather than simulated |
| 4 | Final independent review of the campaign's own fixes | running at report time | Verdict folded into the PR if it lands before hand-off; otherwise it is an open item |

**Recorded disagreement (required by the brief).** Assignment 2 classed the `NEVER_AUTONOMOUS`
substring-denylist evasion as a **blocker**. The primary agent verified that `routeDecision` has no
production caller and reclassified it **latent** — a real defect with no live blast radius today.
Deterministic evidence (the call-graph) is treated as the authority over a reviewer's severity
opinion, and both positions are recorded so the owner can judge.

## Evaluation rubric (deterministic outcomes only)

Applied by `tests/campaign/decision-routing.test.ts` over the 20-scenario pack. Live-model scoring
(factual grounding, evidence citation, multilingual intent consistency, generative repeatability at
3–5 runs) is **not** scored — no provider is configured, and inventing a score would be worse than
recording the gap.

| Outcome class | Meaning here | Result |
|---|---|---|
| Pass | Deterministic routing matched the required authority and reasons | 20/20 scenarios |
| Pass with limitation | Routed correctly, but the situation needs intelligence the system lacks | 5 scenarios carry explicit `unimplemented` notes |
| Fail safe | Escalated when uncertain | Low-confidence, unknown-limit and currency-mismatch paths all escalate |
| Material failure | A high-risk action reachable without a human | none on the live path |
| Blocker | Constitutional invariant violated on a live path | 1 found (D-004) — **fixed this campaign** |

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
