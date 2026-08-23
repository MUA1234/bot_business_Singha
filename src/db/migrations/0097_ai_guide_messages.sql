-- 0097_ai_guide_messages.sql
-- AIM-007 — AI Guide next actions.
-- Persistent, per-task guidance with next actions and coaching.
-- Forward-only and idempotent.

create table if not exists ai_guide_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  kind text not null check (kind in ('next_action','clarification','blocker_help','encouragement','escalation','answer')),
  body text not null,
  visibility text not null check (visibility in ('task_team','seniors','private')),
  audience_roles text[] not null default '{}',
  audience_refs uuid[] not null default '{}',
  proposed_next_action jsonb,
  evidence_refs text[] not null default '{}',
  confidence numeric(3,2) not null check (confidence >= 0 and confidence <= 1),
  prompt_version text not null,
  schema_version text not null default '1.0',
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_guide_messages_company_task_idx on ai_guide_messages (company_id, task_id);
create index if not exists ai_guide_messages_task_created_idx on ai_guide_messages (task_id, created_at desc);
create index if not exists ai_guide_messages_company_created_idx on ai_guide_messages (company_id, created_at desc);

-- Capability for AI Guide management (additive; idempotent).
insert into permissions (key, label) values ('ai.guide.manage','AI: manage task guide') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('owner_management','ai.guide.manage'),
  ('system_administrator','ai.guide.manage')
on conflict do nothing;

-- RLS: company isolation for reads; visibility-aware so private coaching stays private.
alter table ai_guide_messages enable row level security;

do $$
begin
  drop policy if exists ai_guide_messages_read on ai_guide_messages;
  create policy ai_guide_messages_read on ai_guide_messages for select using (
    public.has_company_access(company_id)
    and (
      visibility = 'task_team'
      or (
        visibility = 'seniors'
        and (
          public.has_capability(company_id, 'ai.guide.manage')
          or auth.uid() = any(audience_refs)
        )
      )
      or (
        visibility = 'private'
        and auth.uid() = any(audience_refs)
      )
    )
  );

  drop policy if exists ai_guide_messages_cap_ins on ai_guide_messages;
  drop policy if exists ai_guide_messages_cap_upd on ai_guide_messages;
  drop policy if exists ai_guide_messages_cap_del on ai_guide_messages;
  create policy ai_guide_messages_cap_ins on ai_guide_messages for insert with check (public.has_capability(company_id, 'ai.guide.manage'));
  create policy ai_guide_messages_cap_upd on ai_guide_messages for update using (public.has_capability(company_id, 'ai.guide.manage')) with check (public.has_capability(company_id, 'ai.guide.manage'));
  create policy ai_guide_messages_cap_del on ai_guide_messages for delete using (public.has_capability(company_id, 'ai.guide.manage'));
end $$;

-- Updated-at maintenance (canonical helper from 0093).
drop trigger if exists ai_guide_messages_updated_at on ai_guide_messages;
create trigger ai_guide_messages_updated_at
  before update on ai_guide_messages
  for each row
  execute function public.set_updated_at();
