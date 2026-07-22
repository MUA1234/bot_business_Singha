# MODEL_ROUTING.md

**Status:** Phase 0 deliverable — for review. Master spec §20. Part of the AI gateway.

## 1. Principle

The gateway is **provider-independent**. Model IDs live only here (in a routing
table), never in business logic. Routing chooses a model by: task type, complexity,
risk, language, context size, latency budget, cost, tool requirements, availability,
and fallback order.

## 2. Routing table (config, not code constants)

Each `purpose` maps to a primary model + fallback(s) + a policy:

| purpose (example) | complexity/risk | primary | fallback | verify with stronger? |
|---|---|---|---|---|
| `task.classify` | low | small model | small alt | no |
| `receipt.extract` | medium, financial | mid model | small | yes (high-risk = financial) |
| `task.plan` / `project.plan` | high | strong model | mid | n/a (already strong) |
| `finance.decision` | high, sensitive | strong model | mid | always → then authority engine |

Values are stored config (updatable without a deploy) and every choice is logged in
`model_routes` / `model_usage`.

## 3. High-risk "verify" policy

Mirrors the existing bot's proven pattern (`needsVerification` / `RISKY_INTENTS` in
Sasiri `ai.ts`): financial, promise-bearing, or authority-relevant outputs get a
second pass with a stronger model before the result is used. Generalised and made
configurable per `purpose`.

## 4. Fallback & availability

On provider error, schema-validation failure, or timeout: retry with backoff, then
fall back to the next model in the chain. Every retry/fallback is recorded. Persistent
failure raises a health alert (`OBSERVABILITY.md`) and, for pipeline events, moves the
event toward dead-letter rather than dropping it.

## 5. Cost controls

- Per-call token/cost logged; per-company and per-purpose cost rollups.
- OpenAI account spending limit set (see `SETUP.md`).
- Alert on cost spikes; cache approved static instructions where supported.

## 6. Model IDs

**Never hardcode a model ID outside the routing table.** A test greps the codebase to
enforce this (Phase 3). Model identifiers are resolved at runtime from config so a
model swap is a config change, not a code change.
