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

Run at the final SHA of this package on a disposable local PostgreSQL 16.

| Gate | Result |
|---|---|
| Fresh migration apply, `0001–0081` | applied clean |
| Staged upgrade, `0001–0080` then `0081` | applied clean |
| Integration suite on the FRESH database | 62 files / 545 tests passed |
| Integration suite on the UPGRADED database | 62 files / 545 tests passed |
| Unit suite | 103 files / 736 passed, 2 skipped |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors (3 pre-existing `next/image` warnings) |
| `npm run build` | compiled |
| `npm run secret-scan` | clean |
| `npm run migration-lint` | 81 sequential, `0001–0081`, no gaps or duplicates |
| Requirements audit | consistent; `registered=89 verified=13 incomplete-implementable=71 blocked-owner=4 deferred=1` |
| SECURITY DEFINER grant allowlist | signature-exact, every function classified |
| `search_path` safety gate | every application-owned SECURITY DEFINER and trigger function on the canonical path |
| RLS coverage / matrix / company isolation | passed |
| IP boundary check | no hard violation |
| Browser check (real Chromium, production build) | review, setup and analyze routes served and gated to `/login`; `/` and `/login` render; both cron routes return **401** to an unauthenticated caller and to a wrong secret |
| Targeted concurrency + scheduler tests | 6 files / 39 tests passed (`concurrency`, `rpc-concurrency`, `finance-concurrency`, `wp12-enqueue-item-race`, `durable-inbound-processing`, `dispatch-drain`) |
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

## 9. Independent review — IN PROGRESS

**This section is not yet filled in, and the report is not final until it is.** One independent
adversarial review of the eight commits `f940f93..31967aa` is running against the eleven areas the
owner named, with two surfaces explicitly called out as the least-reviewed:

* `tests/integration/helpers/pg-supabase.ts` — a test harness that failed to reproduce PostgREST
  semantics faithfully would make tests pass that production would fail, which is worse than no test
  at all;
* migration `0081` and OF-013 — written last, and the only change in this package that touches the
  separation-of-duties path.

The verdict, the findings, how many of this package's **two** correction loops were used, and any
finding that remains unresolved will be recorded here before the package is reported complete. A
finding is reproduced before it is accepted, and the loop budget is not exceeded: if a material
issue survives loop 2, AIM-003 stays unaccepted and the blocker stands.

## 10. Next resumable requirement

**FOUND-006** — the RLS / service-role read-and-write cutover with its architectural test (OF-012).
It is the next slice regardless of this package's verdict; flipping `RLS_READS` / `RLS_WRITES` is an
owner action, and the code path has to exist and be proven before that flip is safe to offer.
