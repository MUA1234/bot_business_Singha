-- R1 DRAFT - NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_004 - human decisions on a management item.
--
-- KERNEL-OWNED AND DELIBERATELY SEPARATE FROM approval_requests.
-- `approval_requests` is bound to `financial_event_id` - a finance-shaped contract with its
-- own maker/checker and SoD rules. R1 does NOT widen it (approval condition: existing
-- finance controls and API contracts unchanged). The kernel records its own decisions here,
-- and where a recommendation implies a controlled action (post, settle, pay, send) the
-- kernel never performs it - it produces a task for the existing human surface.

create table if not exists management_item_decisions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  item_id      uuid not null references management_items(id) on delete cascade,

  decision     text not null check (decision in ('approve', 'reject', 'edit', 'delegate')),

  actor_id     uuid not null,
  actor_type   text not null default 'user' check (actor_type in ('user', 'system')),

  -- The authority the decision was taken under, resolved by the existing authority engine.
  authority_level text,

  -- `edit`: what the approver changed the recommendation to. Both the original proposal and
  -- the edited variant are retained (acceptance B6) - the item keeps the original in its
  -- own columns and the edit is recorded here.
  edited_action        text,
  edited_resource_type text
    check (edited_resource_type is null
           or edited_resource_type in ('staff', 'bot', 'external')),
  edited_resource_id   text,

  -- `delegate`: who it was delegated to. Delegation is a SUBSET of the delegator's own
  -- authority, never an expansion (acceptance B5) - enforced by the existing authority
  -- engine before this row is written.
  delegated_to         uuid,

  reason       text,
  created_at   timestamptz not null default now()
);

create index if not exists management_item_decisions_item_idx
  on management_item_decisions (item_id, created_at);

-- Append-only.
create or replace function r1_draft_decisions_append_only() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  raise exception 'management_item_decisions is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists management_item_decisions_no_update on management_item_decisions;
create trigger management_item_decisions_no_update
  before update or delete on management_item_decisions
  for each row execute function r1_draft_decisions_append_only();

-- A rejection must carry a reason; the reason is the learning signal (IMP-001).
-- A delegation must name a delegate.
create or replace function r1_draft_decision_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_item_company uuid;
begin
  select company_id into v_item_company from public.management_items where id = new.item_id;
  if v_item_company is null then
    raise exception 'decision references a non-existent management item'
      using errcode = 'foreign_key_violation';
  end if;
  if v_item_company is distinct from new.company_id then
    raise exception 'cross-company decision refused: item company %, decision company %',
      v_item_company, new.company_id
      using errcode = 'insufficient_privilege';
  end if;
  if new.decision = 'reject' and (new.reason is null or btrim(new.reason) = '') then
    raise exception 'a reject decision requires a reason' using errcode = 'check_violation';
  end if;
  if new.decision = 'delegate' and new.delegated_to is null then
    raise exception 'a delegate decision requires delegated_to' using errcode = 'check_violation';
  end if;
  if new.decision = 'edit' and new.edited_action is null then
    raise exception 'an edit decision requires edited_action' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists management_item_decisions_guard on management_item_decisions;
create trigger management_item_decisions_guard
  before insert on management_item_decisions
  for each row execute function r1_draft_decision_guard();

-- ONE decision per item per approver: a second approval attempt is a conflict, not a
-- silent overwrite (acceptance D5).
create unique index if not exists management_item_decisions_one_per_actor
  on management_item_decisions (item_id, actor_id)
  where decision in ('approve', 'reject');

do $$
begin
  if to_regproc('public.has_company_access(uuid)') is not null then
    execute 'alter table management_item_decisions enable row level security';
    begin
      execute 'create policy management_item_decisions_read on management_item_decisions
                 for select using (has_company_access(company_id))';
    exception when duplicate_object then null;
    end;
  end if;
end
$$;
