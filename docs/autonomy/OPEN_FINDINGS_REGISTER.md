# Open findings register — remediation package R1

Reconciliation of the twelve findings left open when the `0069–0077` inbound boundary was frozen at
**`1fd50b2`**. That boundary and its correction report (`INBOUND_BOUNDARY_CORRECTION_REPORT.md`) are
**not** revised by this package: both of its correction loops are exhausted, and nothing here is
correction loop 3. This is separately scoped new implementation work with its own two-loop budget.

Every finding keeps a stable ID. A finding leaves this register only by being **fixed** or by an
**owner decision**, never by being reclassified into something that sounds smaller.

## Classes

| Class | Meaning |
|---|---|
| **REPO** | Repository-fixable now, with no owner input |
| **OWNER-CFG** | Blocked by owner configuration (values, activation) — the *surface* may still be repository-fixable |
| **PROVIDER** | Blocked by a credential or a provider the owner must supply |
| **CHANNEL** | Depends on a later approved channel integration |

## The twelve

| ID | Finding | Sev | Requirement | Runtime path | Reproducible | Class | Disposition in R1 |
|---|---|---|---|---|---|---|---|
| **OF-001** | No scheduled drain calls `claim_inbound_dispatch_batch`; a failed dispatch is recovered only by provider redelivery, which is bounded by how long the provider keeps redelivering | **P0** reliability | FOUND-003 | none — the batch RPC has no caller | Yes: fail a dispatch, observe nothing re-drives it | REPO | **IN SCOPE (§3)** — build the scheduled drain |
| **OF-002** | No processor exists for a captured finance event; the sweeper releases it, so captures accumulate as backlog | **P0** functional | FOUND-003 | `/api/cron/inbound-sweeper` returns `no_processor` | Yes: capture an event, sweep, observe release | REPO | **IN SCOPE (§4)** — build the consumer |
| **OF-003** | Finance classification has no model provider, so a staff message reaches the review queue rather than capture | P1 | FOUND-003 | `classifyFinanceIntent` returns `null` | Yes: by inspection and by the dispatch tests | PROVIDER | **Stays open.** R1 makes the processor work with deterministic fixtures; the live classifier remains an owner gate and FOUND-003 stays `blocked_owner` |
| **OF-004** | Until a receiving number is mapped in `channel_accounts`, the documented single-tenant bridge attributes messages | P1 | FOUND-003 | `resolve_channel_company` fallback branch | Yes: `channel-account-company.test.ts` proves both halves | OWNER-CFG | **SURFACE IN SCOPE (§5)** — build the admin mapping screen. Values and activation stay an owner gate |
| **OF-005** | Nobody can work the review queue until someone is granted `operations.inbound.review` | P1 | FOUND-003 | RLS on `inbound_reviews` | Yes: `inbound-review-queue.test.ts` | OWNER-CFG | **SURFACE IN SCOPE (§5)** — build capability assignment. The grant itself stays an owner action |
| **OF-006** | Non-WhatsApp ingestion (email, upload, bank file) has no dispatch path, so such a row is claimable by neither lifecycle | P2 | FOUND-003 + new channel requirements | `makeSupabaseSourceEventStore` has no production caller | Yes: by construction — `dispatch_state` default `pending`, sweeper needs `dispatched` | CHANNEL | **FOUNDATION IN SCOPE (§6)** — one canonical adapter contract, WhatsApp uses it. Each other channel becomes its own requirement at `foundation_only` |
| **OF-007** | A service-role caller can assert `actor_source='human'` by naming a real member | **P0** security | AIM-003 | `route_task` provenance parameter | Yes — demonstrated by the second review and re-demonstrated in §2 | REPO | **IN SCOPE (§2)** — split the trust boundaries. **AIM-003 is moved OFF `locally_verified` now**, because this is a hole in the trust boundary it claims |
| **OF-008** | Nothing proposes an assignee (WRK-002/WRK-005 unbuilt), and there is no queue UI for `needs_routing` work | P1 | AIM-003, WRK-002, WRK-005 | `route-captured-tasks.ts` never assigns | Yes: every capture lands in `needs_routing` | REPO | **Stays open.** Not in R1's scope; a recommender is its own requirement and inventing one is the failure this program exists to stop |
| **OF-009** | The occurrence window is a UTC date and the monitor re-analyses on every inbound message, so an unresolved follow-up on an active thread is recreated once per day | P2 | AIM-002 | `taskIdentityPartsForPlan` window | Yes: `case-task-dedup-wiring.test.ts` "a new occurrence window is new work" | REPO | **Stays open.** A shorter or purpose-specific window is a design decision with real trade-offs; not smuggled into R1 |
| **OF-010** | `task_duplicate_suggestions` has no producer, so semantic near-duplicates are never surfaced | P2 | AIM-002 | table exists, nothing writes it | Yes: no writer in `src/` | REPO | **Stays open.** Concern (2) of migration 0071; needs a similarity producer, which is its own requirement |
| **OF-011** | `runQuotationTurn` takes no `CostLedger`, so the highest-volume model call produces no `ai_runs` row | P2 | MOD-002 | `src/ai/quotation.ts` | Yes: by signature | REPO | **Stays open.** Belongs to MOD-002, not to the inbound boundary |
| **OF-012** | `RLS_READS`/`RLS_WRITES` are OFF, so the app reads through the RLS-bypassing service-role client | P1 | FOUND-006 | `supabaseReadClient` / `supabaseWriteClient` | Yes: flags default off | REPO + OWNER-CFG | **Stays open.** FOUND-006 is the next slice after R1, and flipping the flags is an owner action |

