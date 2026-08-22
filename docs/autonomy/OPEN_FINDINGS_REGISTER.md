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

PostgreSQL 16's `GRANT … WITH SET FALSE` is the general in-database control for this class — inherit
the privileges, forbid the `SET ROLE`. It does not help here, because PostgREST needs `SET ROLE` on
that same login role to switch between `anon`, `authenticated` and `service_role` at all. So the
accurate claim is not "no in-database control exists" but **"none closes this while one login role
must switch into both sets"**. Event triggers cannot intercept `SET ROLE` and `NOINHERIT` does not
restrict it. (Precision added after security review 2.)

**Why it is not a regression.** At 0083 the same attacker forged the GUC and arrived in the same
place. 0084 removed the door that needed no escalation; it never claimed to remove `SET ROLE` — and
an earlier draft of the trust model wrongly said the two problems were separable. That claim is
withdrawn.

**How it is kept honest.** `tests/integration/found-006-caller-trust.test.ts` carries two separate
tests. A **detector** enumerates the real non-superuser login roles in the database under test —
excluding the probe roles the integration suite creates — and fails naming any role that holds both
`service_role` and an api-role membership. A **demonstration** builds a merged role deliberately and
shows the escalation is one statement long.

> **Corrected after security review 2 (G-03).** This paragraph previously said the test "pins the
> current state: the escalation is asserted to SUCCEED … the day the owner separates the roles, that
> assertion fails". That was false. The test created the merged role itself in `beforeAll`, so it
> measured its own fixture — the owner could separate every role in the deployment and it would have
> gone on passing. It was also titled as the security property while asserting the property was
> violated, so a green tick read as "safe". Both the test and this description are fixed.

---

## FOUND-006 — security review 2 of 2 (findings G-01 … G-07)

Reviewed at `0fd5f7b` (migrations 0084 + 0085). Verdict **CHANGES REQUESTED**. All seven are fixed
in correction loop 2 of 2; migration **0086** carries the production change.

| | Finding | Severity | Disposition |
|---|---|---|---|
| **G-01** | `_resolve_actor` (0049) read `request.jwt.claims` directly and turned `role=service_role` into `actor_type='system'`. Nine SECURITY DEFINER finance RPCs — all EXECUTE-able by `authenticated` — gated their capability check on that value, so a forged claim **skipped it entirely**. Also defeated the supplier bank-change maker-checker, because the system path set `v_actor := null` and `v_requested_by = v_actor` is never true against NULL | **P0** security | **FIXED (0086).** Reproduced independently before fixing, then re-verified closed. See below |
| G-02 | The 0085 invariant filtered on `prosrc like '%caller_jwt_role%'`, so it could not see G-01 at all: `_resolve_actor` is SECURITY **INVOKER** (outside the `prosecdef` population no matter how the text predicate widens) and its nine definer callers name neither the helper nor `current_setting`. The reviewer also evaded the text form with dynamic SQL and with a direct GUC read | P1 | **FIXED (0086).** Replaced with a **call-graph** invariant: every api-reachable definer function that can reach claim text by any path must be on a reviewed allowlist of 22. Mirrored in the permanent test gate |
| G-03 | The "topology detector" created the merged role itself in `beforeAll`, so it measured its own fixture — the owner could separate every role in the deployment and it would still pass. It was also titled as the security property while asserting the property was violated, and §5b of the trust model described the opposite polarity from the code | P1 | **FIXED.** Split into a detector that reads the real login roles (excluding suite probes) and a demonstration that is titled as one. §5b corrected |
| G-04 | The corrected inventory's counts (45 / 15) were right, but `quotation_status_for_capable` was named as one of the 15 while not being in the population at all; the real member is `_is_quotation_delivery_owner()`. The "48 classifications … three appear in two rows" reconciliation was invented and dropped the table's own first row | P2 | **FIXED.** Recomputed against `pg_proc`: 30 + 15 = 45, no double counting |
| G-05 | F-06 was recorded FIXED in the previous loop, but the sentence carrying the error was **byte-identical** across both commits — the WP12 delivery functions were still credited with calling `_quotation_status_read` | P2 | **FIXED.** The sentence is now actually edited |
| G-06 | (a) 0085's DO block compared `regprocedure` renderings without pinning `search_path`, so a runner whose path omits `public` aborts a healthy migration — reproduced. (b) The allowlist is signature-exact but body-blind: a permissive rewrite of either allowed function would pass | P2 | **FIXED.** (a) `search_path` pinned and the comparison made rendering-independent. (b) Both allowlisted functions now asserted **by execution** |
| G-07 | `secure-definer-grants.test.ts` still allowlisted `_quotation_status_for_guard(uuid,uuid)`, which 0084 drops — pre-approving the claim-branch function if it ever returned | P2 | **FIXED.** Entry removed; 0086 also fails closed on any stale allowlist entry |

