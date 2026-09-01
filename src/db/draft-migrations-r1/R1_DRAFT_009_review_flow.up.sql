-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_009 — reviewer decisions, postponement, evidence requests, and history that
-- cannot be destroyed (checkpoint 4).

-- ── 1. HISTORY IS NEVER CASCADE-DELETED ────────────────────────────────────────────────
-- Units 002-004/006 attached the child tables with ON DELETE CASCADE, so deleting one
-- management item would erase its evidence, its transitions, its decisions and its feedback
-- with it. The owner's instruction is explicit: management history is never cascade-deleted.
-- RESTRICT means an item carrying history CANNOT be deleted at all — which is the point.
-- Nothing in the application deletes items (there is no delete policy for `authenticated`),
-- so this closes the path a future migration or an operator could otherwise take.
do $$
declare
  t text;
  c text;
begin
  foreach t in array array['management_item_evidence', 'management_item_transitions',
                           'management_item_decisions', 'management_item_feedback'] loop
    select conname into c
      from pg_constraint
     where conrelid = to_regclass('public.' || t)
       and confrelid = to_regclass('public.management_items')
       and contype = 'f'
     limit 1;
    if c is not null then
      execute format('alter table public.%I drop constraint %I', t, c);
      execute format(
        'alter table public.%I add constraint %I foreign key (item_id)
           references public.management_items(id) on delete restrict', t, t || '_item_fk');
    end if;
  end loop;
end
$$;

-- ── 2. The full set of reviewer decisions ──────────────────────────────────────────────
alter table public.management_item_decisions
  drop constraint if exists management_item_decisions_decision_check;
alter table public.management_item_decisions
  add constraint management_item_decisions_decision_check
  check (decision in ('approve', 'reject', 'dismiss', 'edit', 'delegate',
                      'postpone', 'request_evidence', 'route'));

-- A reason is mandatory for every decision whose reason IS the learning signal (IMP-001).
-- Approval alone may stand without one; a refusal, a change or a deferral may not.
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
      v_item_company, new.company_id using errcode = 'insufficient_privilege';
  end if;

  if new.decision in ('reject', 'dismiss', 'edit', 'delegate', 'postpone', 'request_evidence', 'route')
     and (new.reason is null or btrim(new.reason) = '') then
    raise exception 'a % decision requires a reason', new.decision using errcode = 'check_violation';
  end if;
  if new.decision = 'delegate' and new.delegated_to is null then
    raise exception 'a delegate decision requires delegated_to' using errcode = 'check_violation';
  end if;
  if new.decision = 'delegate' and new.delegated_to = new.actor_id then
    raise exception 'a reviewer cannot delegate to themselves' using errcode = 'check_violation';
  end if;
  if new.decision = 'edit' and new.edited_action is null then
    raise exception 'an edit decision requires edited_action' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- SEPARATION OF DUTIES at the database boundary: whoever EDITED a recommendation may not
-- also approve it. Maker and checker must differ — the same rule the finance controls apply
-- to bank-detail changes, applied here so application code is not the only thing enforcing it.
create or replace function r1_draft_no_self_approval() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.decision = 'approve'
     and exists (select 1 from public.management_item_decisions d
                  where d.item_id = new.item_id and d.actor_id = new.actor_id and d.decision = 'edit') then
    raise exception 'a reviewer who edited this recommendation may not also approve it'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists management_item_decisions_no_self_approval on management_item_decisions;
create trigger management_item_decisions_no_self_approval
  before insert on management_item_decisions
  for each row execute function r1_draft_no_self_approval();

-- ── 3. Postponement and evidence requests ──────────────────────────────────────────────
alter table public.management_items
  add column if not exists snoozed_until timestamptz,
  add column if not exists snooze_reason text,
  add column if not exists evidence_requested_at timestamptz,
  add column if not exists evidence_request_reason text,
  add column if not exists proposed_action_id text,
  add column if not exists evidence_quality text,
  add column if not exists may_run_unattended boolean not null default false;

alter table public.management_items
  drop constraint if exists management_items_snooze_ck;
alter table public.management_items
  add constraint management_items_snooze_ck check (
    (snoozed_until is null) = (snooze_reason is null)
  );

alter table public.management_items
  drop constraint if exists management_items_evidence_request_ck;
alter table public.management_items
  add constraint management_items_evidence_request_ck check (
    (evidence_requested_at is null) = (evidence_request_reason is null)
  );

alter table public.management_items
  drop constraint if exists management_items_evidence_quality_ck;
alter table public.management_items
  add constraint management_items_evidence_quality_ck check (
    evidence_quality is null
    or evidence_quality in ('sufficient', 'low_confidence', 'contradictory', 'insufficient')
  );

-- Unattended running is permitted ONLY on sufficient evidence (owner decision D-9). A
-- recommendation the system is unsure about can never take itself.
alter table public.management_items
  drop constraint if exists management_items_unattended_ck;
alter table public.management_items
  add constraint management_items_unattended_ck check (
    may_run_unattended = false
    or (evidence_quality = 'sufficient' and required_authority = 'automatic')
  );

create index if not exists management_items_snoozed_idx
  on public.management_items (company_id, snoozed_until) where snoozed_until is not null;

-- ── 4. observation_sources carries CONFIGURATION ONLY ──────────────────────────────────
-- A company-NULL row is the cross-company DEFAULT registration and is readable by every
-- authenticated member, so it must never hold anything sensitive. The table has no payload
-- column by design; this assertion fails the migration if one is ever added, rather than
-- letting a credential or a customer detail become world-readable across companies.
do $$
declare
  bad text;
begin
  select string_agg(column_name, ', ') into bad
    from information_schema.columns
   where table_schema = 'public' and table_name = 'observation_sources'
     and (column_name ~* '(secret|token|key|credential|password|customer|phone|email|address|amount|body)');
  if bad is not null then
    raise exception 'observation_sources must hold configuration only; sensitive column(s): %', bad
      using errcode = 'check_violation';
  end if;
end
$$;
