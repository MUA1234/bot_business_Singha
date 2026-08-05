-- Singha — migration 0019: task assignment (tasks.assigned_to). Additive, idempotent.

begin;
-- 0019_task_assignment.sql
-- Architecture V2 change plan §7.3 — assign a task to an employee (profile). ADDITIVE:
-- one nullable column. Capacity is then computed from each person's assigned,
-- estimated, non-terminal tasks. Forward-only, idempotent.

alter table tasks add column if not exists assigned_to uuid references profiles(id) on delete set null;
create index if not exists tasks_assigned_idx on tasks (company_id, assigned_to);
commit;