**Six findings are in R1's scope (OF-001, OF-002, OF-004, OF-005, OF-006, OF-007). Six stay open
(OF-003, OF-008, OF-009, OF-010, OF-011, OF-012)** — three of them because they need an owner or a
provider, three because they are separate requirements this package deliberately does not absorb.

## Requirement status decisions taken BEFORE implementation

* **AIM-003 moves from `locally_verified` to `implementation_in_progress`.** OF-007 is a hole in the
  exact trust boundary AIM-003 asserts ("an automated actor cannot supersede a human assignment"),
  so the requirement cannot stand as verified while it exists. It is not marked complete again until
  §2 is built, tested and independently reviewed.
* **FOUND-003 stays `blocked_owner`.** Live finance classification is unavailable (OF-003), and R1
  does not change that.

## Requirement totals before R1

Measured with `npm run autonomy:audit` at `375ab64`, before any R1 change:

```
registered=89 verified=14 incomplete-implementable=70 blocked-owner=4 blocked-external=0 deferred=1
absent=41 blocked_owner=4 deliberately_deferred=1 foundation_only=23
implementation_in_progress=1 locally_verified=14 specified=5
```

After the AIM-003 status decision above and before any implementation:

```
registered=89 verified=13 incomplete-implementable=71 blocked-owner=4 blocked-external=0 deferred=1
absent=41 blocked_owner=4 deliberately_deferred=1 foundation_only=23
implementation_in_progress=2 locally_verified=13 specified=5
```

The verified count goes **down** by one before a line of R1 code is written. That is the point of
recording it here.

---

## Found DURING R1, not before it

The owner's §1 asked for the twelve findings that existed when R1 began. §7's extreme testing then
surfaced a thirteenth. It is recorded here rather than folded silently into a fix, because the point
of this register is that nothing gets quietly reclassified.

| ID | Finding | Sev | Requirement | Runtime path | Reproducible | Class | Disposition |
|---|---|---|---|---|---|---|---|
| **OF-013** | `loadCompanyContext` returned the literal string `"system"` as `submitterUserId`, and `approval_requests.submitted_by` is `uuid NOT NULL`. Every captured finance message that reached the approval branch failed with `invalid input syntax for type uuid: "system"`, retried under the sweeper's budget, and dead-lettered — so a message describing a real payment reached no approver | **P0** functional | FOUND-003 | `src/db/consumer-store.ts` → `createApprovalRequest` | Yes — reproduced on a disposable local PostgreSQL; `system-submitted-approval.test.ts` fails 4/5 at `0001–0080` and passes at `0081` | REPO | **FIXED (§7)** — migration **0081** gives the request an explicit provenance (`submitted_by_source`), mirroring what 0078 did for routing decisions |

