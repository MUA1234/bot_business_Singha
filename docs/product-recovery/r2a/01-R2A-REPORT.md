# R2A completion report — twelve managed domains

**Local-only. Supabase access deferred, not waived; hosted migration state remains unknown.**
No merge, no deploy, no numbered migration created or renumbered, no hosted service contacted.
**No claim of staging or production readiness is made anywhere in this report.**

## Domains fully connected — 8 of 12

Each has a registered observation source wrapping a real, pre-existing, tested detector, and
covers the conditions its data can actually support.

| # | Domain | Source | Detector wrapped | Added |
|---|---|---|---|---|
| 1 | Finance | `finance.receivable_overdue` | `aging.ts` `bucketFor` | R1 |
| 2 | Workforce | `workforce.capacity_exception` | `exceptions.ts` `detectCapacityExceptions` | R1 |
| 3 | Operations | `operations.task_exception` | `exceptions.ts` `detectTaskExceptions` | R1 |
| 4 | CRM | `crm.followup_due` | wait-window evaluation (draft-only) | R1 |
| 5 | System health | `system.health_degraded` | `health-signals.ts` | R1 |
| 6 | **Governance** | `governance.directive_overdue` | `directive-escalation.ts` `evaluateDirectiveEscalation` | **R2A** |
| 7 | **Objectives / KPIs** | `objectives.objective_at_risk` | `objective-status.ts` `assessObjective` | **R2A** |
| 8 | **Legal / compliance** | `legal.obligation_expiring` | `renewals.ts` `detectRenewals` | **R2A** |

Legal covers four record types — licences, contracts, insurances and statutory obligations —
through one detector, and is the only domain at `specialist_approval`: an expired licence is a
legal exposure, and RSK-006 records that advisory sources and human legal review are absent, so
the kernel raises the fact that a date has passed and never interprets it.

## Domains partially connected — 4 of 12

Connected and working, but their data cannot support every condition the domain implies. The
gap is named, not approximated.

| # | Domain | Source | Covered | **Genuinely unavailable** |
|---|---|---|---|---|
| 9 | **Marketing** | `marketing.campaign_stalled` | campaign stalled: non-terminal, no audience or nothing sent | **attribution** — no campaign→revenue link exists, so no ROI or effectiveness condition |
| 10 | **Procurement** | `procurement.stock_below_reorder` | stock at or below reorder level | **three-way-match variance** — needs an invoice↔receipt↔PO join that exists at page level, not as a pure module function |
| 11 | **Assets / fleet** | `assets.document_expiring` | vehicle document expiry | **AST-001** registry: custody, reservations, utilisation — `specified`, not built |
| 12 | **Providers** | `providers.provider_at_risk` | compliance and insurance health | **CRM-004** counterparty performance history — `absent`, so no reliability or delivery condition |

**No table, column or migration was invented to close these.** Each is recorded in the coverage
matrix and stays visible in the register as a residual.

## Domains blocked — none

Every one of the twelve had a real table and a real detector. Nothing needed a typed
blocked-state boundary, and nothing speculative was created.

## Exact SHAs

| | |
|---|---|
| Branch | `claude/product-recovery-r1` |
| Tested SHA (code) | **`5a59adb`** |
| Prior checkpoint | `183d477` |

## Test totals

| Suite | Result |
|---|---|
| Full repository unit suite | **1681 passed / 0 failed / 2 skipped (194 files)** |
| Kernel suite | **241 passed** |
| R2A adapters (new) | **31 passed** |
| Live full-schema (security · adapters · campaign · runtime · atomic) | **116 passed** |
| Live standalone draft apply + rollback | **31 passed** |
| Draft-migration quarantine | **28 passed** |
| Kernel under the **outbound network guard** | **241 passed — no external call** |
| verify · typecheck · lint · build · browser-check | exit 0 · clean · 0 errors · clean · passed |
| secret-scan · migration-lint · autonomy audit · IP boundary | all pass |

Unit tests rose 1650 → 1681; the live full-schema suite 115 → 116.

## What was proven

- **All twelve register**: the `Department` union, the registry and the database CHECK
  constraints agree at twelve, and every domain has a source with a cadence and a trigger mode.
- **Live acceptance of all twelve**: the atomic RPC accepts each domain with its own registered
  source and refuses an unmanaged one (`facilities`) and a null one.
- **Two-company isolation**: identical conditions in two companies yield distinct identity keys;
  an observation scanned for A is refused under B's context; a forged company id is rejected.
- **Owner, manager and staff visibility**: unchanged — the existing RLS matrix governs the new
  departments without modification, and the live role tests still pass.
