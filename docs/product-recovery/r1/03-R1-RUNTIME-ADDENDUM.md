# R1 runtime entrypoint — addendum to the completion report

**SHA `abb49f5` on `claude/product-recovery-r1`.** Local-only, default-off, non-deployable.
No hosted contact, no hosted migration, no scheduler registered, not merged to main.

Extends [02-R1-COMPLETION-REPORT.md](02-R1-COMPLETION-REPORT.md).

## Runtime architecture

```
  authorised manual  POST /api/management/cycle   ─┐
  internal test invocation                         ├──►  runManagementCycle()   ◄── ONE service
  future scheduler (defined, NOT registered)       ─┘         src/kernel/cycle.ts
                                                                     │
                            makeCycleDeps() ── the only module that touches the database
                                                                     │
   flags → lock → load → detect → validate → dedupe → persist(tx) → prioritise →
   recommend (catalogue only) → authority (existing engine) → correlate → audit →
   truthful summary → release lock
```

The manual route contains **no management logic**: it establishes identity, checks
authority, and calls the shared service. `src/kernel/worker-boundary.ts` defines what a
scheduled sweep would do and refuses to run — `WORKER_ENABLED` is a hard-coded `false`, not
an environment variable, and the function takes **no company-id parameter**, so it cannot be
aimed at a company the owner never enabled.

## Trigger and flag behaviour

Two independent switches, **both required, both server-side**:

| Switch | Mechanism | Default |
|---|---|---|
| Global | `MANAGEMENT_KERNEL === "on"` — deliberately **not** `NEXT_PUBLIC_`, so it can never be set from a browser or inlined into the client bundle | OFF |
| Per company | `management_kernel_enablement.enabled`, writable only with the existing `admin.organisation.manage` capability | absent = OFF |

Proven behaviourally: global absent → disabled; global false → disabled; any value other
than exactly `"on"` → disabled; a `NEXT_PUBLIC_` variant is ignored entirely; company
absent/false → disabled with **no detector work at all** and **no lock taken**; disabling
between cycles stops the next one; one company enabled and another disabled stay isolated.

**A disabled cycle still records its run.** "Nothing looked" and "nothing needed attention"
are different facts, and the surface must never confuse them.

## Company isolation evidence

Every query is company-scoped by construction, and the company comes from the **server
session**. The manual route *refuses* a request carrying a `companyId` rather than ignoring
it, so a caller cannot believe it worked. Live assertions: an enabled company's cycle creates
nothing for a disabled one; **zero** evidence or transition rows cross a company boundary; a
cross-company reviewer is refused.

## Cycle results (live, real wiring, real database)

| Scenario | Result |
|---|---|
| Disabled company | `skipped_disabled`, zero items, run still recorded |
| Global flag off | `skipped_disabled` even when the company is enabled |
| Enabled | items created, **evidence linked to every item**, catalogue-only `proposed_action_id`, authority resolved, one opening transition per item |
| Repeated cycle | **idempotent — zero new items** |
| Two cycles, one company | second is `skipped_locked` |
| Two companies | run independently |
| One failing adapter | `partial`, department named, other four complete |
| Adapter timeout / malformed output | failure, never an empty result |
| Persistence failure | `partial`, never a clean sweep |
| Outbox rows written by the cycle | **zero — it cannot send anything** |

## Test totals

| Suite | Result |
|---|---|
| Full repository unit suite | **1649 passed / 0 failed / 2 skipped (193 files)** |
| R1 live, full schema (security · adapters · campaign · runtime) | **82 passed** |
| R1 live, standalone draft + rollback | **31 passed** |
| Quarantine | **28 passed** |
| Cycle tests **under the outbound network guard** | **28 passed — no external call** |
| verify · typecheck · lint · build · browser-check | exit 0 · clean · 0 errors · clean · passed |
| secret-scan · migration-lint · autonomy audit · IP boundary | all pass |

## Defects discovered and corrected

**Lock helpers were executable by `anon`** — found by adversarial review. PostgreSQL grants
`EXECUTE` on a new function to `PUBLIC` by default, so an **unauthenticated** caller could
take a company's advisory lock and make every real cycle report `skipped_locked` — a denial
of service against the management system requiring no credentials at all. Unit 011 now
revokes `EXECUTE` from `public`, `anon` and `authenticated`, granting only `service_role`.

