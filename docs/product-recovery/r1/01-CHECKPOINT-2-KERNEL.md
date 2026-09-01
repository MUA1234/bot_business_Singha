# R1 checkpoint 2 — management kernel and lifecycle

**Local-only. No hosted migration, no production change, no provider contact.**
Branch `claude/product-recovery-r1`, from checkpoint 1 (`8174697`).

Departmental adapters are **not** implemented — that is checkpoint 3, and this stops here
for review as instructed.

## 1. The lifecycle — 16 states

Checkpoint 1 specified 15. **Owner decision R1-D-3 added `needs_routing`**, so unrouted
work goes to a department queue with a recorded reason instead of being dumped on an
administrator. Sixteen is the honest count.

| # | State | Meaning |
|---|---|---|
| 1 | `observed` | a detector emitted an observation; evidence captured |
| 2 | `understood` | interpretation attached (fixture adapter, or deterministic fallback) |
| 3 | `prioritised` | severity, urgency and confidence assigned |
| 4 | `recommended` | a **catalogue** action proposed, citing evidence |
| 5 | `awaiting_approval` | authority above `automatic`; a human must decide |
| 6 | `approved` | approved, possibly as an edited or delegated variant |
| 7 | `rejected` | **terminal** — reason required |
| 8 | `needs_routing` | **R1-D-3** — no assignee could be recommended; reason recorded |
| 9 | `assigned` | an accountable owner holds it |
| 10 | `monitoring` | work in flight; deadline tracked |
| 11 | `escalated` | stalled or overdue; escalation path engaged |
| 12 | `verifying` | reported complete; re-observation pending |
| 13 | `verified` | **terminal** — re-observation confirms resolution |
| 14 | `reopened` | re-observation shows the condition persists |
| 15 | `dismissed` | **terminal** — not a real issue; reason required |
| 16 | `expired` | **terminal** — source record became stale |

### Allowed transitions

```
observed          → understood, dismissed, expired
understood        → prioritised, dismissed, expired
prioritised       → recommended, dismissed, expired
recommended       → awaiting_approval, needs_routing, assigned*, dismissed, expired
awaiting_approval → approved, rejected, expired
approved          → needs_routing, assigned, expired
needs_routing     → assigned, escalated, dismissed, expired
assigned          → monitoring, escalated, dismissed
monitoring        → verifying, escalated, dismissed
escalated         → monitoring, verifying, needs_routing, dismissed
verifying         → verified, reopened
reopened          → prioritised, assigned, needs_routing, dismissed
verified          → (terminal)
rejected          → (terminal)
dismissed         → (terminal)
expired           → (terminal)
```

`*` `recommended → assigned` skips approval **only** at `automatic` authority **and** when
the action is catalogue-registered low-risk and reversible (owner decision D-9). Both
conditions are asserted; either missing routes through `awaiting_approval`.

**Enforced twice, deliberately.** `src/kernel/lifecycle.ts` is the pure, testable map used
by application code; `r1_draft_transition_item()` re-enforces the identical map at the
database boundary, so a direct writer cannot bypass it. An invariant that lives only in
application code is a convention, not a control.

Two structural properties are proven by test, not asserted: **every transition target is a
declared state** (no dead edges), and **every non-terminal state can reach a terminal
state** (no item can be stranded forever).

## 2. Demonstrated rejections

All four categories the owner asked to see, proven at **both** layers.

### Illegal transitions

| Attempt | Result |
|---|---|
| `observed → assigned` (skipping the loop) | `IllegalTransitionError` / SQL `illegal management-item transition` |
| `prioritised → approved` (skipping approval) | refused |
| any transition out of `verified`/`rejected`/`dismissed`/`expired` | refused |
| `verified → reopened` | refused — verified is final; re-work starts a new observation |
| **every one of the ~215 unlisted state pairs** | refused (exhaustive test) |
| `recommended → assigned` above `automatic` authority | refused, naming authority |
| `recommended → assigned` when the action is not catalogue-safe | refused |

### Concurrency — two real connections

The live test opens **two separate PostgreSQL connections**. Connection A transitions
`observed → understood` inside an open transaction; connection B attempts the same
transition and **blocks on the row lock** until A commits; B then observes the committed
state and returns:

```json
{ "ok": false, "result": "conflict", "expected": "observed", "actual": "understood" }
```