### G-01 (P0) — reproduced, then closed

From a genuine login role that is a member of `authenticated` and nothing else
(`pg_has_role(current_user,'service_role','MEMBER')` = false, and the same for `session_user`, so
this is **not** OF-017 — no `SET ROLE` is involved):

```
set local role authenticated;
-- honest claim:  ERROR: missing capability finance.journal.post
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.post_manual_journal(…);
--> journal_entries: memo 'FORGED-BY-CLAIM-TEXT', status 'posted', posted_by NULL, total_debit 999999.0000
```

After migration 0086, the identical call:

```
ERROR:  access denied: caller without a subject — this entrypoint is human-only
-- and with a subject, it falls through to a REAL check:
ERROR:  missing capability finance.journal.post
```

**Pre-existing** — it reproduces identically at 0083, so 0084/0085 did not introduce it. That is a
scoping fact, not a defence: FOUND-006 is the package chartered to close this class, and the
precondition is context 5 of its own threat model.

**Why the fix is one function and not a nine-way split.** The split *is* the right pattern where a
service caller exists. None does: `supabaseRpcClient()` — the only client any of the nine is called
through — is "ALWAYS the authenticated client … NEVER routes a user-initiated financial RPC through
the service role", and no worker, accounting-core module or other database function calls any of
them. Posting a material journal with no human and no permission check is also what CLAUDE.md's
financial control forbids. So the branch is removed at the single point all nine already share, and
a future service caller gets a `service_role`-granted sibling entrypoint per 0084's pattern.

**Residual, stated plainly:** identity still comes from the `sub` claim. That is impersonation —
the documented inherent residual — and it is strictly smaller: an impersonator must know a real
privileged user's id *and* that user must genuinely hold the capability, which is now checked. It is
not a free pass.

### A related correctness gap found while auditing, recorded not fixed

**OF-018 (P2, not exploitable).** `resolve_inbound_review` and `record_inbound_review` (migration
0075) guard with `caller_jwt_role() is distinct from 'service_role'` **in addition to** their
EXECUTE grant. That is fail-closed, so it is not a hole — but it contradicts the second half of the
rule this package enforces: a genuine `service_role` database caller whose claim text differs (a
direct connection sets no GUC at all) is refused. Cheap to correct — delete the claim branch, the
grant already gates it — and it belongs in a bounded follow-up, not in this loop and not in frozen
0083.


---

## FOUND-006 — ACCEPTED (owner, 2026-08-19)

Accepted as **locally verified** at exact SHA `be2f13e`. This is local technical acceptance, **not
production approval**: no merge, no hosted or staging migration, no flag activation, no deployment.

Acceptance basis, as recorded by the owner:

* Request/JWT role text can no longer convert an authenticated caller into a system actor for the
  nine human finance RPCs.
* Their capability checks are now unconditional for authenticated human callers.
* Exact database grants remain the service-only authority boundary.
* The supplier bank-change maker-checker can no longer be bypassed through a forged system actor.
* Fresh, narrow and realistic legacy database paths passed.
* Ten discriminating tests fail at 0085 and pass at 0086.
* Both independent-review correction loops were used.
* The misleading topology test and the false F-06 documentation claim were corrected.

**OF-017 remains open** and unchanged: it is a deployment topology property, not a repository defect.

### OF-018 (P2) — scheduled, not folded into OF-016

`resolve_inbound_review` and `record_inbound_review` (migration 0075) gate on
`caller_jwt_role() is distinct from 'service_role'` **in addition to** their EXECUTE grants.

* Fail-**closed**: a genuine `service_role` caller whose request claim text differs — a direct
  connection sets no GUC at all — is unnecessarily refused.
* It grants **nothing** to `anon` or `authenticated`, so it is not a privilege-escalation defect and
  was **not** part of FOUND-006's acceptance.
* Deliberately **not** folded into OF-016: that package's own RPCs do not call the affected inbound
  path, so there is no dependency that would justify widening its scope.
* **Scheduled** as a bounded cleanup, to be done before any module genuinely requires service-role
  access to those RPCs. Migration 0087 does not copy the pattern — see its header.

