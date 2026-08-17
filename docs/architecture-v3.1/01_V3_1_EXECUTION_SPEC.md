# V3.1 Execution Specification (sanitised, public-safe subset)

> **IP mode.** The repository is **public**. Per `34_CLAUDE_GITHUB_MASTER_COMMAND.md`
> (CONFIDENTIALITY/IP) and `29_ANTI_CLONE_AND_IP_PROTECTION.md`, the full confidential pack is **not**
> committed. This file is the sanitised implementation/execution subset: enough for an engineer (or
> coding agent) to build V3.1 correctly, with **no** proprietary prompts, evaluation datasets,
> ranking weights, scoring thresholds or playbook content. Those remain server-side/configurable.
> `OWNER_GATE_IP_MODE` is recorded as open in `00_BASELINE_ASSESSMENT.md` §8.

## 1. Product intent (one paragraph)

V3.1 evolves the existing secure application into an internal **AI senior-management intelligence**
layer: for each unit of work it detects candidate tasks, builds a Task Intelligence Profile,
proposes a **ladder of decision paths** (from the simplest safe option to the most ambitious),
recommends a **role-first team** (owner, doer, adviser, supervisor, approver, verifier), runs a
**shared AI Guide/coach** inside the task, proposes improvements, gives managers exception-first
visibility, and supports English/Sinhala/Tamil — while **legal authority stays with deterministic
policy and authorised humans**. The AI leads the *flow of work*; it never assumes financial, legal,
HR, safety, privacy or accounting authority.

## 2. Non-negotiable engineering invariants (inherited, unchanged)

1. Every AI output used by application logic is **schema-validated (Zod) → deterministic authority/
   policy check → permission check → audit log**. Free-text model output never triggers a sensitive
   action.
2. Company scope is explicit on every record; cross-company leakage is a critical failure proven
   impossible by tests.
3. Forward-only migrations. Never edit an applied migration. Preserve stable IDs, accounting history,
   evidence and audit.
4. New capability ships **behind a default-OFF feature flag** and runs in **shadow mode** before any
   automation is enabled.
5. The internally-owned Accounting Core + posting RPCs are the accounting source of truth. QuickBooks
   is not used.
6. Official Meta WhatsApp Cloud API only. Respect the 24-hour window; approved templates outside it.
7. No paid managed service / Redis / Kafka / Kubernetes without an owner-approved `DECISIONS.md`
   entry.
8. Deterministic policy owns authority; the AI proposes. Enqueue ≠ sent; recording a payment ≠ a bank
   transfer; the system executes no bank transfers.

## 3. Canonical contracts (this slice — implemented)

All V3.1 AI outputs parse against these before any policy engine sees them. They live in
`src/schemas/v3_1/` and describe **proposals only**. They **reuse** `AuthorityLevel` and `RiskClass`
from `src/schemas/management.ts` — V3.1 introduces no competing authority vocabulary.

| Contract | File | Purpose |
|---|---|---|
| Decision Path Ladder | `src/schemas/v3_1/decision-path.ts` | The four rungs (Quick & Safe, Balanced, Robust, Strategic), each carrying required authority, risk, evidence, reversal plan; exactly one marked recommended. |
| Task Intelligence Profile | `src/schemas/v3_1/task-intelligence-profile.ts` | Deduplicated task candidate + versioned brief + evidence + scope + confidence. |
| Team Formation | `src/schemas/v3_1/team-formation.ts` | Role-first requirements (owner/doer/adviser/supervisor/approver/verifier) + internal/external resource recommendations with credential/expiry/separation-of-duties flags. |
| Shared AI Guide | `src/schemas/v3_1/ai-guide.ts` | In-task guidance, next-action proposals, Ask-AI answers with scoped senior visibility. |

### Design rules encoded in the contracts

- **Decision Path Ladder** always has the four named rungs and marks **exactly one** as the
  recommended balance. Each rung declares its own `requiredAuthority` — selection is authority-checked
  by deterministic policy downstream, never by the model.
- **Team Formation** is **role-first**: the required roles are fixed; people/resources are
  *recommendations* against those roles. Separation-of-duties is representable (e.g. approver ≠ doer),
  and external resources carry credential + expiry fields so an expired credential can be rejected.
- **AI Guide** messages carry an explicit `visibility` scope so private coaching is not leaked to
  unauthorised seniors, and an optional `proposedNextAction` that — if present — is itself a
  policy-routed proposal, not an instruction.

## 4. Feature-flag registry (this slice — implemented)

`src/config/flags.ts` is the typed V3.1 flag registry. Every flag is **default OFF** using the
existing `X === "on"` convention, and is consumed by **no** business logic yet (shadow). Flags are
declared with metadata (env var, default, owner-gate, description) so the registry is the single
source of truth for V3.1 flag state. Enabling any flag is an **owner gate** and out of scope until
staging UAT.

## 5. Slice plan (dependency order) — status

| # | Slice | Depends on | Status (updated 2026-08-17, completion-program Phase 0) |
|---|---|---|---|
| 0 | Baseline + compatibility foundation (flags, contracts, docs) | — | **implemented + locally verified** (PR #3) |
| 1 | `0048+` correction prerequisite (WP10–WP18) | 0 | **implemented + locally verified** as migrations 0048–0067 after ten external-review rounds (PR #13, draft, head `48407bd`); NOT merged/hosted-migrated — owner gates |
| 2 | Task candidate detection + dedupe + Task Intelligence Profile | 0, (1 for finance-linked) | in completion program (Phase 3.1) — flag has no runtime consumer yet |
| 3 | Decision Path Ladder runtime + authority-checked selection | 2, 1 | in completion program (Phase 3.2) — flag has no runtime consumer yet |
| 4 | Role-first team formation + resource recommendation | 2, 1 | in completion program (Phase 3.3) — flag has no runtime consumer yet |
| 5 | Shared AI Guide / Ask-AI / next actions / scoped visibility | 2 | in completion program (Phase 3.4) — flag has no runtime consumer yet |
| 6 | Improvement proposals + outcome measurement (shadow) | 2–5 | in completion program (Phase 3.5) — flag has no runtime consumer yet |
| 7 | Manager Mission Control / exception lanes / explorers | 2–6 | in completion program (Phase 3.6) — flag has no runtime consumer yet |
| 8 | Responsive/PWA + versioned mobile APIs + EN/SI/TA preference | 7 | in completion program (Phase 3.7) — flag has no runtime consumer yet |
| 9 | Runtime model routing / budget / cache / fallback / kill switch / eval | 3–6 | in completion program (Phase 4) — flag has no runtime consumer yet |
| 10 | Deployment-readiness docs/config only (no hosted action) | all | in completion program (Phase 5) |

> Authoritative live tracking of the completion program (branches, SHAs, tests, owner gates):
> `docs/architecture-v3.1/COMPLETION_LEDGER.md`. A flag is "implemented" only when a real runtime
> consumer exists behind it and its slice's tests pass; `COMPLETION_INVENTORY.md` §3 machine-checks
> which flags still have no consumer.

Each deferred slice, when built, must deliver DB/RLS + service/command + event/outbox/worker +
schema + UI + audit/health + docs + tests as applicable, run the mandatory gates, self-review the
diff, and stay behind its flag until owner approval.

## 6. Owner stop gates (do not cross without explicit owner authorisation)

Full confidential pack in a public repo; merge; paid dependency; material change to finance/legal/HR/
safety authority; destructive migration; any hosted database action; Vercel/staging/production
deploy; production secrets; real messages/data; production flag flips; GPS/CCTV/facial recognition.
