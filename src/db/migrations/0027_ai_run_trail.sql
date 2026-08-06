-- 0027_ai_run_trail.sql
-- WP5.3 (NEXT_PHASE_DEVELOPER_BRIEF) — complete the AI run observability trail so
-- every recorded run carries latency and its originating source event alongside the
-- existing model/prompt/tokens/cost/validation/confidence/correlation/company columns.
-- ADDITIVE, FORWARD-ONLY, IDEMPOTENT.

alter table ai_runs add column if not exists latency_ms integer;
alter table ai_runs add column if not exists source_event_id text;