**The loser writes nothing** — the transition-history count is exactly 1. A stale
expected-from is a `conflict`, never a silent overwrite; an unknown item returns
`not_found` rather than throwing. A second `approve` decision from the same actor is
refused by a unique index.

### Zero evidence

| Attempt | Result |
|---|---|
| `prioritised → recommended` with no evidence | refused: *"cannot enter state recommended with zero evidence"* |
| same, after one evidence row exists | permitted |
| `prioritised → dismissed` with no evidence | **permitted** — an item is allowed to be noise |

### Cross-company

| Attempt | Result |
|---|---|
| evidence whose company differs from its item's | refused: *"cross-company evidence refused"* |
| decision whose company differs from its item's | refused |
| reading company B's items | company A's item is absent from the result |
| the same `identity_key` reused in a **different** company | permitted — dedup is per company |
| the same `identity_key` reused in the **same** company | refused (duplicate key) |

## 3. Quarantined draft migrations (owner decision R1-D-1)

Six units in `src/db/draft-migrations-r1/`, applied only by
`scripts/r1/draft-migrate.mjs`. **Four independent quarantine mechanisms**, each separately
tested:

| # | Mechanism | Proof |
|---|---|---|
| 1 | **Different directory** — `scripts/migrate.mjs` hardcodes `src/db/migrations` | asserted against the runner's own source; no `R1_DRAFT_*` file exists in that directory |
| 2 | **Filename shape** — the production runner selects `/^\d{4}_.*\.sql$/`; drafts are `R1_DRAFT_NNN_*` | every draft file is proven to fail that pattern, so **even copying them into the production directory would not apply them** |
| 3 | **Separate ledger** — `r1_draft_migrations`, never `schema_migrations` | after applying all six units to a fresh database, `schema_migrations` **does not exist at all** |
| 4 | **Fail-closed local guard** | refuses without `R1_DRAFT_CONFIRM=disposable-local-only`; refuses any non-loopback URL — including a real Supabase host, `10.x`, `192.168.x`, `*.railway.internal`, and the lookalikes `127.0.0.1.evil.com` and `localhost.attacker.net` |

The loopback check is an **allowlist** of loopback hosts, not a denylist of hosted ones: a
denylist fails open the moment a provider uses a hostname nobody enumerated, and failing
open here means writing to somebody's production database.

Every draft file carries the `NOT FOR HOSTED APPLICATION` marker; the runner refuses to
apply a unit whose marker is missing.

**No released migration was edited or renumbered.** The production sequence is asserted
unchanged: 109 files, `0001`–`0109`, no duplicate prefix.

### Apply and rollback, proven

`node scripts/r1/run-draft-schema-tests.mjs` creates a disposable PostgreSQL 16 bound to
loopback only, applies all six units, runs 31 behavioural tests, rolls back, and destroys
the container. **Rollback leaves nothing behind** — zero R1 tables, zero `r1_draft_*`
functions, and an empty ledger.

The draft SQL is base-schema-aware: foreign keys to `companies`/`management_cases` and the
RLS read policies are applied **only when those objects exist**, so the same file works
standalone and on top of the full schema.

## 4. Owner decisions as implemented

| Decision | Implementation |
|---|---|
| **R1-D-1** quarantine | four mechanisms above; regenerated into the numbered sequence after the hosted investigation |
| **R1-D-3** no auto-admin | `needs_routing` state + `routing_department`, `routing_reason`, `routing_requested_at`, and `routing_notified_at` — **set once**, so a queued item does not re-notify on every sweep |
| **R1-D-4** deadlines split | `business_deadline` + `business_deadline_source` (`evidence`\|`policy`) and `review_by` + `review_policy_id`, with **database constraints making an unsourced deadline impossible**. `reviewTimingLabel()` returns *"review timing not configured"* rather than fabricating one |
| **R1-D-5** one adapter contract | `TriggerMode = event \| scheduled \| manual \| test`; `observation_sources` with per-source **and per-company** cadence (a `NULL` company row is the default, a company row overrides). A scheduled source **must** state its cadence; a source reachable by no mode is refused. No second scheduler |
| **R1-D-6** no live model | deterministic fixture adapter; all four degraded cases recorded and tested — `malformed`, `timeout`, `low_confidence`, `disagreement`, plus `unavailable` |
| **R1-D-7** CRM internal-only | `internalOnly: true` on every action, enforced by `assertInternalOnly`; no send path exists |