---

## OF-016 — RESOLVED by migration 0087 (pending independent review)

The material blocker recorded during the 0083 evidence-closure pass: a suspected duplicate had no
resolution RPC, no screen and no write grant, so a real payment paused reversibly with nothing in
the product able to move it again.

| Piece | What it is |
|---|---|
| `finance.duplicate.resolve` | A narrow capability, seeded to `finance_reviewer`, `owner_management`, `system_administrator` |
| `resolve_duplicate_review(review, resolution, reason)` | **Human-only by GRANT** — `authenticated` only, never `anon`, never `service_role`. Actor from `auth.uid()`; company read from the review row, never from the caller; active membership and capability re-checked under the row locks; one transaction for the state change and the audit; idempotent on replay |
| `duplicate_review_queue(company)` | The reviewer's read — both transactions, amounts, currencies, dates, counterparties, score, per-feature contributions, evidence present/missing, rule version. Capability checked inside its own predicate |
| `financial_events.duplicate_of_event_id` | The link a confirmation writes. The original event is never rewritten |
| Immutability trigger | SECURITY **INVOKER** — the one context where `current_user` is the caller. A resolved decision cannot be altered or deleted, including by `service_role`, which is the only api-adjacent role holding table DML |
| `/app/finance/duplicate-reviews` | The queue, plus counts on the finance hub, a banner on approvals (a paused payment has **no** approval request, so it can never appear in that list), and a health signal |

**The resume loop, which is the part that is easy to get wrong.** A dismissal returns the event to
`draft` and makes its source event claimable again — so without a durable record of the human
decision, the very next pass would score the same pair, raise the same suspicion, and re-pause the
payment the reviewer just released. `recentEventsForDedup` therefore excludes counterparts already
ruled distinct **for that event**. It is narrow on purpose: every other pairing is still scored.

**Lock order**, documented once and shared with the finance worker:
`source_events → financial_events → duplicate_reviews → approval_requests / payments`. The source
event goes first because it is the processing linearization object — `claim_source_events` takes
`for update skip locked` on it, so a reviewer holding that lock makes the worker **skip** rather than
queue behind human review.

**Discrimination:** measured at the final SHA — see the correction-loop sections below. (An earlier version of this line claimed "all 24 database tests"; that was two files, not the package, and leaving a corrected figure beside an uncorrected one is the G-05 mistake this register already has a name for.)


### OF-016 — what the browser evidence does and does not cover

Stated plainly, because the gap is permanent in this container and a reader should not have to infer it.

**Tested, in real Chromium at 390 / 768 / 1440** (`scripts/verify/browser-check-duplicate-reviews.mjs`,
22 checks, three consecutive green runs): every OF-016 route is served and redirects a signed-out
visitor to sign-in rather than rendering a paused payment; the pages that do render lay out with **no
horizontal overflow, measured in the browser** (`documentElement.scrollWidth <= innerWidth + 1`, not
inferred from CSS); no console errors and no failed requests at any width.

**Tested, against a disposable local PostgreSQL 16** — the component rendered against rows the real
`resolve_duplicate_review` RPC actually wrote, asserting the displayed money, dates, counterparties,
score, contributions, missing evidence, rule version, decision, actor name and reason against the
stored values (`of016-rendered-matches-persisted.test.tsx`).

**NOT tested: authenticated Supabase browser end-to-end.** There is no Supabase instance in this
container, and the application reaches its database over Supabase's HTTP API — so no local browser
check can sign in, load the queue with rows in it, or click a button that resolves one. Session
behaviour across refresh and restart, and RLS as enforced by the real PostgREST request pipeline, are
likewise unproven locally. This is an environmental limit, not an oversight, and it is **not** closed
by any amount of further local work.

Those gaps are exactly what `docs/autonomy/OF016_STAGING_TEST_CHECKLIST.md` is for. It is prepared
for a human tester and **has not been run** — no hosted or staging migration has been applied, no
flag activated, nothing deployed.


---

## OF-016 — independent review 1, and correction loop 1 of 2

Reviewed at `14f5fd6`. Verdict **CHANGES REQUESTED**: one P0, three P1s, five P2s and one process
finding. Every one reproduced independently before being accepted. Migration **0088** carries the
database corrections.

