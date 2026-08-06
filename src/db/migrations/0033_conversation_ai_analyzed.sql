-- 0033_conversation_ai_analyzed.sql
-- WP5.1 — track when the Senior AI Manager last analysed a conversation so the
-- continuous monitor only re-analyses threads with new inbound activity (bounds AI
-- cost). ADDITIVE, FORWARD-ONLY, IDEMPOTENT.
alter table wa_conversations add column if not exists ai_analyzed_at timestamptz;
