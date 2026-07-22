# QUICKBOOKS_INTEGRATION_MODEL.md

**Status:** Phase 0 deliverable — for review. Master spec §16. Implemented Phase 10.
**Pilot mode: DRAFT / READ-ONLY only. No automatic posting. No bank payment. Ever.**

## 1. Principles

- QuickBooks Online (QBO) is the **accounting source of truth**.
- Start in **sandbox** (staging). Production QBO is draft-only in pilot.
- The AI **recommends** account, tax code, project/customer/class/location and
  supplier match; it never posts autonomously and never executes a payment.
- Uncertain tax / missing tax invoice / capital-vs-operating ambiguity / multiple
  entities / large/foreign/mixed expenses / special tax treatment → **accountant
  review required** before any posting request.

## 2. Connection & auth

- OAuth 2.0 via the official Intuit SDK. Store per-company `quickbooks_connections`:
  `realm_id`, encrypted refresh token (secret store / env-referenced), scopes,
  status, last_sync, health.
- Redirect URI + client id/secret configured per environment (sandbox vs prod).
- Least-privilege scopes; tokens never logged or committed.

## 3. Data mapping

Map approved submissions to the **correct** transaction type (Bill, Expense/Purchase,
Vendor Credit, etc.) — **not one generic expense type**. Store in
`quickbooks_sync_records`: `company_id`, `qbo_txn_type`, `qbo_txn_id`, `sync_token`,
`upload_time`, `fields` snapshot, `attachment_ref`, `reconciliation_status`,
`retry_history`, `source_payment_request_id`.

## 4. Draft workflow (the only write path in pilot)

```mermaid
sequenceDiagram
  participant FR as Finance review (approved receipt)
  participant IN as Inngest job
  participant AU as authority engine
  participant QB as QuickBooks (sandbox/prod)
  participant DB as quickbooks_sync_records

  FR->>IN: payment ready_for_quickbooks
  IN->>AU: check authority (draft-only; accountant review flags)
  AU-->>IN: allowed to create DRAFT (never auto-post)
  IN->>QB: create DRAFT / posting request (idempotency key)
  QB-->>IN: qbo_txn_id + sync_token
  IN->>DB: upsert sync record (unique on source_payment_request_id)
  Note over IN,DB: Retry re-uses idempotency key; sync_token guards concurrent edits
```

## 5. Idempotency & duplicate-write protection

- Each draft creation carries an **idempotency key** derived from
  `source_payment_request_id` (+ attempt). A retry never creates a second QBO object.
- `quickbooks_sync_records` has a **unique constraint on `source_payment_request_id`**
  so two consumers cannot both create a draft for the same item.
- Store and respect the QBO **sync token** to avoid clobbering concurrent edits.
- A doubled QBO post is treated as a critical incident; the design makes it
  structurally impossible via the two guards above + event dedup (EVENT_SCHEMA).

## 6. Reconciliation (Inngest job)

- Pull bank-feed / transaction references (`bank_transaction_references`).
- Match to payment records; write `reconciliation_records` (matched / unmatched /
  disputed). Unmatched activity → finance dashboard exception, never auto-resolved.

## 7. Read-only intelligence

Cash, receivables, payables, budgets, payroll estimates, taxes, profitability,
forecasts, funding, savings, unusual/duplicate transactions — all **read-only** in
pilot, surfaced on the finance dashboard, linked back to evidence.

## 8. Tests (Phase 10 gate)

Mapping to correct txn type, attachment upload, upload failure + retry (idempotent —
no duplicate QBO object), reversal, reconciliation matching, sync-token conflict
handling, sandbox-only in staging, company isolation, audit on every posting request.
