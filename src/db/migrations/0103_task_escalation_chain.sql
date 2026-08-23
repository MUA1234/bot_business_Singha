-- 0103_task_escalation_chain.sql
-- SCH-004 — Escalation and missed-response recovery.
-- Extends tasks with an ordered escalation chain and tracks the current escalation
-- level, so an unanswered follow-up advances to a defined next person rather than
-- a generic admin broadcast. A cron route evaluates outstanding tasks, walks the
-- chain, and writes audit events. Forward-only and idempotent.

-- 1. Escalation chain columns.
alter table tasks add column if not exists escalation_chain jsonb default '[]';
alter table tasks add column if not exists escalated_to uuid references profiles(id) on delete set null;
alter table tasks add column if not exists escalation_level int not null default 0;
alter table tasks add column if not exists escalated_at timestamptz;
alter table tasks add column if not exists escalation_reason text;
alter table tasks add column if not exists last_reminder_at timestamptz;

-- Ensure defaults are pinned for newly added rows (idempotent).
alter table tasks alter column escalation_level set default 0;

-- 2. Index to support the cron sweep over active, escalated or overdue tasks.
create index if not exists tasks_status_reminder_idx
  on tasks (status, last_reminder_at);

-- 3. RLS refresh: escalated_to must also see/update the task they now own.
do $$
begin
  drop policy if exists tasks_read on tasks;
  create policy tasks_read on tasks for select using (
    has_company_access(company_id) or escalated_to = auth.uid()
  );

  drop policy if exists tasks_write_upd on tasks;
  create policy tasks_write_upd on tasks for update using (
    has_capability(company_id,'approve')                 -- manager/admin in company
    or exists (                                            -- or the assignee, own task
      select 1 from memberships m
      where m.user_id = auth.uid()
        and m.company_id = tasks.company_id
        and m.status = 'active'
        and (m.user_id = tasks.assigned_to
             or exists (select 1 from task_assignments ta
                        where ta.task_id = tasks.id and ta.membership_id = m.id))
    )
    or escalated_to = auth.uid()                           -- or the current escalated owner
  ) with check (has_company_access(company_id));
end $$;
