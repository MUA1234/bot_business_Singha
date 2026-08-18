# Inbound boundary — correction loop 1

Scope: AIM-002 (task deduplication), AIM-003 (truthful routing) and the repository-controlled part
of FOUND-003 (production-reachable staff and finance intake), corrected together because they are
one boundary.

Everything below was verified on a disposable PostgreSQL 16 inside the development container. **No
hosted database was migrated, no feature flag was enabled, no live model provider was called, no
real message was sent, and nothing was merged or deployed.**

## Why there was a correction loop

Two sources of findings, both acted on:

1. **Self-found, before the review returned.** One inbound provider message produced **two**
   `source_events` rows — the webhook's persist-first step keyed them `in_<sha>` while
   `ingestSourceEvent` computed `evt_<sha>`. The orphan receipt was claimable by
   `claim_source_events`, so every inbound message — customer orders included — looked like
   unprocessed sweeper work, and the health signal counted receipts that were never meant to be
   processed.
2. **An independent adversarial review** of the boundary, which returned 15 findings. Each was
   reproduced on live PostgreSQL before being accepted; none was accepted on assertion alone.

## The migrations, 0069 → 0076 — no unexplained number

| # | Name | What it is |
|---|---|---|
| 0069 | `durable_inbound_processing` | Leases, bounded retry, dead-letter and fair eligibility for the CONSUMER lifecycle of a source event. |
| 0070 | `channel_identity_resolution` | `channel_identities` + `resolve_channel_identity`: who SENT a message, from trusted records, failing closed on unknown/ambiguous. |
| 0071 | `task_identity_dedup` | Server-computed task identity, a partial unique index, the create-or-return RPC, and advisory-only similarity suggestions (AIM-002). |
| **0072** | **`task_routing_state`** | **The durable task routing state machine (AIM-003): `task_routing` with seven states, a reason code, a one-active-row partial unique index and a supersede link; append-only `task_routing_events`; the service-only `route_task` transition RPC; and `task_assignee_ineligible_reason`, which revalidates a proposed assignee at commit time. This is the migration that turned "routed for human approval" from a sentence in the UI into a row that exists.** |
| 0073 | `case_tasks_through_dedup` | `create_management_case_atomic` creates every task THROUGH `create_task_deduplicated`, so the production analysis path inherits AIM-002. |
| 0074 | `channel_account_company_resolution` | `channel_accounts` + `resolve_channel_company`: which COMPANY received a message, from the receiving provider account. |
| 0075 | `inbound_review_queue` | `inbound_reviews` + record/resolve RPCs + `actor_has_capability`: manual review becomes a place a person opens. |
| 0076 | `inbound_boundary_correction` | This correction loop — canonical event identity, the explicit dispatch lifecycle, reconciliation of existing duplicate rows, and the confirmed 0072/0074/0075 defects. |

`migration-lint` proves the sequence 0001–0076 has no gaps and no duplicates.

## What 0076 changes

**Canonical identity.** `ev1:<channel>:<receiving account>:<provider message id>:<purpose>`, derived
from trusted provider facts only. The receiving account is known at receipt time and maps to exactly
one company, so the identity is company-scoped without depending on a company that has not been
resolved yet. Message TEXT is never part of it: two people sending the same words are two events. No
provider message id means **no identity** — that receipt is never merged with anything and goes to a
person instead.

**An explicit dispatch lifecycle**, separate from the consumer lifecycle 0069 governs:
`pending → dispatching (leased) → dispatched | manual_review | failed → dead_letter`, plus
`superseded` for reconciled legacy rows. Consumer claimability is now explicit: `claim_source_events`
claims a receipt only once it was dispatched as a finance capture, and never a superseded one.

**Crash semantics.** The downstream effect is created FIRST and the marker written after, so a crash
can never leave a marker without an effect. The reverse — an effect with no marker — is recovered by
the retry, because every downstream is independently idempotent (task identity 0071, the review
queue's per-message unique index 0075, `wa_messages` dedupe, and the receipt's own identity).
"At most one business dispatch" is enforced by the LEASE: two concurrent deliveries find one receipt
and only one can move it `pending → dispatching`.

**Reconciliation, not deletion.** A provable `in_`/`evt_` pair leaves the capture canonical and marks
the receipt `superseded` with an auditable link. A pair whose receipt is referenced downstream, or
whose content hashes contradict, is **left visible** in `manual_review`. Nothing is deleted.

