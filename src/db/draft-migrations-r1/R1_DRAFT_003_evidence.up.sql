-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_003 — evidence references.
--
-- Evidence is a REFERENCE to a real row plus the structured facts the detector read from it.
-- It is never copied prose and never anything a model produced. The zero-evidence
-- prohibition (an item may not reach `recommended` with no evidence) is enforced in
-- src/kernel/invariants.ts and re-proved at the database boundary by the trigger below.

create table if not exists management_item_evidence (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  item_id       uuid not null references management_items(id) on delete cascade,

  -- The real row this evidence points at.
  source_table  text not null,
  source_id     text not null,

  -- Structured facts read from that row. Deterministic; never model output.
  facts         jsonb not null default '{}'::jsonb,

  -- Where the evidence came from. `detector` is the only R1 producer; `model` is rejected
  -- as an evidence origin by design — a model may cite evidence, never create it.
  origin        text not null default 'detector'
    check (origin in ('detector', 'human')),

  captured_at   timestamptz not null default now(),

  constraint management_item_evidence_uq unique (item_id, source_table, source_id)
);

create index if not exists management_item_evidence_item_idx
  on management_item_evidence (item_id);
create index if not exists management_item_evidence_source_idx
  on management_item_evidence (company_id, source_table, source_id);

-- Append-only: evidence may be added, never rewritten. Deleting an item cascades.
create or replace function r1_draft_evidence_append_only() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  raise exception 'management_item_evidence is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists management_item_evidence_no_update on management_item_evidence;
create trigger management_item_evidence_no_update
  before update on management_item_evidence
  for each row execute function r1_draft_evidence_append_only();

-- CROSS-COMPANY REJECTION (acceptance B1). Evidence whose company differs from its item's
-- is refused at write time, so a company boundary cannot be crossed by a coding mistake.
create or replace function r1_draft_evidence_company_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_item_company uuid;
begin
  select company_id into v_item_company from public.management_items where id = new.item_id;
  if v_item_company is null then
    raise exception 'evidence references a non-existent management item'
      using errcode = 'foreign_key_violation';
  end if;
  if v_item_company is distinct from new.company_id then
    raise exception 'cross-company evidence refused: item company %, evidence company %',
      v_item_company, new.company_id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists management_item_evidence_company on management_item_evidence;
create trigger management_item_evidence_company
  before insert on management_item_evidence
  for each row execute function r1_draft_evidence_company_guard();

-- ZERO-EVIDENCE PROHIBITION at the database boundary (acceptance C1).
-- An item may not enter `recommended` — or anything downstream of it — with no evidence.
create or replace function r1_draft_require_evidence() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_count int;
begin
  if new.state in ('recommended', 'awaiting_approval', 'approved',
                   'needs_routing', 'assigned', 'monitoring', 'escalated',
                   'verifying', 'verified')
     and new.state is distinct from old.state then
    select count(*) into v_count
      from public.management_item_evidence where item_id = new.id;
    if v_count = 0 then
      raise exception 'management item % cannot enter state % with zero evidence', new.id, new.state
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists management_items_require_evidence on management_items;
create trigger management_items_require_evidence
  before update on management_items
  for each row execute function r1_draft_require_evidence();

do $$
begin
  if to_regproc('public.has_company_access(uuid)') is not null then
    execute 'alter table management_item_evidence enable row level security';
    begin
      execute 'create policy management_item_evidence_read on management_item_evidence
                 for select using (has_company_access(company_id))';
    exception when duplicate_object then null;
    end;
  end if;
end
$$;
