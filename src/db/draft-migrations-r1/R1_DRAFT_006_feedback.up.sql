-- R1 DRAFT - NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_006 - feedback capture for later learning (IMP-001).
--
-- R1 CAPTURES learning signal. It does NOT apply it. Applying learning (IMP-002, IMP-003)
-- is out of R1 scope and requires owner approval, versioned playbooks and a human in the
-- loop. This table exists so the signal is not lost in the meantime.
--
-- The highest-value signals, in order:
--   1. why a human rejected or dismissed a recommendation;
--   2. why a human overrode the recommended resource;
--   3. whether re-observation actually confirmed the condition was resolved;
--   4. how often a detector's items are dismissed as noise (detector precision).

create table if not exists management_item_feedback (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  item_id       uuid not null references management_items(id) on delete cascade,

  feedback_type text not null check (feedback_type in (
    'decision_reason',        -- why approved / rejected / edited / delegated
    'assignment_override',    -- recommended X, human chose Y
    'verification_result',    -- did re-observation confirm resolution
    'detector_precision'      -- was this item real or noise
  )),

  -- What the kernel proposed, and what actually happened. Both are needed: a learning
  -- signal is the DIFFERENCE, not the outcome alone.
  proposed      jsonb,
  actual        jsonb,

  reason        text,

  actor_id      uuid,
  actor_type    text not null default 'user' check (actor_type in ('user', 'system', 'ai')),
  created_at    timestamptz not null default now()
);

create index if not exists management_item_feedback_item_idx
  on management_item_feedback (item_id, created_at);
create index if not exists management_item_feedback_type_idx
  on management_item_feedback (company_id, feedback_type, created_at);

-- Append-only. Feedback that can be edited is not evidence of what happened.
create or replace function r1_draft_feedback_append_only() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  raise exception 'management_item_feedback is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists management_item_feedback_no_update on management_item_feedback;
create trigger management_item_feedback_no_update
  before update or delete on management_item_feedback
  for each row execute function r1_draft_feedback_append_only();

do $$
begin
  if to_regproc('public.has_company_access(uuid)') is not null then
    execute 'alter table management_item_feedback enable row level security';
    begin
      execute 'create policy management_item_feedback_read on management_item_feedback
                 for select using (has_company_access(company_id))';
    exception when duplicate_object then null;
    end;
  end if;
end
$$;