## Review findings — disposition

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | `task_assignee_ineligible_reason` passed a USER id where a COMPANY id was expected, so the capability re-check was a constant false and `assigned` was unreachable | **Confirmed** (reproduced: a member holding the capability returned `lacks_required_capability`). Fixed in 0076 to use `actor_has_capability`. Positive test added. |
| 2 | HIGH | The WhatsApp thread-analysis path routed nothing | **Confirmed.** `analyzeConversationThread` now routes what it captures, through the same shared ports as the manual path. |
| 3 | HIGH | Two proposals with the same normalised title inside one analysis collapsed into one, discarding the second note | **Confirmed** (reproduced on live PG). `taskIdentityPartsForPlan` gives repeats within one analysis a distinct identity; across analyses identical titles still deduplicate. |
| 4 | MEDIUM | `channel_accounts` write-uniqueness used the RAW value while the resolver matched the NORMALISED one | **Confirmed.** Normalised on write by trigger; both sides now share one key. |
| 5 | MEDIUM | The staff-finance path wrote a second `source_events` row carrying the whole batched payload under one company's scope | **Confirmed**, and the same defect as the self-found one. 0076 removes the second row; the route now stores the SINGLE message, never the batch. |
| 6 | MEDIUM | An AI/system actor could supersede a HUMAN assignment, and an analysis replay triggered exactly that | **Confirmed.** `route_task` refuses it and records the refusal; both analysis paths skip routing on an idempotent replay. |
| 7 | MEDIUM | `has_capability` depends on a service-only function with no shared-owner assertion | **Confirmed as a deployment-safety gap.** 0076 asserts a shared owner fail-closed and smoke-calls the wrapper. |
| 8 | LOW-MED | Routing history was not append-only against `TRUNCATE` | **Confirmed.** Statement-level BEFORE TRUNCATE trigger + `revoke truncate`; both layers asserted. |
| 9 | LOW-MED | A failed review-queue insert degraded to a log line and Meta was told 200 | **Confirmed as reachable control flow.** The dispatch failure is now durable and retryable, and the webhook returns 503 so the provider redelivers — safe, because redelivery cannot dispatch twice. |
| 10 | LOW | A non-canonical `channel` string bypassed the configured-mapping guard | **Confirmed.** The channel is normalised once and used in every predicate. |
| 11 | LOW | `approval_request_id` could name an approval that does not exist | **Confirmed.** Composite FK `(company_id, approval_request_id)`. |
| 12 | LOW | The UTC-window residual risk was understated | **Accepted.** Register text corrected. |
| 13 | LOW | `knownCurrencies: ["LKR"]` was hardcoded for every company | **Confirmed.** Read from the company's `base_currency`; an empty list fails closed. |
| 14 | LOW | An expired token dead-lettered the whole queue on the first attempt | **Confirmed as a design inconsistency.** Credential errors (Meta 190/10, HTTP 401/403) are now the `not_configured` class and do not consume the retry budget. |
| 15 | LOW | UI tests were source-text assertions that would pass if the block were never rendered | **Accepted.** The presentational components are split out and now RENDERED in tests; the orchestration has behavioural order-of-operations tests. |

The review also recorded what it could **not** break, which is evidence too: the `has_capability`
refactor was differentially identical over 4 users × 2 companies × every permission, 0073 atomicity
and identity forgery held, `route_task` concurrency held, the review-queue authorisation held in
full, and a schema dump of the fresh and upgraded databases was identical.

## Verification at the final SHA

Run on the disposable PostgreSQL 16; see the state file for the exact numbers and SHA.

* fresh `0001 → 0076` and staged `0001 → 0075` then `0076`, full integration suite on both
* unit tests, typecheck, lint, build, secret scan, migration lint
* requirements/evidence audit, RLS matrix, SECURITY DEFINER allowlist, search-path safety, IP check
* the new scenarios were run against the PRE-correction schema (0001–0075) and **fail** there —
  25 of 29 — which is what makes them discriminating rather than decorative
* `npm run browser-check`: both screens are served and gated (307 → `/login`), and the public pages
  render in Chromium

**What the browser check cannot do:** the application reaches its database through Supabase's HTTP
API and there is no Supabase instance in this container, so no browser check here can sign in, load
the queue, or run an analysis. What those screens SAY with data in them is asserted by rendering the
components directly (`tests/campaign/ui-rendered-truthfulness.test.ts`). Neither check is sufficient
alone, and neither is described as more than it is.
