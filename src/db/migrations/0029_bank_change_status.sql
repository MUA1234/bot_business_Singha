-- 0029_bank_change_status.sql
-- WP2.5 (NEXT_PHASE_DEVELOPER_BRIEF) — maker/checker control for a supplier bank-detail
-- change (a sensitive action). Adds the status + name/snapshot columns the approval
-- flow needs. ADDITIVE, FORWARD-ONLY, IDEMPOTENT.

alter table supplier_bank_detail_changes add column if not exists status text not null default 'pending';
alter table supplier_bank_detail_changes add column if not exists old_account_name text;
alter table supplier_bank_detail_changes add column if not exists new_account_name text;
alter table supplier_bank_detail_changes add column if not exists decided_at timestamptz;
alter table supplier_bank_detail_changes add column if not exists note text;
