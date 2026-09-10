# Migration lineage — Release 1 integration candidate

**Nothing here has been applied to any hosted database.** Every rehearsal ran on
disposable local PostgreSQL 16.10.

| | |
|---|---|
| Base | `origin/main` — high-water **0069** |
| Recovery line | `claude/product-recovery-r1` |
| First free number | **0070** — computed, not assumed |
| Offset | **+1** |
| Migrations moved | **41** |
| Final sequence | **0001–0110**, contiguous, no gaps |

## How the offset was calculated

The first number the shifted sequence may occupy is the one above BOTH:

* the latest `origin/main` migration — **0069** (`0069_company_routing_and_catalogue_department.sql`), a repository fact;
* the proven hosted high-water mark — **0068** per `docs/architecture-v2/MIGRATION_STATE.md`,
  owner-authorised and ledger-verified on 2026-09-01, **pending live re-confirmation**.

`max(0069, 0068) = 0069`, so the first free number is **0070** and the offset is **+1**.
`scripts/migration-renumber.mjs` computes this from the two branches every time it runs;
if the base line grows, the offset grows with it. It is never hardcoded.

## Why the whole sequence moved

The recovery line's 0069 has **6 direct and 7 transitive dependants** (old numbering:
0076, 0077, 0079, 0083, 0087, 0088, 0089), which reference its columns
(`next_attempt_at`, `lease_owner`, `lease_acquired_at`, `lease_expires_at`,
`last_error_code`, `dead_lettered_at`, `dead_letter_reason`) and its functions
(`claim_source_events`, `complete_source_event`, `fail_source_event`,
`inbound_backoff_seconds`, `source_event_backlog`).

Renaming that one file to the end of the sequence would have placed it **after every one
of its dependants**. The plan was therefore validated against the dependency graph BEFORE
it ran — `checkRenumberPlan` in `scripts/lib/migration-collision.mjs`, **0 findings** — and
the files were renamed high-to-low so no two ever briefly shared a number.

## The mapping — all 41 migrations

`main`'s `0069_company_routing_and_catalogue_department.sql` is **retained at 0069** and is
not in this table.

| Old | New | File |
|---|---|---|
| `0069` | **`0070`** | `durable_inbound_processing.sql` |
| `0070` | **`0071`** | `channel_identity_resolution.sql` |
| `0071` | **`0072`** | `task_identity_dedup.sql` |
| `0072` | **`0073`** | `task_routing_state.sql` |
| `0073` | **`0074`** | `case_tasks_through_dedup.sql` |
| `0074` | **`0075`** | `channel_account_company_resolution.sql` |
| `0075` | **`0076`** | `inbound_review_queue.sql` |
| `0076` | **`0077`** | `inbound_boundary_correction.sql` |
| `0077` | **`0078`** | `inbound_boundary_correction_2.sql` |
| `0078` | **`0079`** | `routing_provenance_split.sql` |
| `0079` | **`0080`** | `dispatch_release.sql` |
| `0080` | **`0081`** | `owner_configuration_surface.sql` |
| `0081` | **`0082`** | `approval_submitter_provenance.sql` |
| `0082` | **`0083`** | `review_loop_corrections.sql` |
| `0083` | **`0084`** | `loop2_corrections.sql` |
| `0084` | **`0085`** | `caller_trust_boundary.sql` |
| `0085` | **`0086`** | `trust_boundary_corrections.sql` |
| `0086` | **`0087`** | `actor_privilege_not_claim.sql` |
| `0087` | **`0088`** | `duplicate_review_resolution.sql` |
| `0088` | **`0089`** | `duplicate_review_boundary_corrections.sql` |
| `0089` | **`0090`** | `duplicate_review_sibling_and_budget.sql` |
| `0090` | **`0091`** | `inbound_review_grant_authority.sql` |
| `0091` | **`0092`** | `model_gateway_telemetry.sql` |
| `0092` | **`0093`** | `model_gateway_budget_policy_rls.sql` |
| `0093` | **`0094`** | `risk_register.sql` |
| `0094` | **`0095`** | `insurance_register.sql` |
| `0095` | **`0096`** | `integration_gateway.sql` |
| `0096` | **`0097`** | `management_directives.sql` |
| `0097` | **`0098`** | `ai_guide_messages.sql` |
| `0098` | **`0099`** | `conflicting_directive_resolution.sql` |
| `0099` | **`0100`** | `directive_escalation.sql` |
| `0100` | **`0101`** | `commitment_expected_payments.sql` |
| `0101` | **`0102`** | `service_provider_registry.sql` |
| `0102` | **`0103`** | `counterparty_compliance.sql` |
| `0103` | **`0104`** | `task_escalation_chain.sql` |
| `0104` | **`0105`** | `communication_preferences.sql` |
| `0105` | **`0106`** | `funding_requirements_and_investments.sql` |
| `0106` | **`0107`** | `incidents_and_statutory_obligations.sql` |
| `0107` | **`0108`** | `project_risks_decisions_scenarios.sql` |
| `0108` | **`0109`** | `push_subscriptions.sql` |
| `0109` | **`0110`** | `bounded_user_text.sql` |

## References rewritten

366 references across 111 files: filename-shaped references anywhere in the repository,
prose references (`migration 0074`) for numbers above the base high-water mark, and prose
references to the colliding number itself in six files classified by hand — that number
means one migration on `main` and a different one on the recovery line, so it could not be
rewritten mechanically. `main`'s own 0069 references are untouched.

`docs/product-recovery/` is excluded: it is an evidence record of measurements taken under
the OLD numbering, and rewriting a number inside an observation would falsify it.

## Rehearsals

| Scenario | Result |
|---|---|
| Fresh database, candidate 0001–0110 | ✅ 110 applied, then 28 draft units |
| Recovery line unshifted over a `main`-seeded ledger | ❌ halts at 0076 (old numbering), partial migration at 0075 — the defect this shift removes |
| `main`-seeded ledger + shifted candidate | ✅ 41 applied, high-water 0110, both lineages coexist |

## Not done, and why

The **28 quarantined R1 draft units** in `src/db/draft-migrations-r1/` were NOT numbered.
They remain outside the production sequence under owner decision R1-D-1, and taking
production numbers is a separate decision after this reconciliation lands.