| | Finding | Severity | Disposition |
|---|---|---|---|
| **H-01** | **"Dismissed as distinct" did not release the payment — it dead-lettered it.** The exclusion removed the dismissed *counterpart* but not **the event itself**, which is in `draft` after a release and so is not filtered out of its own candidate set. On the next pass it scored against itself at 1.0, `openDuplicateReview` tried to insert `financial_event_id = matched_event_id`, 0083's `duplicate_reviews_distinct_ck` rejected it, the pipeline threw on every sweep, and the sweeper dead-lettered the payment | **P0** | **FIXED.** The store now excludes the event under consideration; the pipeline repeats the check as defence in depth |
| **H-02** | `service_role` could **fabricate** a resolved review by INSERT — 0087's trigger was `before update or delete` only. It rendered on the reviewer's screen as a real decision by a real named person, with no audit row, and a forged `dismissed_distinct` also silently suppressed detection for that pair | **P1** | **FIXED (0088).** A `before insert` boundary: a non-trusted writer may create a review only in the initial open state. The pipeline's own open insert still works |
| **H-03** | A resolved decision was destroyable two ways: `TRUNCATE` (row triggers do not fire) and cascade through the parent `financial_events` delete | **P1** | **FIXED (0088).** A statement-level truncate guard, and a parent-delete guard that refuses when a **resolved** review references either side. An **open** suspicion still cascades, so authorised pre-decision cleanup keeps working |
| **H-04** | The immutability test could not fail: a `rollback to savepoint sp` for a savepoint never created threw inside a bare `catch {}`, which swallowed the AssertionError with it. Proven inert by reverting the control and watching 17/17 pass | **P1** | **FIXED.** The `catch` is gone. Verified the test now FAILS against a clone with the control reverted |
| **H-05** | The AB-BA test did not discriminate — six reviewers each on their **own** review, and the only other actor used `skip locked`, which never waits. It passed with the RPC's lock order inverted | **P2** | **FIXED.** Split into a **positive control** (a deliberate inverting actor, asserted to deadlock) and a real same-row stress (six reviewers on ONE review plus three workers, zero deadlocks, one decision, one audit row) |
| **H-06** | `duplicate_review_queue` joined both events with no company predicate, and the RPC checked only the candidate's company — a malformed row leaked another company's amount and counterparty, and a confirmation persisted a cross-tenant link | **P2** | **FIXED (0088).** Composite `(id, company_id)` FKs make such a row unwritable; the queue joins on company; the RPC checks the matched event too |
| **H-07** | Three screens gave three answers to the same failed read: health rendered **0** (`rows()` swallows errors), approvals **silently dropped the banner** (supabase-js returns errors rather than throwing, so the `catch` was never reached), the finance hub was right | **P2** | **FIXED.** Health uses `probeCount`/`metricLabel` per §WP6.3; approvals reads `error` and shows an explicit "could not check" notice |
| **H-08** | Releasing an event whose source had been **dead-lettered** produced `status='pending'` still carrying `dead_lettered_at` — a claimable row wearing a terminal stamp | **P2** | **FIXED (0088).** The stamp is cleared, and the audit payload records `cleared_dead_letter` and the prior reason rather than letting the revival vanish |
| **H-09** | Documentation claims the database did not support | **P2** | **CORRECTED** — see below |
| **H-10** | The verification numbers were produced from a tree that was not the reviewed commit: I continued committing evidence work while the review ran, so files appeared under it mid-review | **P2 (process)** | **ACCEPTED.** The claim happened to describe `14f5fd6`, but a reviewer given those numbers and the working tree could not reproduce them. Corrected practice: the tree stays frozen at the reviewed SHA until the review returns |

### The claims that were wrong, corrected

* *"a service worker cannot forge a human decision"* — **was false** (H-02: by INSERT, not by calling
  the function). True as of 0088.
* *"a resolved decision cannot be altered or deleted, including by `service_role`"* — **was false**
  (H-03: TRUNCATE and parent cascade). True as of 0088.
* *"the table takes no direct DML from an api role" / "the RPC is the only writer"* — true for `anon`
  and `authenticated`; **was false for `service_role` INSERT**. True as of 0088.
* *"six reviewers and three workers contending on the same rows … tested rather than asserted"* —
  **was false**: different rows, and the test passed with the lock order inverted. True now, with a
  positive control proving the arrangement can detect an inversion.
* *"recurring rent / salary → released, source event re-armed"* — **half-true and misleading**:
  released and re-armed, then dead-lettered (H-01). True as of the H-01 fix.
