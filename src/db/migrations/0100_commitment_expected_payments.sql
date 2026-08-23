-- 0100_commitment_expected_payments.sql
-- FIN-004 — Commitments and expected payments.
-- Adds expected_payment_date to purchase_orders so that POs and commitments can feed
-- the rolling cash forecast alongside invoices/bills. Forward-only and idempotent.

-- 1. PO expected payment date (nullable, no default).
alter table purchase_orders add column if not exists expected_payment_date date;

-- 2. Index to support the company-scoped forecast sweep over open, dated POs.
create index if not exists purchase_orders_company_status_expected_payment_idx
  on purchase_orders (company_id, status, expected_payment_date);

-- 3. Existing commitments table already has expected_settlement_date; no schema change needed.
