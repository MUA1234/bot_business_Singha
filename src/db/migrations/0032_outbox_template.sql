-- 0032_outbox_template.sql
-- WP4.7 — the outbox can carry an APPROVED template (name + ordered params + language)
-- so staff notifications deliver outside Meta's 24-hour window. When template_name is
-- null the drain sends the plain `body` (valid only inside an open session).
-- ADDITIVE, FORWARD-ONLY, IDEMPOTENT.
alter table message_outbox add column if not exists template_name text;
alter table message_outbox add column if not exists template_params jsonb;
alter table message_outbox add column if not exists template_lang text not null default 'en';
