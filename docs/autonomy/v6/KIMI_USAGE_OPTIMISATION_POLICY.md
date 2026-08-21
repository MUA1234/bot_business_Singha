# SINGHA AI BUSINESS MANAGER — USAGE OPTIMISATION POLICY V6

This policy governs **development-model usage** by Conductor with Kimi K2.7. Runtime business-model routing is implemented separately under MOD-003 and must remain provider-neutral.

The label `Kimi K2.7` describes the configured Conductor worker for this programme. Do not infer undocumented context limits, pricing, tool permissions or provider guarantees from the label. Read the values exposed by Conductor when available; otherwise record them as unavailable.

Optimisation means minimum safe cost and context use. It never means reducing financial, security, authority, isolation or recovery assurance.

## 1. Selection hierarchy

### Tier 0 — No model

Use deterministic tools first:

- requirement/evidence audits;
- repository search and call-graph scripts;
- schema/grant inventories;
- formatters, type checks and linters;
- unit/integration/browser tests;
- seeded fixtures and diff checks;
- generated machine-readable status.

Do not ask a model to rediscover maintained facts that scripts can read exactly.

### Tier 1 — Economy/fast worker

Use for:

- file and requirement inventory;
- mechanical documentation reconciliation;
- repetitive low-risk tests;
- straightforward empty/loading/error UI states;
- simple CRUD after contracts and permissions are settled;
- formatting and low-risk refactoring.

### Tier 2 — Balanced implementation worker

Use for:

- normal bounded vertical slices;
- ordinary APIs/RPCs/jobs and UI wiring;
- module-level debugging;
- provider adapters following an approved contract;
- routine integration tests.

### Tier 3 — Strongest reasoning model

Reserve for:

- architecture and cross-module invariants;
- financial state machines and accounting boundaries;
- authority, identity, permissions and SECURITY DEFINER work;
- migrations and realistic upgrade reasoning;
- concurrency, lock order, idempotency and crash windows;
- prompt-injection/privacy/security reviews;
- P0/P1 diagnosis;
- final independent review of a bounded high-risk package.

Use Kimi K2.7 at the highest justified reasoning setting available in Conductor, or another explicitly approved model. Do not hardcode one provider/version into product policy.

## 2. Escalation rule

Start at the lowest justified tier. Escalate only when one of these is recorded:

- the task crosses a Tier-3 boundary;
- the lower tier fails twice with different justified approaches;
- contradictory evidence requires deeper reasoning;
- risk/confidence policy demands independent review;
- the diff materially affects three or more modules or a system invariant.

Do not escalate merely because a model is available.

## 3. Context control

For every active slice, maintain a compact module dossier containing:

- requirement IDs and business invariant;
- exact base SHA and relevant diff;
- owned tables/APIs/events/UI;
- permissions and authority;
- known failure modes;
- targeted tests and current failures;
- unresolved reviewer findings.

Give workers/reviewers the dossier plus relevant files, not the whole project history. Reuse prior evidence only when the SHA/invariant still matches. Do not repeatedly review unchanged code.

## 4. Testing cadence

- During implementation: narrow deterministic tests first.
- Before worker handoff: targeted module gates plus self-diff review.
- Before Conductor acceptance: relevant integration, roles, concurrency, failure and UI tests.
- At branch/package checkpoint: full verify, build, fresh migration and realistic upgrade as applicable.
- At phase checkpoint: cross-module, adversarial, performance/fairness and recovery suites.

Do not run the most expensive full matrix after every small edit. Do not defer it past acceptance.

## 5. Independent review and multi-model use

Do not use multiple models for routine work.

Use a second independent high-capability reviewer for:

- money movement/accounting;
- authority and privilege boundaries;
- cross-company isolation;
- destructive or irreversible state transitions;
- concurrency/crash recovery;
- model gateway/adjudication;
- major architecture or final release review.

The reviewer receives invariants, exact diff and evidence, and must attack the implementation rather than restate it. Every finding is independently reproduced before correction.

If Conductor exposes only Kimi K2.7, perform the review as a separate cold-context assignment against a frozen SHA, with no access to the implementer's draft conclusion. This is weaker than a genuinely different model and must be reported as `independent context, same model`. Deterministic adversarial and discrimination tests remain mandatory.

Maximum two material correction loops per bounded package. A package that remains materially defective is frozen and remediated separately.

## 6. Live-model evaluation

Run deterministic hostile/failure simulations before calling a live provider.

Live evaluation requires an owner-configured credential, provider approval and budget. Without them, mark it `blocked_owner` or `not measured`; never invent quality, latency, token or cost numbers.

When authorised:

- use bounded representative scenario sets;
- cap repetitions, output tokens, timeout and spend;
- record provider/model/version and prompt/schema version;
- never log keys or sensitive prompt content;
- compare quality, safety, latency and cost;
- keep candidate models in shadow mode first;
- never let an evaluation response execute a business side effect.

## 7. Usage ledger

For each material model assignment record, where observable:

- timestamp and task/slice ID;
- model tier and provider/model/version;
- reason this tier was selected;
- input dossier/version or commit SHA;
- attempts, fallback and outcome;
- token, latency and cost data only if actually provided;
- tests/reviewer result;
- whether output was accepted, corrected or discarded.

Use `unavailable` or `unmeasured` for missing figures. Do not estimate and present it as telemetry.

## 8. Runtime MOD-003 cost controls

MOD-003 must implement:

- provider and model registries;
- policy routing by task/risk/language/sensitivity/context/latency/cost/health;
- per-company and per-task ceilings;
- timeout, bounded retry, circuit breaker and approved fallback;
- caching only when privacy, staleness and logical identity allow it;
- selective second-model review only for high-risk/low-confidence work;
- shadow evaluation before promotion;
- one adjudicated result and one atomic idempotent business effect;
- health, quality, fallback, disagreement, override and cost monitoring.

Multiple providers/models may analyse one logical request, but they may never independently persist tasks, approvals, payments, quotations or messages.

## 9. Session budget and pause behaviour

No unbounded loop is permitted. Conductor uses configured time/request/token/spend ceilings where available.

When the session or budget ends:

1. stop new model calls;
2. finish/abort the current atomic local operation safely;
3. preserve authorised code and evidence;
4. update the requirement/state/usage ledgers;
5. record exact branch, SHA, migration, open failures and next action;
6. resume from the same controller in the next session.

Budget exhaustion is not permission to weaken gates or mark incomplete work verified.

## 10. Kimi/Conductor operating pattern

For each slice:

1. Conductor reads the state controller and creates one compact requirement dossier.
2. Kimi inspects only the relevant call graph, contracts, migrations and tests before broader search.
3. Kimi proposes a bounded plan and implements one vertical slice.
4. Targeted deterministic gates run before any reviewer call.
5. Kimi performs a self-diff check for dead code, false claims, vacuous tests and duplicate side effects.
6. High-risk slices receive a separate cold-context review at the frozen SHA.
7. Conductor reproduces confirmed findings, allows at most two material correction loops and runs full checkpoint gates once the slice stabilises.
8. State, requirement evidence, usage and the exact next action are committed before the session pauses.

Do not repeatedly feed Kimi the entire conversation or the full repository. Prefer the current dossier, exact diff, governing invariants and failing evidence.
