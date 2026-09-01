# R1 completion report

**Branch `claude/product-recovery-r1`. Local-only throughout. Not merged to main.**

No hosted environment was contacted; no migration was applied to any hosted database; no
released migration was renumbered; no secret was read or printed; no message was sent; no
payment or posting was made; no deployment occurred; R2 was not started; the points
marketplace was not implemented.

## 1. Checkpoint SHAs

| Checkpoint | SHA | Summary |
|---|---|---|
| 3 (approved) | `b01da86` | Five departmental observation adapters |
| Batch 1 | `50cbc5c` | **R1-F-001** — escalation fallback must never notify an unsuitable person |
| 4 | `0db4442` | Authority-aware recommendation and approval flow |
| 5 | `f8c3fa2` | Management queue in the existing spatial workspace |
| 6 | `6b01602` | Vertical-slice campaign + **R1-F-002** RPC-only lifecycle boundary |

The checkpoint-3 register originally cited `5962a14`, which the checkpoint-3 amend rewrote
out of history — the same dangling-SHA class as R0-F-005, this time caused by my own amend.
It now cites `b01da86`, whose `src/`, `tests/` and `scripts/` trees are byte-identical to the
tested tree (verified by diff). **Correcting this was itself a finding**: an amend after a
register update silently invalidates the evidence it records.

## 2. Files changed, by checkpoint

**Batch 1 (R1-F-001)** — `src/app/api/cron/follow-ups/route.ts` (the fix),
`tests/campaign/sch-003-escalation-fallback-behaviour.test.ts` (12 behavioural assertions
replacing the `it.fails` placeholder), `tests/campaign/sch-003-leave-workload-aware-scheduling.test.ts`
(the CRLF assertion removed, with the reason recorded).

**Checkpoint 4** — `src/kernel/catalogue.ts`, `src/kernel/recommend.ts`,
`src/db/draft-migrations-r1/R1_DRAFT_009_review_flow.{up,down}.sql`,
`tests/kernel/recommend.test.ts`.

**Checkpoint 5** — `src/components/spatial/panels/ManagementQueuePanel.tsx` and
`ManagementQueuePanelContent.tsx`, `src/components/spatial/windows/ManagementQueueWindow.tsx`,
`src/components/spatial/windowSpecs.ts` (+1 entry), `WindowRegistry.tsx` (+1 entry),
`styles.css` (queue block), `src/app/app/spatial/SpatialWorkspaceShell.tsx` (+1 window),
`src/app/app/command/queue/page.tsx`, `tests/spatial/management-queue.test.tsx`.

**Checkpoint 6** — `src/db/draft-migrations-r1/R1_DRAFT_010_transition_boundary.{up,down}.sql`,
`tests/integration/r1-vertical-slice-campaign.test.ts`,
`tests/integration/r1-security-baseline.test.ts` (R1-F-002 regressions),
`scripts/r1/run-r1-security-tests.mjs`.

## 3. Requirements covered

| ID | Status | Evidence |
|---|---|---|
| **KRN-001** kernel and lifecycle | `implementation_in_progress` | 16-state machine enforced in pure code **and** at the database boundary; RPC-only since 010 |
| **KRN-002** observation sources | `implementation_in_progress` | five adapters, one contract, registry with per-company cadence |
| **KRN-003** action catalogue | `implementation_in_progress` | eight registered internal-only reversible actions; selection enforced |
| FOUND-004 / FOUND-005 | unchanged | authority engine and trust boundary consumed, not replaced |
| AIM-002 dedup · GOV-006 audit | unchanged | identity keys and append-only history |
| IMP-001 | capture only | feedback recorded; **learning is NOT implemented** |

**The verified count is unchanged at 60. Nothing became `locally_verified`, and staging and
production remain zero.** That status requires a runtime entrypoint, and **nothing in the
running application invokes the kernel** — no scheduler, route or job calls a scan, and no
loader reads the rows the adapters consume. Claiming otherwise is the exact failure the
register exists to prevent.

