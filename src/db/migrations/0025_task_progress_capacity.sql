-- 0025_task_progress_capacity.sql
-- WP3 (NEXT_PHASE_DEVELOPER_BRIEF) — staff task progress + capacity fields.
-- ADDITIVE, FORWARD-ONLY, IDEMPOTENT. No drops; safe to re-run. The app degrades
-- gracefully before this is applied (actions treat a missing column as a no-op).

-- Task progress fields (worker-reported).
alter table tasks add column if not exists actual_hours numeric(8,2);
alter table tasks add column if not exists remaining_hours numeric(8,2);
alter table tasks add column if not exists blocker_reason text;
alter table tasks add column if not exists expected_completion date;
alter table tasks add column if not exists declined_reason text;

-- Assignment: the worker's own estimate + accept/decline lifecycle timestamps.
alter table task_assignments add column if not exists worker_estimate_hours numeric(8,2);
alter table task_assignments add column if not exists estimate_submitted_at timestamptz;
alter table task_assignments add column if not exists accepted_at timestamptz;
alter table task_assignments add column if not exists declined_at timestamptz;

-- Capacity inputs on the person (employee_profiles from 0010).
alter table employee_profiles add column if not exists contracted_weekly_hours numeric(6,2);
alter table employee_profiles add column if not exists reserved_weekly_hours numeric(6,2);
alter table employee_profiles add column if not exists work_days smallint[]; -- 1=Mon..7=Sun