**Why it had never been seen.** The approval branch of `processSourceEvent` had no production caller
until R1 §4 wired the finance consumer, and the classifier that gets a message that far is an owner
gate (OF-003). The extreme end-to-end run is the first thing that ever executed it against a real
database. It is exactly the class of defect §7 exists to find, and it argues against treating a
pipeline as working because its unit tests pass.

**What the fix does NOT do.** It does not weaken separation of duties. `canActOnApproval` refuses an
approver who is also the submitter; a system-submitted request names no submitter, so it excludes
nobody — and a person cannot create one, because migration 0081 refuses `submitted_by_source =
'system'` to any caller that is not an explicit service context, and the existing RLS `with check`
already forces `submitted_by = auth.uid()` for `authenticated`. Provenance is immutable after
insert; the decision (`status`) stays mutable.

---

## Found by the R1 §8 independent review

Fourteen findings, each reproduced on a disposable local PostgreSQL before being accepted. Twelve
were fixed in correction loop 1 (see `R1_REMEDIATION_REPORT.md` §9). Two are recorded here instead,
because fixing them inside this package would have been the wrong call.

| ID | Finding | Sev | Requirement | Runtime path | Reproducible | Class | Disposition |
|---|---|---|---|---|---|---|---|
| **OF-014** | `caller_jwt_role()` reads `request.jwt.claims`, a SETTABLE GUC. An `authenticated` session that can execute arbitrary SQL can `set_config('request.jwt.claims','{"role":"service_role"}')` and every `caller_jwt_role()` gate then reads `service_role` | P1 security | FOUND-006 and every service-only boundary | Migrations **0038–0082** all rest on it | Yes — demonstrated by the reviewer on a disposable database | REPO | **STAYS OPEN.** Not introduced by R1, not reachable through PostgREST (which sets the claims itself and does not run caller SQL), and it is the single point every service-only boundary rests on — so changing it is a boundary-wide design change, not a line in a remediation package. It belongs with FOUND-006, the RLS/service-role cutover, where the trust model is the subject rather than a dependency |
| **OF-015** | §3 (the scheduled drain), §5 (owner configuration) and §6 (the canonical adapter) have no DISCRIMINATING end-to-end coverage: extreme paths 2, 3, 5, 7 and 9 all pass against `0001–0077`, i.e. against a tree without any of them | P2 test-quality | FOUND-003 | n/a — a gap in evidence, not in behaviour | Yes — the reviewer re-ran the discrimination matrix and confirmed it | REPO | **PARTLY ADDRESSED, honestly stated.** Each of those sections has its own discriminating file (`dispatch-drain` 2 of 9 fail at `0078`; `owner-configuration` 12 of 12 fail at `0079`; `inbound-adapter` and the loop-1 corrections cover §6). What does NOT exist is an end-to-end path that fails without them, and the report says so rather than implying the nine paths cover all nine sections |

**Why OF-014 is not quietly downgraded.** It is a real weakness in a control this package leans on
heavily — every RPC added in §2 through §7 gates on `caller_jwt_role()`. Recording it as P1 and open
is the honest position; silently treating it as out of scope because it predates R1 would be exactly
the reclassification the owner ruled out.

---

## Found by evidence closure (package 0083)

| ID | Finding | Sev | Requirement | Runtime path | Reproducible | Class | Disposition |
|---|---|---|---|---|---|---|---|
| **OF-016** | A suspected duplicate has **no authorized resolution path**. `duplicate_reviews` rows are durable, correctly evidenced and readable by an authorized member, but there is no resolution RPC, no screen, and no write grant — and the paused payment appears on no screen, because the only page rendering financial events reads exclusively from `approval_requests`. A real payment therefore pauses in `awaiting_information` and nothing in the product can move it again | **P0** functional | FOUND-003, AIM-002 | `duplicate_reviews` is written by `src/db/consumer-store.ts` and read by nothing | Yes — `tests/integration/duplicate-review-and-approval-visibility.test.ts` proves each half: no `%duplicate%resolve%` function exists, an authorized member's UPDATE is refused `42501`, and a paused event exists with no approval request | REPO | **MATERIAL BLOCKER. NOT FIXED.** The package's two correction loops are spent, and the owner's directive is explicit that a defect found during evidence closure is recorded and placed in the next bounded package rather than repaired in a third loop |

