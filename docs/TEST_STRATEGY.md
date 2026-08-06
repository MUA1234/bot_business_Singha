# TEST_STRATEGY.md

> **⚠️ QUICKBOOKS SUPERSEDED (D-011 / NEXT_PHASE_DEVELOPER_BRIEF).** QuickBooks is
> **not used** and is **not** the accounting source of truth. The internally-owned
> double-entry Accounting Core (`src/accounting/*`) is the sole accounting source of
> truth. Ignore every QuickBooks connection / posting / draft / sync / OAuth /
> reconciliation instruction in this document; those references are historical only.
> See document precedence in `CLAUDE.md`.


**Status:** Phase 0 deliverable — for review. Master spec §25. (Also the
`TESTING_STRATEGY` the build prompt names.)

## 1. Test types (spec §25)

Unit; database; migration; integration; webhook contract; API; permission;
**company-isolation**; state-transition; idempotency; duplicate-event; capacity;
leave/holiday; time-zone; estimate/revision; blocked/waiting time; reassignment;
approval; audit; AI schema; prompt-injection; evaluation; regression; end-to-end;
backup/restore; failure-recovery.

## 2. Non-negotiable suites

- **Company-isolation tests are mandatory and must fail loudly.** For every
  read/write path (DB, service, API, Inngest job, AI-context, storage): prove company
  A cannot read or affect company B. A regression here is a build-blocking failure.
- **Idempotency / duplicate-event tests.** Replaying any event twice creates exactly
  one downstream record (task, receipt, payment, reimbursement, QuickBooks draft).
- **Authority tests.** No §2-prohibited action (AUTHORITY_MATRIX) can execute
  autonomously; thresholds enforce approval; immutable audit written on every path.
- **AI schema tests.** Invalid AI output is rejected + retried; no free text reaches
  business logic; no model IDs outside the gateway (grep test).

## 3. Tooling

- Runner: **Vitest** (fast, TS-native) — chosen over adding heavier infra. See
  DECISIONS D-004.
- DB tests against a **local/staging Supabase**, never production (spec §26).
- Isolation tests use two seeded companies + users and assert zero cross-visibility
  under RLS and via each service/API/job path.
- QuickBooks tests use the **sandbox**; financial/AI behaviour is never tested on
  production data.

## 4. Per-phase test gates

Each phase lists its gate tests in its model doc (EVENT_SCHEMA §6, TASK_STATE_MODEL §8,
WORKFORCE_CAPACITY_MODEL §6, PAYMENT_AND_RECEIPT_MODEL §10, QUICKBOOKS §8, AUTHORITY
§8, AI_ORCHESTRATION §8, PERMISSION §6). A phase is not "done" until its gate passes
plus the four non-negotiable suites still pass.

## 5. Domain-specific tests (§25)

Receipt/OCR correction; unreadable/missing/duplicate documents; totals/tax;
reimbursements/advances (no double pay); QuickBooks mapping/upload/attachments/
failure/retry/idempotency/reversal/reconciliation; payment splits & exceptions;
attendance correction/dispute. (GPS/CCTV correlation tests are deferred with the
gated feature.)

## 6. AI evaluation

Use **versioned evaluation datasets** (not only manual conversations) for any AI
behaviour that reaches users — kept for when customer-facing agents are built.

## 7. CI

Format + lint + typecheck + unit/integration + isolation + idempotency + authority +
AI-schema suites run on every push. Migration tests run when schemas change. Red CI
blocks merge.
