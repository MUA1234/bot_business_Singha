# R1 — remediation package after the exhausted correction loops

Scope: the owner's nine-section remediation authorisation, stacked on the frozen `0069–0077`
boundary at `1fd50b2`. That boundary and its correction report are unchanged; nothing here is
represented as a third correction loop on it.

Everything below was verified on a **disposable local PostgreSQL 16** inside the development
container. **No hosted database was migrated, no feature flag was enabled, no live model provider
was called, no real message was sent, no production data was touched, no secret was committed, and
nothing was merged or deployed.**

Branch: `feature/v3-3-remediation-package`, draft PR **#25**, stacked on
`feature/v3-3-part2-durable-processing` (PR #24).

---

## 1. The findings, and what happened to each

The twelve findings that existed when R1 began are enumerated with their classes and dispositions in
`OPEN_FINDINGS_REGISTER.md`, which was written **before any R1 code**. A thirteenth was found
during §7 and is recorded in the same file rather than folded silently into a fix.

| ID | Sev | Class | Disposition |
|---|---|---|---|
| **OF-001** no scheduled drain | P0 reliability | REPO | **FIXED (§3)** — migration 0079 + `/api/cron/dispatch-drain` |
| **OF-002** no finance capture processor | P0 functional | REPO | **FIXED (§4)** — `makeFinanceCaptureProcessor`, wired into the sweeper |
| **OF-003** no model provider for classification | P1 | PROVIDER | **STAYS OPEN.** FOUND-003 remains `blocked_owner` |
| **OF-004** single-tenant company bridge | P1 | OWNER-CFG | **SURFACE FIXED (§5)** — migration 0080 + `/app/admin/inbound-setup`. Values and activation stay an owner gate |
| **OF-005** nobody holds `operations.inbound.review` | P1 | OWNER-CFG | **SURFACE FIXED (§5)** — audited capability assignment. The grant itself stays an owner action |
| **OF-006** non-WhatsApp ingestion has no dispatch path | P2 | CHANNEL | **FOUNDATION ONLY (§6)** — one canonical adapter contract; WhatsApp uses it. Email, voice and calendar remain `absent` |
| **OF-007** service role can assert `actor_source='human'` | P0 security | REPO | **FIXED (§2)** — migration 0078. AIM-003 came **off** `locally_verified` before any code was written and is not restored on this package's own say-so |
| **OF-008** nothing proposes an assignee | P1 | REPO | **STAYS OPEN.** A recommender is its own requirement |
| **OF-009** UTC-day occurrence window | P2 | REPO | **STAYS OPEN.** A design decision with real trade-offs |
| **OF-010** no producer for duplicate suggestions | P2 | REPO | **STAYS OPEN.** Needs a similarity producer |
| **OF-011** `runQuotationTurn` records no `ai_runs` | P2 | REPO | **STAYS OPEN.** Belongs to MOD-002 |
| **OF-012** RLS flags off | P1 | REPO + OWNER-CFG | **STAYS OPEN.** FOUND-006 is the next slice; flipping the flags is an owner action |
| **OF-013** a system-submitted approval request could not be created | P0 functional | REPO | **FIXED (§7)** — migration 0081. Found by the extreme end-to-end run |

**Nothing was reclassified to make it disappear.** Six of the original twelve remain open, three of
them because they need an owner or a provider and three because they are separate requirements this
package deliberately does not absorb.

## 2. Requirement totals

Measured with `npm run autonomy:audit`.

| Point | registered | verified | incomplete-implementable | blocked-owner | deferred |
|---|---|---|---|---|---|
| Before R1, at `375ab64` | 89 | 14 | 70 | 4 | 1 |
| After the AIM-003 status decision, before any code | 89 | **13** | 71 | 4 | 1 |
| At the end of R1 | 89 | **13** | 71 | 4 | 1 |

The verified count went **down** by one before a line of R1 code was written, and R1 did not put it
back. AIM-003 is `implementation_in_progress` until §8's review passes; FOUND-003 stays
`blocked_owner` while live finance classification is unavailable.

## 3. Migrations added

| # | Name | What it is |
|---|---|---|
| 0078 | `routing_provenance_split` | The human path is callable only by `authenticated` and derives the actor from `auth.uid()`; the AI and system paths are service-only with the source fixed by the function; the spoofable `route_task` is dropped; a DB trigger refuses any other combination and makes provenance immutable |
| 0079 | `dispatch_release` | A receipt claimed at a drain deadline is handed back to `pending` with its attempt **given back**, so a bounded run never charges work it did not do |
| 0080 | `owner_configuration_surface` | Audited channel-account mapping (created inactive, conflict re-checked at activation), capability assignment against a role allowlist with no self-grant, and a setup-status read |
| 0081 | `approval_submitter_provenance` | OF-013 — a system-submitted approval request is possible at all, with explicit, paired and immutable submitter provenance |

`migration-lint` proves the sequence **0001–0081** has no gaps and no duplicates.

## 4. Production runtime entrypoints added

Each of these is a real caller, not a module with no path to it — which is the failure mode this
package exists to correct.

| Entrypoint | What now reaches it |
|---|---|
| `src/app/api/cron/dispatch-drain/route.ts` | `claim_inbound_dispatch_batch` → `dispatchReceipt` → `release_inbound_dispatch`. Previously the batch RPC had no caller at all |
| `src/app/api/cron/inbound-sweeper/route.ts` | `makeFinanceCaptureProcessor` → `processSourceEvent`. Previously returned `no_processor` for everything |
| `src/app/app/admin/inbound-setup/` | `admin_upsert_channel_account`, `admin_set_channel_account_active`, `admin_set_membership_role`, `inbound_setup_status` |
| `src/lib/inbound/adapters/whatsapp.ts` | The WhatsApp webhook now parses through the canonical adapter contract rather than a bespoke extractor |
| `route_task_as_ai` | `src/management/routing/route-captured-tasks.ts`, replacing the dropped `route_task` |

## 5. The nine extreme paths, and what each showed

Run in `tests/integration/extreme-end-to-end.test.ts` against a disposable local PostgreSQL, driving
the real modules. The only substitutions are transports, never decisions: the Supabase HTTP client
(pg-backed, landing on the same SQL), the OpenAI transport (a fixture the real Zod schema still
validates), the Inngest queue (an in-process recorder), and — only where a test supplies it —
`classifyFinanceIntent`, which production still answers `null` (owner gate OF-003).

| Path | Outcome observed |
|---|---|
| 1. receipt → company → identity → classification → source event → drain → processor → policy → approval → audit → health | Without a classifier the message is parked as `manual_review` with an open queue row — not guessed. With the §7 fixture it becomes a company-scoped capture, the sweeper runs the real pipeline, a financial event is drafted at the exact extracted amount, an immutable v1 snapshot and a `require_approval` policy evaluation are recorded, an approval request is created, audit rows exist, **`journal_entries` count is 0**, and the receipt settles to `completed` so the backlog reads 0. A material transaction with no supporting document stops at `awaiting_evidence` with **no** approval request |
| 2. a customer order never becomes staff finance | Dispatched as `customer_order` even when worded as a payment AND classified as one; no financial event; the receipt settles to `processed`; `claim_source_events` returns it to nobody |
| 3. an unknown company is visible | `company_id` stays **null** — not attributed to the only company; state `failed` with `company_unresolved`, one attempt, counted in `inbound_dispatch_health().unattributed`; after an owner maps the account the scheduled drain decides it **by itself**, with no replay of the message |
| 4. provider unavailable → backoff → recovery | The sweep does not complete or dead-letter it: `retry_wait`, attempts incremented, `next_attempt_at` in the future, no financial event. After recovery the retry produces **exactly one** financial event |
| 5. duplicate / replayed message | Five deliveries of one message (three concurrent): **one** receipt row, one business dispatch (the rest refused as `already_dispatched`/`retry_pending`), **one** enqueue, **one** financial event across two sweeps, at most one review row |
| 6. service role forging a human decision | `route_task_as_human` → `42501`; the old `route_task(…, 'human', victim)` → `42883` (dropped); a direct `task_routing_events` INSERT claiming `human` → refused; `route_task_as_ai` works and records `actor_id` **null** with the component, model and policy version; a later UPDATE of provenance → refused |
| 7. cross-company substitution | An extraction that NAMES company B still produces a financial event scoped to company **A** — the receiving account decides. The same staff phone on company B's account is not company B's staff. Under `authenticated`, a company-A reviewer sees only company-A `inbound_reviews` and `source_events` |
| 8. crash at every durable boundary | After the receipt (no dispatch) → the drain decides it; after the claim (dead lease) → recovered and decided once, still one row; after the effect (marker rewound) → re-decided idempotently, at most one review row; mid-consumer (expired sweeper lease) → another run completes it, exactly one financial event |
| 9. browser review and routing states | Under `authenticated`, a capable member reads the same row with the same state as the service view; a member with no capability reads **nothing**; closing records who and why. The rendered components show the **persisted** sender, channel, actor type, identity match and message; an instruction-shaped message is escaped and shown as data; routing counts name each durable state rather than a total |

### Discrimination

Every confirmed defect has a test that fails against the defective schema. Measured, not asserted:

| Test file | vs `0001–0075` | vs `0001–0077` | vs `0001–0080` | at `0001–0081` |
|---|---|---|---|---|
| `extreme-end-to-end.test.ts` (9) | **9 fail** | **4 fail** (1, 4, 6, 8) | **3 fail** (1, 4, 8) | 9 pass |
| `system-submitted-approval.test.ts` (5) | — | — | **4 fail** | 5 pass |
| `routing-provenance.test.ts` (15) | — | **15 fail** | — | 15 pass |
| `dispatch-drain.test.ts` (9) | — | 2 fail vs `0078` | — | 9 pass |
| `owner-configuration.test.ts` (12) | — | — | **12 fail** vs `0079` | 12 pass |
| loop-2 boundary scenarios (8) | — | 7 fail vs `0076` | — | pass |
| loop-1 boundary scenarios (37) | **33 fail** | — | — | pass |

## 6. Containment

Confirmed at the reported SHA:

* nothing merged — the branch is a **draft** PR stacked on PR #24;
* no hosted database migrated — every migration was applied only to disposable local databases,
  created and dropped inside this container;
* no feature flag enabled;
* no production deployment;
* no live provider called — the model transport is a fixture, and `classifyFinanceIntent` still
  returns `null` in production;
* no real message sent and no production data read or written;
* no secret committed — `secret-scan` is green, and the browser check's placeholders are
  deliberately short strings that are obviously not credentials.

## 7. Verification

**Content SHA verified: `3608c8a`** (the stamp commit that records this line is its child; no
content changed between them — only this paragraph and the state file).

Run at that SHA on a **disposable local PostgreSQL 16**.

| Gate | Result |
|---|---|
| Fresh migration apply, `0001–0083` | applied clean |
| Realistic legacy upgrade, `0001–0041` + data then `0042–0083` | applied clean |
| Narrow upgrade, `0001–0082` then `0083` | applied clean |
| Integration — FRESH database | **65 files / 586 tests passed** |
| Integration — REALISTIC LEGACY upgrade | **65 files / 586 tests passed** |
| Integration — NARROW upgrade | **65 files / 586 tests passed** |
| Unit suite | **104 files / 752 passed, 2 skipped** |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors (3 pre-existing `next/image` warnings) |
| `npm run build` | compiled |
| `npm run secret-scan` | clean |
| `npm run migration-lint` | **83 sequential, `0001–0083`**, no gaps or duplicates |
| Requirements audit | consistent; `registered=90 verified=13 incomplete-implementable=72 blocked-owner=4 deferred=1` |
| SECURITY DEFINER grant allowlist | signature-exact, every function classified |
| `search_path` safety gate | every application-owned SECURITY DEFINER and trigger function on the canonical path |
| RLS coverage / matrix / company isolation | passed |
| IP boundary check | no hard violation |
| Browser check (real Chromium, production build) | review, setup and analyze routes served and gated to `/login`; `/` and `/login` render; both cron routes return **401** to an unauthenticated caller **and** to a wrong secret |
| IP / anti-cloning audit | no hard boundary violation |
| Targeted duplicate / approval / adapter / scheduler + security suites | **9 files / 73 tests passed** (`duplicate-review-and-approval-visibility`, `of015-section-coverage`, `r1-review-corrections`, `concurrency`, `rpc-concurrency`, `dispatch-drain`, `secure-definer-grants`, `search-path-safety`, `rls-matrix-coverage`) |
| `npm run verify` | **exits 0** |

**GitHub Actions CI could not run.** Both checks on PR #25 (`verify`, `db-tests`) failed within two
seconds with no runner assigned (`runner_id: 0`, `runner_name: ""`). That is the pre-existing
"GitHub Actions runner provisioning" owner gate, not a failure of this code — every gate above was
run locally instead, and the CI result is reported as unavailable rather than as green.

## 8. What remains blocked

| Blocker | Whose action |
|---|---|
| A model provider credential for finance classification (OF-003) | Owner. FOUND-003 stays `blocked_owner` |
| Mapping each receiving WhatsApp number to its company | Owner. The **screen** now exists; the values do not |
| Granting `operations.inbound.review` | Owner. The **assignment workflow** now exists; the grant does not |
| Hosted scheduling for `/api/cron/dispatch-drain` | Owner. The route and its secret handling exist; scheduling it is an owner action, and `CRON_SECRET` is an environment value that is never committed |
| Hosted migration application (`0042–0081`) | Owner. The hosted database is at `0038–0041` |
| GitHub Actions runner provisioning | Owner |
| Email, voice/transcription and calendar providers | Owner. COM-002, COM-004 and COM-005 remain `absent`; the canonical contract does not advance them |
| FOUND-006 RLS cutover (OF-012) | Next slice, plus an owner flag flip |

## 9. Independent review — TWO LOOPS, BOTH USED

**Loop budget: 2 of 2 spent. There is no third loop.**

### Review 1 — CHANGES REQUESTED, 14 findings

| ID | Sev | Disposition |
|---|---|---|
| R-01 | P0 | **FIXED.** The scheduled drain rebuilt the message from a guessed `{from, text}` shape. §6 had changed `raw_payload` to Meta's own message, where `text` is `{ body }`, so `String(raw_payload.text)` re-dispatched every retried message as `"[object Object]"` — and returned `ok: true`. `InboundAdapter.fromStored` now makes the adapter the only reader |
| R-02 | P0 | **FIXED, then re-fixed** — see S-01. A retry duplicated the drafted payment |
| R-03 | P1 | **FIXED (0082).** An automated caller could deactivate a standing human routing decision and route again as AI |
| R-04 | P1 | **FIXED**, and **its scope was wrong** — see the correction below |
| R-05 | P1 | **FIXED.** `parse` threw on a non-iterable container, losing a whole delivery |
| R-06 | P1 | **FIXED.** A PATH 6 assertion named columns that do not exist and passed on a 42703 |
| R-07 | P2 | **FIXED (0082, corrected in 0083).** No last-holder protection on `owner_management` |
| R-08 | P2 | **FIXED.** The setup page swallowed every failure and rendered zeros as facts |
| R-09 | P2 | **FIXED.** AIM-003 stated OF-007 as live four commits after §2 fixed it |
| R-10 | P2 | **FIXED.** The drain hardcoded `channel: "whatsapp"` for every claimed row |
| R-11 | P2 | **FIXED.** Harness: global kind cache, embedded projections, unfiltered UPDATE, overload resolution |
| R-12 | P2 | **FIXED.** The bespoke-role case was refused by a missing grant, not by the boundary |
| R-13 | P2 | **FIXED.** 0081 had no transaction of its own |
| R-14 | P2 | **FIXED.** An image caption is the message; reading only `text.body` emptied every media message |

### Review 2 — CHANGES REQUESTED, 9 findings

| ID | Sev | Disposition |
|---|---|---|
| S-01 | **P0** | **FIXED (0083).** My own loop-1 R-02 fix introduced it: `createDraft` returned an event no longer in `detected`, and the next step asserted that it was. Every second execution failed permanently and dead-lettered — leaving a captured payment in `awaiting_approval` with **no approval request**, invisible and unapprovable. And nothing settled `source_events.status` on the Inngest path, so the sweeper re-processed rows Inngest had already handled: with the mandated stack configured, **every** finance capture. Fixed three ways — the pipeline resumes from the persisted stage, the crash window creates the missing approval request, and the durable consumer settles its own receipt |
| S-02 | P1 | **FIXED (0083)** — and it **corrected my scope claim**, see below |
| S-03 | P2 | **FIXED (0083).** Two concurrent revokes both saw two holders and emptied the company; the holder rows are now locked |
| S-04 | P2 | **FIXED (0083).** The last-holder check fired when the subject held nothing |
| S-05 | P2 | **FIXED (0083).** The reviewer LIST used role keys while the COUNT used capability including delegations |
| S-06 | P2 | **FIXED.** The TRUNCATE assertion was satisfied by a foreign key and would have passed with the guard deleted |
| S-07 | P2 | **FIXED.** `fromStored` returned null for the pre-§6 flat payload current production still writes |
| S-08 | P2 | **FIXED.** Two `fail_inbound_dispatch` calls discarded their error |
| S-09 | P2 (hypothesis) | **FIXED.** The resumed draft now fails closed on a company mismatch |

## 10. A correction to this report's own earlier claim

Loop 1 stated that duplicate detection was **"silently dead in every end-to-end path"** and implied
production. **That was wrong, and the second review was right to correct it.** The
`.in()` / `.not(…, "in", …)` defect was in the TEST HARNESS
(`tests/integration/helpers/pg-supabase.ts`) only — production's supabase-js emits valid PostgREST,
and `processSourceEvent` has been Inngest-wired since before R1. Duplicate detection was never dead
in production. The harness bug is fixed; the claim about production is withdrawn.

## 11. OF-014 — narrow fix, and the boundary that remains

**Assessed as the directive required.** All 28 functions consulting `caller_jwt_role()` enumerated
with signature, DEFINER/INVOKER, owner, grants and reachability. Attacked from a **genuine
`authenticated`-only login role**, not the harness superuser.

| Probe | Result |
|---|---|
| `SET ROLE service_role` | permission denied |
| forge `request.jwt.claims` | succeeds; `caller_jwt_role()` returns `service_role` |
| `inbound_dispatch_health()`, `claim_source_events`, `record_inbound_receipt`, `admin_set_membership_role` | **permission denied for function** — all four |
| direct DML on `source_events` | permission denied for table |
| the approval provenance trigger, via INSERT | refused by RLS before the trigger |
| the individual-claim GUC form (`request.jwt.claim.role`) | not read — vector does not apply |
| `_quotation_status_for_guard` with the forged claim | **returned `sent`** — and **`anon` could too** |

**Conclusion: forging the role claim does not generally grant service-role access.** Database
EXECUTE grants, table grants and RLS are the effective systemic gates for every tested service-only
path — 24 of 27 callable functions are unreachable by `authenticated` and `anon` outright.

**The one genuine exception is fixed only in part, deliberately.** The directive permitted a
`pg_has_role` predicate *only after proving its behaviour in that function's exact context*. **The
proof failed:** the function is SECURITY DEFINER, so `current_user` is the owner; and `session_user`
under PostgREST is `authenticator`, which Supabase grants membership of `service_role` — the check
would have been true for every ordinary web request. Trying it turned `wp12-enqueue-item-race` red
by breaking a fail-closed control. Migration 0083 therefore takes only what is provable: **`anon`
and PUBLIC lose EXECUTE**, closing the unauthenticated disclosure entirely.

**What remains, and is NOT solved:** a caller able to run ARBITRARY SQL as the `authenticated`
database role can still forge the claim and read one quotation status per known id — and, more
broadly, can forge `sub` and so control `auth.uid()` and every RLS policy. That is the FOUND-006
boundary. **FOUND-006 is not solved and stays unaccepted.** It is the next package.

## 12. The duplicate-detection behaviour change

`duplicate` is a TERMINAL state with no transition out. The old rule declared a duplicate on
`score >= 0.7` alone, and the arithmetic let two features carry it — so a payment could be
terminally discarded with **no counterparty evidence at all**, or with **no date proximity at all**.

Now: exact idempotency (canonical event identity, one draft per source event) is separate from
heuristic suspicion; every feature must contribute; missing evidence is never a match; and a
suspicion pauses the event in the **reversible** `awaiting_information` with a `duplicate_reviews`
row carrying the pair, score, per-feature contributions, evidence present and missing, and the rule
version.

| Scenario | Old | New |
|---|---|---|
| Same payment, same document, twice | duplicate (1.0) | suspected — a person decides |
| Same amount, same day, **different suppliers** | **terminally discarded** (0.8) | not suspected |
| **Recurring rent / salary / instalment** | **terminally discarded** (0.7) | not suspected |
| Identical generic descriptions, no counterparty | **terminally discarded** (0.8) | not suspected |
| Counterparty missing on one side | terminally discarded | not suspected |
| Same supplier + amount, one day apart, different invoices | terminally discarded | suspected — a person decides |
| Same amount, different currency | not a match | not a match |
| Window boundary (exactly 3 days) | 0.7, discarded | not suspected |
| Paraphrase sharing the supplier name | suspected | suspected |
| Cross-company | not a match | not a match |
| Rejected/cancelled predecessor | excluded from scoring | excluded from scoring |
| Exact provider replay / concurrent replay / retry | never scored (identity, lease, one-draft index) | unchanged |

**16 scenarios measured in `tests/duplicate-scenarios.test.ts`.**

## 13. OF-015 — section coverage, and what it does and does not establish

`tests/integration/of015-section-coverage.test.ts` — 17 scenarios through real production
entrypoints.

| Group | Covered | Discrimination |
|---|---|---|
| §3 scheduled drain | credential refusal (absent / wrong / malformed), persist → adapter round-trip → claim → decide → lease release, unknown source failed `no_adapter` with no company invented, transient failure with a **growing** backoff and no dead-letter, overlapping runs deciding once, a settled receipt unclaimable, health matching actual state | **1 of 7 fails at 0082.** The rest is CODE, not schema — a schema rollback cannot remove the drain route, so its discrimination is the reproduction recorded in loop 1 (the `"[object Object]"` body and the absent `no_adapter` outcome) |
| §5 owner configuration | create-inactive → activate → deactivate → replace, unauthorized and cross-company refused, ambiguity reported at creation **and** re-validated at activation, capability assignment audited with a closed list, setup status honest before and after, list and count agreeing | **5 of 5 fail at 0079** — genuine schema-level discrimination |
| §6 canonical adapter | round-trip with sender, account, message id and trace identity intact, the pre-§6 flat payload still readable, malformed payloads null, source selects the adapter and no unregistered source resolves to WhatsApp (`constructor`/`__proto__` included), unsupported channels still `absent` in the register | CODE-level, as §3 |

**Honest limit:** §3 and §6 are implemented in application code, so a migration-level rollback cannot
express "the tree before them". Their discrimination rests on the in-session reproductions recorded
in the loop-1 and loop-2 commits, not on a re-runnable schema head. §5 discriminates properly.

## 14. The three upgrade paths

| Path | Result |
|---|---|
| **1. Fresh `0001 → 0083`** | applied clean; integration **586 passed / 65 files** |
| **2. Realistic legacy → `0083`** | hosted-style baseline `0001–0041` (the documented hosted state), seeded with 2 companies, 3 people, 3 memberships, an approval policy, 4 source events **including the `in_`/`evt_` duplicate pair and a receipt with no provider message id**, 2 financial events, 2 approval requests, 3 tasks, 2 quotations, 2 outbox rows and audit history — then `0042 → 0083` in order. Applied clean; integration **586 passed / 65 files** |
| **3. Narrow `0082 → 0083`** | applied clean; integration **586 passed / 65 files** |

**Invariants after the legacy upgrade:** nothing lost — 4 source events still 4, of which **1 was
superseded** by 0076's reconciliation of the `in_`/`evt_` pair and 2 carry a canonical identity; both
approval requests were backfilled with submitter provenance by 0081; 0 service-only functions are
reachable by `anon` or `authenticated`.

**No operational precondition or hosted privilege script was required on this path.** That is
expected rather than a gap: the disposable baseline is built by the repository's own migrations, so
it does not carry the hosted drift that `HOSTED_SECDEF_PRIVILEGE_HOTFIX.md` exists to correct. The
hotfix remains an owner action against the hosted database and was **not** executed anywhere.

## 15. MATERIAL BLOCKER — OF-016

**A suspected duplicate has no authorized resolution path.** The `duplicate_reviews` row is durable,
correctly evidenced and readable by an authorized member — but there is no resolution RPC, no screen
and no write grant, and the paused payment appears on **no screen**, because the only page rendering
financial events reads exclusively from `approval_requests`. A real payment can pause in
`awaiting_information` with nothing in the product able to move it again.

Proven in `tests/integration/duplicate-review-and-approval-visibility.test.ts`: no
`%duplicate%resolve%` function exists; an authorized member's UPDATE is refused `42501`; a paused
event exists with no approval request; the review is open and is not counted as finished.

**Not a regression** — before 0083 the same event went to the *terminal* `duplicate` state, equally
invisible and additionally irreversible. 0083 made it reversible; it did not build the workflow.

**Recorded, not repaired.** Both correction loops are spent, and the directive is explicit that a
defect found during evidence closure goes to the next bounded package.

## 16. Package disposition

**FROZEN AND UNACCEPTED.**

* Correction loops: **2 of 2 used**.
* Requirements: **90 registered, 13 verified** (unchanged from the pre-R1 decision), 72
  incomplete-implementable, 4 blocked-owner, 1 deferred.
* **AIM-003** stays `implementation_in_progress` — taken off `locally_verified` before any R1 code
  and not restored on this package's own say-so.
* **FOUND-003** stays `blocked_owner`, now for two reasons: no live finance classifier (OF-003) and
  the OF-016 blocker.
* **FOUND-006** stays unaccepted — OF-014's residual is its boundary.
* **MOD-003** registered as `specified` from the C1 audit: a provider-neutral transport interface
  and one static route table exist; `src/ai/model-routes.ts` has **no production caller**; fallback,
  provider health, circuit breaking, budgets, privacy policy, ensembles and adjudication are absent.

### Live model / provider status

No live provider was called. The model transport is a deterministic fixture; production's
`classifyFinanceIntent` still returns `null`. **MOD-001 stays `blocked_owner`** pending a credential
supplied privately.

### Owner configuration still required

Mapping each receiving WhatsApp number to its company; granting `operations.inbound.review`; hosted
scheduling for `/api/cron/dispatch-drain`; hosted migration application (`0042–0083`); GitHub Actions
runner provisioning; email/voice/calendar provider selection.

## 17. Next package order

1. **FOUND-006** — eliminate request-metadata/GUC text as an authorization signal wherever it can
   affect database privileges; exact grants, split entrypoints, provable invocation identity. This
   subsumes OF-014's residual.
2. **OF-016** — the duplicate-review resolution RPC, screen and paused-payment visibility.
3. **MOD-003** — the provider-neutral Model Gateway and Policy Router.
4. Continue through the requirement register in dependency order.