**Is it a regression?** No — it is a sideways move that is strictly better in one respect and no better in
another. Before 0083 a scored duplicate went to the **terminal** `duplicate` state: equally invisible,
and additionally irreversible. After 0083 it goes to `awaiting_information`: still invisible and still
unresolvable, but **reversible**, so every row a future resolution path finds can be recovered without
a data migration. What 0083 fixed is that a *score alone* no longer discards a payment; what it did
not build is the workflow a person uses to decide.

**What the next package must add:** a resolution RPC (confirm-duplicate / declare-distinct, capability
gated, audited, company scoped, idempotent so "distinct" resumes processing exactly once), a review
screen, and the paused-payment visibility that today only `approval_requests` provides.

---

## Found by the FOUND-006 independent security review

Six findings, each reproduced on a disposable local PostgreSQL before being accepted. Five are fixed
in correction loop 1 (migration **0085** + doc + tests). One cannot be fixed by this repository at
all and is recorded as an owner gate.

| ID | Finding | Sev | Disposition |
|---|---|---|---|
| **F-01 / OF-017** | `SET ROLE` is authorized against `session_user`, which under PostgREST is `authenticator` — a member of `service_role`. A caller with arbitrary SQL as `authenticated` escalates to full service privilege in ONE statement, no forgery needed | **P1** security | **NOT FIXABLE HERE — owner gate.** See below |
| F-02 | 0084's "no claim-to-authority" assertion matched one syntactic form; a bare `if caller_jwt_role() = 'service_role' then …` sailed past it | P2 | **FIXED (0085).** Replaced with a reachability invariant against an exact-signature allowlist — any api-reachable SECURITY DEFINER function referencing `caller_jwt_role`, in any syntax, now fails |
| F-03 | The trust-model inventory said "48 functions / 17 api-reachable"; 17 was the pre-0084 number and 48 matched no definition. The table's own columns did not sum to either | P2 | **FIXED.** Recomputed: **45 / 15**, classes reconciled, and the false claim that a trigger function needs EXECUTE to fire is corrected |
| F-04 | No test in the FOUND-006 file fired `quotation_items_enforce_frozen` — the split's only consumer. A reviewer reinstated the `CASE` regression and the file stayed green | P2 | **FIXED.** Two trigger cases added, from genuine login roles, covering both branches and the fail-closed path |
| F-05 | The rewritten wp12 "fail closed" assertion passed vacuously: the bespoke role died in the ACL before the guard's own refusal, same SQLSTATE | P2 | **FIXED.** The probe role now inherits `authenticated` so it reaches the guard, and the guard's own message is asserted |
| F-06 | The doc credited the WP12 delivery functions with calling `_quotation_status_read`; they do not | P2 | **FIXED.** Corrected from the catalog — exactly two callers |

### OF-017 (P1) — the `SET ROLE` escalation

```
begin; set local role authenticated;      -- the shape a PostgREST request runs in
  has_function_privilege(current_user, 'quotation_status_for_service…', 'EXECUTE')  → f
set role service_role;                    -- ONE statement, nothing forged
  current_user → service_role;  has_function_privilege(…) → t;  quotation_status_for_service(…) → 'sent'
```

**Why the repository cannot fix it.** `SET ROLE` succeeds because ONE login role (`authenticator`) is
a member of both the API roles and `service_role` — which PostgREST requires in order to serve
service-key requests at all. A migration that revoked that membership would break the service path on
a live project. The fix is topological: **the service backend must connect as a login role that is
not the one serving public API traffic, and the public one must hold no `service_role` membership.**
That is a deployment change and an owner action.

**Why it is not a regression.** At 0083 the same attacker forged the GUC and arrived in the same
place. 0084 removed the door that needed no escalation; it never claimed to remove `SET ROLE` — and
an earlier draft of the trust model wrongly said the two problems were separable. That claim is
withdrawn.

**How it is kept honest.** `tests/integration/found-006-caller-trust.test.ts` pins the current state:
the escalation is asserted to SUCCEED, with a message naming the remediation. The day the owner
separates the roles, that assertion fails and forces the trust model, the test and FOUND-006's status
to be updated together.