**Two of my own assertions were wrong, and the code was right.** RLS denies `UPDATE` and
`DELETE` **silently** — no policy matches, zero rows are affected, no error is raised. Tests
that asserted an error message were rewritten to assert the **effect**: the item and its
history survive, and the run ledger is unchanged. Asserting on an error that a correct
implementation never raises is a false test, not a stricter one.

**`supabaseAdmin` allowlist.** The existing governance check correctly flagged the new route
and its wiring. Both were added through the sanctioned allowlist rather than by relaxing the
check.

## Requirements that can now honestly advance

| ID | From | To | Why |
|---|---|---|---|
| **KRN-001** | `implementation_in_progress` | **`locally_verified`** | A real runtime entrypoint exists and executes the complete acceptance scenario against a real database with real wiring |
| **KRN-003** | `implementation_in_progress` | **`locally_verified`** | The catalogue is enforced as the only source of proposals, and the runtime is asserted to persist catalogue ids only |
| **KRN-002** | — | **stays `implementation_in_progress`** | The requirement is observation sources across **every** managed domain, and only **five of twelve** are covered. The entrypoint now exists; the coverage does not. |

**60 → 62 `locally_verified`. Staging and production remain ZERO.**

## Remaining risks

1. `may_run_unattended` is computed and constrained but **inert** — no executor exists.
2. `persist()` writes item, evidence and transition as three statements. A failure partway
   leaves an orphaned item (the caller counts it as rejected). The reconciled numbered
   migration must add an **atomic create-item RPC** before this is ever hosted.
3. Capabilities passed to `selectAssignee` are still supplied by the caller; no loader
   populates them from the database.
4. Learning remains unimplemented — feedback is captured, nothing reads it.
5. Seven of twelve target domains have no adapter.

## Remaining deployment blockers

Unchanged: **PR-F-001** (colliding `0069`), **PR-F-004** (unknown hosted state),
**PR-F-002 / PR-F-003** (branch lacks main's fixes; incompatible inbound model),
**R0-F-001** (Vercel origin disabled), **PR-F-014** (deployed SHA unconfirmed),
**R1-D-1** (R1 migrations cannot take numbers until PR-F-001 and PR-F-004 close).

See [12-R0-OWNER-GATE-CHECKLIST.md](../12-R0-OWNER-GATE-CHECKLIST.md) — roughly five minutes
of dashboard reading closes all three truth gaps.

## R1-F-001 production hotfix candidate — RECORDED, NOT CREATED

Per the owner's decision, no main-based hotfix branch was created, merged or deployed.

| | |
|---|---|
| **Affected behaviour** | The task escalation fallback notifies **every** company administrator, **including those on approved leave**, and does so even when nobody is available. Contradicts SCH-003's stated invariant. |
| **Where** | `src/app/api/cron/follow-ups/route.ts`, the chain-exhausted branch |
| **Root cause** | The loop iterates `rankAvailableCandidates(...)`, which only **sorts** ("most available first") and does not filter; it never checks `avail.available`. The sibling reminder path in the same function has that guard. |
| **Minimal patch** | Replace the loop with the existing `selectBestAvailable(...)`; when it returns null, notify nobody, leave `escalated_to` NULL and set `escalation_reason = 'no_available_authorised_target'`. One added import, roughly 15 changed lines, no schema change. |
| **Regression tests** | `tests/campaign/sch-003-escalation-fallback-behaviour.test.ts` — 12 behavioural assertions covering leave, inactive membership, cross-company identity, insufficient authority, no-qualified-person, batching to one recipient, least-loaded selection, authentication and per-day dedupe. |
| **Expected risk** | **Low.** Strictly narrows who is notified. No schema change, no new dependency, no API contract change, no data migration. The only behavioural change is that fewer people are contacted — which is the intent. Residual: if a company's only administrators are all on leave, nobody is notified and the task records `no_available_authorised_target` for the next sweep, where previously they would have been notified regardless of leave. |
| **Exact commits** | **`50cbc5c`** (route fix + full behavioural suite). The test file was introduced in `15f2a83`. |
| **Blocked on** | **PR-F-014** — the deployed SHA must be known before judging whether the defect is live on `main`, and the owner's separate approval is required before any main-based hotfix is created. |