## 4. Scenario matrix

| Scenario | Result |
|---|---|
| Complete cycle × 5 departments (observe → verify → feedback) | ✅ all five reach `verified`/`resolved` |
| Audit reconstruction, observation → outcome | ✅ exact 10-step chain, every step attributable |
| Two isolated companies | ✅ no mixing; zero cross-company evidence rows |
| Owner / manager / ordinary staff / unauthorised / non-member / anon | ✅ each gets only its intended access |
| Revoked membership (suspended and ended) | ✅ access lost immediately; assigned work re-routed truthfully |
| Approved leave · no suitable assignee | ✅ excluded; routed with a reason naming no administrator |
| Duplicate · out-of-order · stale · resolved observations | ✅ reuse / refuse-backwards / skip / produce nothing |
| Contradictory and missing evidence | ✅ reported truthfully; fail closed |
| Detector failure and retry | ✅ department reported UNOBSERVED; no duplicate on recovery |
| Malformed / timeout / low-confidence fixtures | ✅ whole interpretation discarded; loop continues deterministically |
| Concurrent approvals | ✅ one wins, loser gets `conflict`, writes nothing |
| Duplicate submission (refresh mid-submit) | ✅ one decision only |
| Self-approval after editing | ✅ refused at the database boundary |
| Transaction rollback | ✅ no partial item, evidence or transition |
| History deletion | ✅ refused — `ON DELETE RESTRICT` |
| Permission lost mid-review | ✅ decision refused |
| 20+ management items | ✅ no loss |
| Replay an entire sweep | ✅ no duplicate business effect |
| Illegal transitions | ✅ refused in both layers |
| Viewports 390 / 768 / 1440 / touch, keyboard-only, reduced motion, flat 2D | ✅ asserted in markup and CSS |
| No sensitive data in browser storage | ✅ layout snapshot and panel both asserted clean |
| No external provider or network call | ✅ no credentials present; nothing hosted contacted |

## 5. Defects found and fixed

**R1-F-001 (authorised correction).** The escalation fallback notified **every**
administrator including those on **approved leave**, and did so even when nobody was
available. Root cause: `rankAvailableCandidates` only *sorts*; the loop never checked
`avail.available`, while its sibling reminder path did. Fixed with the existing
`selectBestAvailable`, which also batches the notification to one recipient. With nobody
suitable it now notifies nobody, leaves `escalated_to` NULL and records
`no_available_authorised_target`.

**R1-F-002 (found by adversarial self-review, reproduced before fixing).** A manager holding
`operations.task.manage` could run `update management_items set state='verified'` and drive
an item from `observed` to `verified` directly — skipping the legality map, the reason
requirement, the assignability assertion, and **writing zero transition rows**. The audit
trail simply gained a hole. Confirmed live before any code changed. The evidence trigger did
not catch it (evidence existed) and the owner constraint caught it only by accident when no
owner was set. Draft unit **010** makes the lifecycle RPC-only via a transaction-local token
minted and **burned** inside `r1_draft_transition_item`, mirroring what migration 0064
already does for quotation delivery. Six regression tests, including that a second direct
update in the *same transaction* is still refused.

**Three defects fixed during checkpoint 4/5 work:** the child tables were attached with
`ON DELETE CASCADE`, so deleting one item would have erased its evidence, transitions,
decisions and feedback — all four are now `ON DELETE RESTRICT`; a stale `last_verified_sha`;
and an unknown eslint directive.

Earlier in the branch: the `to_regproc` signature bug that left **RLS entirely disabled**, a
`language sql` body that could not be created standalone, a non-short-circuiting rollback
guard, and a near-miss `LedgerIntegrityCounts` shape that would have reported the ledger
permanently healthy.

## 6. Test totals