* *"all **24** database tests fail at 0086 and pass at 0087. Not a sample — the whole suite"* —
  **wrong as stated.** 24 was two files, not the package. Measured correctly now: **54 of 58**
  OF-016 database tests fail at 0086 and pass at the head; the 4 that pass are negative assertions
  that hold vacuously before the feature exists (e.g. "a non-carrying role does not hold the
  capability", trivially true when the capability does not exist). That is the honest figure, and
  the direction of the original claim held even though its number did not.

### What the review tried and could not break

Authorization from genuine login roles (anon, no-capability member, ended membership, cross-company
reviewer, `service_role`, missing `sub`, another company's review id); replay after a worker had
already processed the event; the state machine; the confirm-races-approval window; confirmed-duplicate
having no business effect and the original staying untouched; the stale-worker path; the
pre-resolved-row migration guard; the legacy upgrade; and a genuine AB-BA deadlock from anything in
the repository. `sub` forgery works, as it does everywhere in this repository — the documented
inherent residual recorded in 0086's own header, not a finding here.


---

## OF-016 — independent review 2, and correction loop 2 of 2 (FINAL)

Reviewed at `23b9b3b`, tree frozen throughout. Verdict **CHANGES REQUESTED**: one P1 and three P2s.
Review 2 confirmed all eight round-1 findings (H-01 … H-08) genuinely closed, having reproduced each
on a pre-fix database and failed to get around any of the fixes — including a bespoke role, `COPY`,
`TRUNCATE … CASCADE`, `session_replication_role='replica'` and `ALTER TABLE … DISABLE TRIGGER`
against the evidence boundary. Migration **0089** carries the loop-2 corrections.

| | Finding | Severity | Disposition |
|---|---|---|---|
| **J-02** | **The package re-created its own blocker one layer up.** The detector writes ONE review per match, so a payment resembling TWO earlier ones raises two open reviews. Confirming one moved the event to `duplicate` — terminal — and the sibling was then resolvable in NEITHER direction, by nobody: the state guard refused both, `service_role` was refused by 0087's triggers, and no api role holds DML. The queue showed it forever, the health tile stayed red, and pressing either button told the reviewer to "Reload to see where it is now" — advice that could never help. Untested because every earlier test seeded exactly one review per event | **P1** | **FIXED (0089).** A decision that TERMINALISES the event now closes the event's other open reviews in the same transaction as `superseded_by_decision` — a third outcome that is explicitly **not** a human verdict on that pair, names the deciding review, and gets its own audit row saying so. **Dismissal deliberately leaves siblings open**: releasing one pair says nothing about another, the pipeline re-pauses on the survivor, and the reviewer decides it on its merits. Closing them would be the silent merge this work exists to prevent |
| **J-01** | "The pipeline repeats the check as defence in depth" was **false** — the guard took a parameter no call site passed, and could not: `findDuplicates` runs BEFORE `createDraft`, so the financial event id does not exist yet. Dead code described as live protection | P2 | **FIXED.** The dead parameter is gone and the real second layer moved to `openDuplicateReview`, where the id exists: a self-match is dropped and logged rather than written. Covered by a test that hands the port a self-match directly |
| **J-03** | H-08 cleared the dead-letter stamp but preserved the spent `attempts`, and `fail_source_event` dead-letters at `attempts >= max_attempts`. A released payment therefore survived **exactly one** transient provider error before dying again — with no second release, because a replay returns the standing decision before re-arming anything. A half-revival | P2 | **FIXED (0089).** A deliberate human release restores the retry budget; the prior count goes into the audit payload, so the history is kept where it can be read rather than in a counter that silently kills the release |
| **J-04** | The corrected "24 tests" figure was added while the false one was left standing in the same file — the **G-05** mistake this register already has a name for | P2 | **FIXED.** The stale line is replaced, and says why |

### Counts, corrected again

The three operator surfaces counted **review rows**, so one paused payment resembling two earlier
ones rendered as "**2** payments are paused". All three now count DISTINCT paused payments, because
that is what their labels say.

### Discrimination at the final SHA

**60 of 65** OF-016 database tests fail at 0086 and pass at head. The 5 that pass at 0086 are
negative or limitation assertions that hold vacuously against that schema — though one of them
(an event is never offered to the scorer as a candidate against itself) does discriminate against a
CODE revert, which is how the J-01 dead guard was caught. Loop-2 specifically: 3 of the 6 new tests
fail at 0088.

### A harness defect worth recording

The browser check printed its summary and then never exited: `stop()` sends SIGTERM but the spawned
`next start` keeps node's event loop alive, so piped into `tail` or wrapped in `timeout` a fully
green run read as a hang and then as a failure. Fixed with an explicit `process.exit(0)`. Two
earlier browser "failures" in this package were also the harness, not the page — a stale server from
a previous run holding the port and serving an old chunk hash, and an aborted mobile background
video whose asset returns 200 with its full 200,234 bytes when requested directly.

### 2026-08-22 local technical acceptance attempt — NOT ACCEPTED

Branch `kimi/of016-local-acceptance-v61`; tested source SHA
`707761ccfc56bf9b3583def6eba39e1691ec56cc`. The only database was the disposable local
`singha-of016-pg16-v61` `postgres:16` container. No hosted/staging database was contacted, no
migration was deployed, no flag was enabled, no real data was used, and no message was sent.

Two acceptance-run corrections were confirmed and committed: `ReviewCard` preserves a PostgreSQL
`date` as local calendar parts instead of shifting it through `toISOString()`, and the FOUND-006
signature-list assertions compare sorted actual and expected lists rather than catalog order. Two
pre-existing Windows test-harness defects were also corrected at their assertion boundaries by
replacing Unix `grep` shell calls with equivalent Node filesystem scans.

Commands run (the disposable connection string is redacted):

```text
$env:DATABASE_URL = '<disposable-local-url>'
npm run test:integration -- --run tests/integration/found-006-caller-trust.test.ts --reporter=dot
$files = Get-ChildItem tests/integration/of016-*.test.ts* | ForEach-Object { $_.FullName }
npm run test:integration -- --run $files --reporter=dot
npm run test:integration -- --reporter=dot
npm run typecheck; npm test -- --reporter=dot
npm run lint; npm run build
npm run browser-check
npm run audit-check; npm run autonomy:ip-check; npm run migrate:status
npm run verify
git fetch --all --tags --prune
node scripts/autonomy/audit-requirements.mjs --quiet
```

Passed: FOUND-006 `21/21`; OF-016 `65/65` across eight files including concurrency,
authorisation, resume, sibling/budget, and rendered-persisted state; full integration `676/676`
across 74 files; unit `760 passed, 2 skipped` across 106 files; typecheck, lint, build,
dependency audit, IP-boundary audit, and migration status (`89 applied`, `0 pending`). The full
integration command terminated normally and left no test-created Node process or database session.

This is **not local technical acceptance**. `npm run browser-check` could not start because no
Chromium binary exists at its configured `/opt/pw-browsers` path. `npm run verify` stopped at the
autonomy evidence audit: 13 historical `last_verified_sha` references are not commits in this
repository even after fetching all refs. These gate failures must be resolved and the affected
checks rerun before OF-016 can be accepted. OF-018 and MOD-003 remain out of scope.

### 2026-08-22 local technical acceptance — ACCEPTED

The prior non-acceptance is superseded. Exact tested SHA:
`2ead28b8d3c29f768ddff4c1eb40f5d1214898dc` on
`kimi/of016-local-acceptance-v61`.

The browser harness now supports a `BROWSER_EXECUTABLE` override and standard Windows, macOS, and
Linux Chromium locations; it starts the installed Next CLI directly instead of assuming a Unix
`npx` executable. The requirement audit now validates Git commit IDs through `execFileSync`, so
Windows shell escaping cannot invalidate a real SHA. The lockfile now includes its declared
`playwright-core` dependency and `npm ci --ignore-scripts` succeeds.

Fresh disposable PostgreSQL 16 evidence: a local Supabase-compatible shim was installed before
the migration run (auth schema/user identity function, API roles/default privileges, and pgcrypto
in `extensions`). Migrations `0001–0089` applied with `89 applied / 0 pending`; migrations
`0087–0089` were not edited. The focused OF-016 suite passed `65/65` across eight files. The full
integration suite passed `676/676` across 74 files. `npm run verify` passed with `760` unit tests
passed and `2` skipped; lint, build, dependency audit, IP-boundary audit, migration lint, and the
9-check real-Chrome browser gate passed. The integration runner left no test-created Node process
or database session.

This is **local technical acceptance only**. The authenticated Supabase browser/RLS end-to-end
path, staging checklist, hosted migration, live provider quality/cost evidence, GitHub Actions,
and production evidence remain unavailable and unclaimed. No hosted/staging database was
contacted, no flag was enabled, no real data was used, and no message was sent. OF-018 is the next
bounded package; MOD-003 remains out of scope until OF-018 is accepted.
