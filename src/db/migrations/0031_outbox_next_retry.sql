-- 0031_outbox_next_retry.sql
-- WP4.4 — the sender worker needs to persist a message's next retry time so the drain
-- only re-attempts failed rows once their backoff has elapsed. ADDITIVE, FORWARD-ONLY,
-- IDEMPOTENT.
alter table message_outbox add column if not exists next_retry_at timestamptz;
