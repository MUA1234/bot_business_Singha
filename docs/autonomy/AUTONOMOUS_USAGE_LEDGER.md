# Autonomous usage ledger

## What is honestly measurable here

Token counts and dollar costs are **not** observable from inside this session — the runtime does not
expose them to the agent. Recording invented figures would be worse than recording none, so this
ledger tracks what can actually be counted: model-tier decisions, reviewer usage, correction loops
and full-battery runs.

`ai_runs` (the application's own cost ledger) is the place real token and cost figures appear, and
only for calls the application makes — currently zero, because no provider key is configured.

## Model-tier policy in force

| Work | Tier |
|---|---|
| Repository search, mechanical edits, docs, fixtures, routine tests, matrix maintenance | routine Claude (this agent) |
| Architecture, database security, hard concurrency, finance/authority boundaries, cross-layer review, final adversarial review | Opus 5 (bounded assignments only) |

## Reviewer usage this program

| Assignment | Tier | Outcome |
|---|---|---|
| Cross-layer architecture review | Opus 5 | 11 broken links, 13 coherence defects; all re-verified before acceptance |
| Security / authority / prompt-injection review | Opus 5 | 1 blocker (reclassified latent on call-graph evidence), 5 material, 8 limitations |
| Business-intelligence evaluation | **not run** | Subject is live-model quality — blocked with no provider; substituted with the deterministic scenario pack rather than simulated |
| Final review of the campaign's own fixes | Opus 5 | Found 4 regressions + 3 false claims in the campaign's first correction loop; all upheld and corrected |

Total Opus assignments: **3 run, 1 deliberately not run.** Cap is 2 routine + 1 Opus per slice.

## Correction loops

| Program | Loops used | Cap |
|---|---|---|
| Overnight verification campaign | 2 | 2 (exhausted — frozen) |
| v3.3 Part 1 | 0 | 2 |
| v3.3 Part 2 | 0 | 2 |

## Full-battery runs (expensive; run only at phase boundaries)

`7669ce1`, `079fbb8`, `1ebaa80` — each with unit + fresh integration + upgrade integration + build.
Targeted tests were used during implementation between these points.
