-- ⛔ R1/R2S-P DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
-- Owner decision R1-D-1: no production migration number until PR-F-001 and PR-F-004 close.
--
-- R2S-P_DRAFT_018 — per-company observation-source cursors and reconciliation generations.
--
-- WHY NOT `observation_sources` (draft unit 005). That table is a REGISTRY: configuration and
-- last-scan state, keyed on a NULLABLE company so one row can be the default registration for
-- every tenant. A cursor is per-company RUNTIME POSITION with a mandatory company, a different
-- key and a different lifecycle. Putting position there would mix configuration with progress and
-- make the shared default row meaningless — which company's sweep would it be holding?
--
-- WHAT THIS TABLE MAY CONTAIN, and what it may never contain. Position, generation, bounded
-- counts, timestamps and status. NEVER a customer message, a financial value, employee content,
-- an evidence body or a secret. That is enforced by a CHECK on the cursor payload's keys rather
-- than by convention, because a future caller looking for somewhere convenient to stash context
-- will find this table long after the convention is forgotten.

create table if not exists observation_source_cursors (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null,
  source             text not null,

  -- WHERE the sweep is. A tiny JSON position: {kind, updatedAt?, id?, key?} and nothing else.
  cursor             jsonb,

  -- Which reconciliation pass this is. Incremented when a full sweep WRAPS.
  generation         integer not null default 0,

  -- Set ONLY when a generation finished with no page failure. A partial or failed sweep leaves
  -- this untouched, which is what any future resolve-on-absence logic must gate on.
  sweep_complete_at  timestamptz,

  -- Bounded progress counts. Rows, pages and failures — never anything about the rows.
  rows_inspected     bigint not null default 0 check (rows_inspected >= 0),
  pages_processed    bigint not null default 0 check (pages_processed >= 0),
  page_failures      integer not null default 0 check (page_failures >= 0),

  status             text not null default 'idle'
                       check (status in ('idle', 'in_progress', 'complete', 'failed', 'blocked')),
  last_error         text check (last_error is null or char_length(last_error) <= 500),

  last_page_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (company_id, source)
);

create index if not exists osc_lookup_idx on observation_source_cursors (company_id, source);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- The cursor payload may hold POSITION and nothing else.
--
-- A denylist would have to anticipate every field somebody might add. This is an allowlist: any
-- key that is not one of the four position fields refuses the write.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function r1_draft_cursor_payload_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_key text;
begin
  if new.cursor is null then return new; end if;

  if jsonb_typeof(new.cursor) <> 'object' then
    raise exception 'a cursor must be a JSON object, not %', jsonb_typeof(new.cursor)
      using errcode = 'check_violation';
  end if;

  for v_key in select k from jsonb_object_keys(new.cursor) as t(k) loop
    if v_key not in ('kind', 'updatedAt', 'id', 'key') then
      raise exception
        'cursor state holds POSITION only; "%" is not a position field. Customer content, financial values, employee data, evidence bodies and secrets may never be stored here.', v_key
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  -- A bound on the whole payload, so no single position field becomes a smuggling channel.
  if char_length(new.cursor::text) > 512 then
    raise exception 'a cursor payload may not exceed 512 characters (got %)', char_length(new.cursor::text)
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists osc_payload_guard on observation_source_cursors;
create trigger osc_payload_guard
  before insert or update on observation_source_cursors
  for each row execute function r1_draft_cursor_payload_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- A sweep that did not finish cleanly may not claim completion.
--
-- `sweep_complete_at` is the flag any future resolve-on-absence logic will gate on, so it is
-- worth making unrepresentable rather than merely discouraged: a row cannot carry a completion
-- time while also reporting failure.
-- ─────────────────────────────────────────────────────────────────────────────────────────
alter table observation_source_cursors
  drop constraint if exists osc_completion_shape_ck;
alter table observation_source_cursors
  add constraint osc_completion_shape_ck check (
    sweep_complete_at is null or status <> 'failed'
  );

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Company scope, RLS and the service-only write boundary.
-- ─────────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.companies') is null then
    raise notice 'R2S-P_DRAFT_018: companies absent — cursor company FK SKIPPED (standalone draft database)';
  elsif not exists (
    select 1 from pg_constraint
     where conrelid = 'public.observation_source_cursors'::regclass
       and conname = 'observation_source_cursors_company_fk'
  ) then
    alter table public.observation_source_cursors
      add constraint observation_source_cursors_company_fk
      foreign key (company_id) references public.companies(id) on delete cascade;
  end if;

  if to_regprocedure('public.has_company_access(uuid)') is not null then
    execute 'alter table observation_source_cursors enable row level security';
    begin
      -- READ is company-scoped. WRITE has no policy at all: cursors are advanced by the
      -- server-side cycle through the service role, never by an authenticated caller.
      execute 'create policy osc_read on observation_source_cursors
                 for select using (has_company_access(company_id))';
    exception when duplicate_object then null;
    end;
  end if;
end
$$;

create or replace function r1_draft_guard_cursor_write() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'observation source cursors are advanced by the server, not by an API caller'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists osc_guard_write on observation_source_cursors;
create trigger osc_guard_write
  before insert or update or delete on observation_source_cursors
  for each row execute function r1_draft_guard_cursor_write();