- **Duplicates and stale records**: identity keys stable across re-scans, changing with the
  occurrence window; resolved records in every new domain produce nothing.
- **Unavailable evidence**: an objective with no usable target is not judged at all rather than
  declared off-track; an inventory item with no reorder level is skipped rather than assumed healthy.
- **Detector failure and recovery**: unchanged — a failing adapter marks its department
  unobserved and the cycle `partial`, never a silent success.
- **Permission loss**: unchanged, still refused mid-review.
- **No external network activity**: 241 kernel tests pass under the outbound guard.
- **No controlled business action**: all nineteen catalogue entries are internal-only and
  reversible; none of the seven new actions is `automatic`-safe, so none can run unattended; no
  action id matches send/pay/post/settle/transfer/launch/engage/renew.
- **R1 behaviour unchanged**: the five original sources keep their identifiers and output shape,
  pinned by regression tests.

## Defects found and fixed

**A real bug in my own legal adapter.** Row ids are unique per table, not across tables, so a
licence and a contract can legitimately share one. The adapter keyed both the detector input and
its lookup map on the bare id, and the second record **silently overwrote the first** — one
observation lost. Both are now keyed on a composite `kind:id`. Found by a test that deliberately
gave two records the same id.

**One stale test example.** `r1-atomic-create` used `"legal"` as its example of an *unmanaged*
department; R2A made it managed, so the constraint still worked but the example had become valid.
It now uses `facilities`, and a new test asserts all twelve are accepted.

**One over-broad assertion of mine.** A governance test rejected the word "response" anywhere in
the payload, but `escalation_reason` is a detector-generated sentence ("Response required by …
missed"), not the directive body. It now asserts the exact fact keys and that the actual payload
fields are absent.

## Requirement status

| ID | From | To | Why |
|---|---|---|---|
| **KRN-002** | `implementation_in_progress` | **`locally_verified`** | The requirement is observation sources across *every* managed domain. All twelve now have one, wrapping real tested logic, with a runtime entrypoint that exercises them. |

**62 → 63 `locally_verified`. Staging and production remain ZERO.** No other status changed.

## Remaining original-vision work

| Area | Requirement | State |
|---|---|---|
| **Learning** | AIM-008, IMP-001/002/003 | feedback captured; **nothing reads it** |
| Work marketplace and points | WMP-001/002/003 | not started — guardrails must precede the points model |
| Assignment recommendation | WRK-005, WRK-007 | proposal logic exists; no capability loader |
| Ask-AI | AIM-009 | absent |
| Multilingual | LNG-001, LNG-002 | absent |
| People analytics | WRK-003, WRK-004, WRK-006 | absent |
| Customer-facing agents | CSA-001/002 | legal/privacy gated |
| GPS / CCTV / attendance devices | GTD-001/002/003 | future-gated |
| Email, Sheets, calendar, voice, documents | COM-002/003/004/005/006 | absent |
| Asset registry beyond fleet documents | AST-001 | `specified` |
| Counterparty performance | CRM-004 | `absent` |
| Marketing attribution | (no requirement yet) | **new gap surfaced by R2A** |
| Executor for approved actions | — | none; `may_run_unattended` is computed but inert |

## Supabase and deployment blockers — unchanged

| ID | Blocker |
|---|---|
| **PR-F-004** | Hosted migration state unknown. **Priority 2 of the owner-gate checklist is the only gate still answerable by reading a dashboard.** |
| **PR-F-001** | Two different migrations numbered `0069`; the runner would silently skip one |
| **PR-F-014 / R0-F-007** | The active Railway deployment has **no commit identity** — `railway up` from the CLI, no SHA, no GitHub source |
| **R0-F-001** | Vercel origin `402 DEPLOYMENT_DISABLED`; inbound WhatsApp **unverified**, deferred by owner decision |
| **PR-F-002 / PR-F-003** | The branch lacks main's production fixes; incompatible inbound-company models |
| **R1-D-1** | R1/R2A draft units cannot take migration numbers until PR-F-001 and PR-F-004 close |

**Nothing in R2A is applied to any hosted database.** The thirteen draft units remain
quarantined, apply only to a disposable local PostgreSQL, and are proven to be invisible to the
production migration runner.

## Honest limits

- **This is local-only.** No staging, no production, no readiness claim.
- **The kernel still observes; it does not act.** No executor exists.
- **Learning is still not implemented** — R2A widened the eyes, not the memory.
- **Four of the twelve domains are partial** for real data reasons named above.
- **No scheduler is registered.** The runtime entrypoint is the authorised manual route; the
  worker boundary remains defined and hard-coded disabled.