### The AI cannot invent facts

The central guard: an interpretation claim must be supported by **recorded** evidence. A
claim citing nothing, or citing evidence the item does not hold, causes the **whole
interpretation to be discarded** — not just the offending claim — because an interpreter
that fabricated one statement has not earned trust in the others. In every degraded case
the loop continues on the detector's structured facts with confidence zeroed and the
reason recorded: **it degrades to a rules engine rather than going blind.**

Disagreement is surfaced, never arbitrated. The kernel does not pick a winner between two
conflicting readings.

## 5. Files changed

**Added — draft schema (quarantined, applied nowhere hosted):**

| File | Lines |
|---|---|
| `src/db/draft-migrations-r1/README.md` | 87 |
| `R1_DRAFT_001_management_items.up.sql` / `.down.sql` | 178 / 6 |
| `R1_DRAFT_002_transitions.up.sql` / `.down.sql` | 151 / 5 |
| `R1_DRAFT_003_evidence.up.sql` / `.down.sql` | 115 / 8 |
| `R1_DRAFT_004_decisions.up.sql` / `.down.sql` | 112 / 6 |
| `R1_DRAFT_005_observation_sources.up.sql` / `.down.sql` | 88 / 3 |
| `R1_DRAFT_006_feedback.up.sql` / `.down.sql` | 69 / 4 |

**Added — kernel:** `src/kernel/lifecycle.ts` (210), `types.ts` (157), `invariants.ts`
(175), `interpretation.ts` (170).

**Added — tooling:** `scripts/r1/draft-migrate.mjs` (172),
`scripts/r1/run-draft-schema-tests.mjs` (74).

**Added — tests:** `tests/kernel/lifecycle.test.ts` (246), `invariants.test.ts` (214),
`interpretation.test.ts` (213), `tests/r1/draft-migration-isolation.test.ts` (179),
`tests/integration/r1-draft-schema.test.ts` (400).

**Modified:** `docs/architecture-v3.1/COMPLETION_INVENTORY.md` — regenerated by
`npm run verify` (line-number drift only).

**No existing source file, migration, RLS policy, API contract or configuration was
changed.**

## 6. Verification

| Check | Result |
|---|---|
| Kernel + isolation unit tests | **110 passed** (4 files) |
| Live disposable PostgreSQL 16 | **31 passed** — apply, lifecycle, concurrency, rollback |
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ 0 errors (3 pre-existing `next/image` warnings) |
| `secret-scan` | ✅ no tracked secrets |
| `migration-lint` | ✅ 109 migrations, sequential, no gaps or duplicates |
| `completion-inventory` | ✅ `supabaseAdmin` confined to the allowlist |
| `autonomy:audit` | ✅ registered=110, verified=60, consistent |
| Full unit suite | **1472 passed / 1 failed / 2 skipped (188 files)** |

Unit tests went from 1362 → **1472** (+110) and files 184 → 188 (+4).

**The single failure is the pre-existing PR-F-013 CRLF source-text defect** in
`tests/campaign/sch-003-leave-workload-aware-scheduling.test.ts` — untouched, exactly as
instructed. R1 did not need that file.

## 7. Requirement coverage advanced

**KRN-001** (kernel and lifecycle), **AIM-002** (deduplication at the database boundary),
**FOUND-005** (AI trust boundary — no invented facts), **GOV-006** (append-only audit
chain), and the foundations for **KRN-002** (`observation_sources`), **KRN-003** (action
catalogue types) and **IMP-001** (`management_item_feedback`).

**No requirement status was changed.** These are checkpoint-2 foundations; a status moves
only with a runtime entrypoint, discriminating test evidence, a deployment axis and an
exact SHA — and adapters do not exist yet.

## 8. Carried forward to checkpoint 3

- The six departmental detectors (checkpoint 3) and their registration.
- `management_items` has no FK to `memberships` for `accountable_owner_id` — deliberate
  while the draft is standalone; the reconciled numbered migration must add it with the
  composite `(company_id, id)` pattern used elsewhere.
- The full capability-gated **write** RLS matrix is not in the draft (only company-scoped
  read policies). The reconciled migration must add it before anything is hosted.
- Migration numbers remain unassigned pending PR-F-001 and PR-F-004.
