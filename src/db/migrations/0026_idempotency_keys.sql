-- 0026_idempotency_keys.sql
-- WP2 §2 (NEXT_PHASE_DEVELOPER_BRIEF) — caller-provided idempotency keys so a retried
-- financial operation (settlement, reimbursement) cannot create a duplicate record.
-- ADDITIVE, FORWARD-ONLY, IDEMPOTENT. The app claims a key BEFORE the operation; the
-- PRIMARY KEY makes a duplicate claim fail (23505), which the app treats as "already
-- done". Full mutation+key atomicity in one transaction is the later DB-function slice;
-- this is the caller-side guard.

create table if not exists idempotency_keys (
  company_id uuid not null references companies(id) on delete cascade,
  scope text not null,          -- e.g. 'settle_customer_invoice'
  key text not null,            -- caller-derived / client-supplied idempotency key
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (company_id, scope, key)
);

alter table idempotency_keys enable row level security;
drop policy if exists idem_read on idempotency_keys;
create policy idem_read on idempotency_keys for select using (has_company_access(company_id));