| Suite | Result |
|---|---|
| Full repository unit suite | **1621 passed / 0 failed / 2 skipped (192 files)** |
| R1 live, full schema (security + adapters + campaign) | **64 passed** |
| R1 live, standalone draft schema + rollback | **31 passed** |
| Draft-migration quarantine | **28 passed** |
| `npm run verify` | exit 0 |
| `typecheck` · `lint` · `build` · `browser-check` | clean · 0 errors · clean · passed |
| `secret-scan` · `migration-lint` · `autonomy:audit` · `ip-boundary` | all pass |

## 7. Artifacts

No large binaries were committed. Reproduce any run locally:

```bash
node scripts/r1/run-r1-security-tests.mjs    # full schema: security + adapters + campaign
node scripts/r1/run-draft-schema-tests.mjs   # standalone draft apply + rollback
npx vitest run tests/kernel tests/r1 tests/spatial
npm run verify && npm run build && npm run browser-check
```

Each script creates a disposable PostgreSQL 16 bound to **loopback only** and destroys it
afterwards, pass or fail. `npm run browser-check` prints its own note that signed-in screens
are not exercised because no Supabase instance exists in this container.

## 8. Unresolved risks

1. **The kernel has no runtime entrypoint.** Everything is proven by tests; nothing runs in
   the application. This is the single largest gap and the reason no requirement advanced to
   `locally_verified`.
2. **`may_run_unattended` is computed but inert** — no executor exists. The guard is in place
   before the capability it guards, which is the right order, but it is untested in anger.
3. **Capabilities passed to `selectAssignee` are supplied by the caller**, and no loader
   populates them from the database yet. The capability check is only as strong as that
   future loader.
4. **The draft RLS matrix is not the full production matrix.** Reads are company-scoped;
   writes are capability-gated; but the reconciled numbered migration must still add the
   composite `(company_id, id)` FK pattern used elsewhere and re-audit `search_path` under
   the 0067 rules.
5. **Learning is not implemented.** Feedback rows are captured; nothing reads them.
   AIM-008/IMP-002/IMP-003 remain `absent`.
6. **Five of twelve domains** are observed. Seven target management domains have no adapter.

## 9. Hosted and deployment blockers

Unchanged and still blocking, all from the audit:

| ID | Blocker |
|---|---|
| **PR-F-001** | Two different migrations numbered `0069`; the runner keys on the 4-char prefix and would **silently skip** one |
| **PR-F-004** | Real hosted migration state unknown; the authoritative record contradicts deployed code |
| **PR-F-002 / PR-F-003** | The branch line lacks main's production fixes and carries an incompatible inbound-company model |
| **R0-F-001** | The Vercel origin returns `402 DEPLOYMENT_DISABLED`; if Meta still points there, inbound messaging is down |
| **PR-F-014** | Exact deployed Railway SHA unconfirmed (bounded to ≥ `19a8e9d`) |
| **R1-D-1** | R1 migrations cannot take numbers until PR-F-001 and PR-F-004 are resolved |

**No R1 work can reach a hosted database until PR-F-001 and PR-F-004 are closed.**

## 10. Recommendation for the next phase

**Do not start R2 (line reconciliation) yet, and do not build more domains.** Two things
should come first, in this order:

1. **Give the kernel a runtime entrypoint** — a scheduled scan invoking the registered
   sources with a real loader, behind a default-off flag. Until that exists, R1 is a proven
   library rather than a working capability, and no requirement can honestly advance.
2. **Close R0's truth gaps** (PR-F-004, PR-F-014, R0-F-001). They are owner actions taking
   minutes and they gate everything downstream, including whether R1 can ever be applied.

Then R2 line reconciliation, then the remaining domains — each reusing the kernel without
changing it, which remains the test of whether this architecture was actually achieved.

**Two items need an owner decision:** whether the CRM draft-only action stays in scope
before customer-facing work is authorised, and whether R1-F-001's fix should be back-ported
to `main`, where the defect also lives.
