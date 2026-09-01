-- R1 DRAFT - NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_005 - the observation-source registry (owner decision R1-D-5).
--
-- ONE adapter contract, four trigger modes, cadence configurable per source AND per company.
-- No uncontrolled polling and no second scheduler: the existing in-process scheduler drives
-- `scheduled` sweeps, and it remains the only scheduler.
--
--   event     - an existing event already fires (e.g. an inbound source_event). Preferred:
--               no polling at all.
--   scheduled - a reconciliation sweep at `cadence_seconds`, to catch what events missed.
--   manual    - an authorised human presses refresh.
--   test      - deterministic invocation from a test. Never runs in production.

create table if not exists observation_sources (
  id               uuid primary key default gen_random_uuid(),

  -- NULL company_id = the default registration for every company; a row WITH a company_id
  -- overrides it for that company only. This is how cadence becomes per-company without
  -- duplicating a row for every tenant.
  company_id       uuid,

  department       text not null
    check (department in ('finance', 'workforce', 'operations', 'crm', 'system')),
  kind             text not null,

  enabled          boolean not null default true,

  -- Which trigger modes this source supports, and the sweep cadence when scheduled.
  supports_event     boolean not null default false,
  supports_scheduled boolean not null default true,
  supports_manual    boolean not null default true,
  cadence_seconds    integer
    check (cadence_seconds is null or cadence_seconds >= 60),

  -- Observation state. `last_failure_at` is what makes a failed scan visible: the surface
  -- must report the department UNOBSERVED rather than giving an all-clear (acceptance E2).
  last_scan_at        timestamptz,
  last_scan_duration_ms integer,
  last_success_at     timestamptz,
  last_failure_at     timestamptz,
  last_failure_reason text,
  consecutive_failures integer not null default 0,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One registration per (company, department, kind); NULL company is the default row.
  constraint observation_sources_uq unique nulls not distinct (company_id, department, kind),

  -- A scheduled source must state its cadence. No implicit polling interval.
  constraint observation_sources_cadence_ck
    check (not supports_scheduled or cadence_seconds is not null),

  -- A source must be reachable by at least one trigger mode, else it is dead configuration.
  constraint observation_sources_reachable_ck
    check (supports_event or supports_scheduled or supports_manual)
);

create index if not exists observation_sources_lookup_idx
  on observation_sources (department, kind, enabled);

drop trigger if exists observation_sources_touch on observation_sources;
create trigger observation_sources_touch
  before update on observation_sources
  for each row execute function r1_draft_touch_updated_at();

do $$
begin
  if to_regclass('public.companies') is not null then
    begin
      alter table observation_sources
        add constraint observation_sources_company_fk
        foreign key (company_id) references companies(id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;

  if to_regproc('public.has_company_access(uuid)') is not null then
    execute 'alter table observation_sources enable row level security';
    begin
      execute 'create policy observation_sources_read on observation_sources
                 for select using (company_id is null or has_company_access(company_id))';
    exception when duplicate_object then null;
    end;
  end if;
end
$$;
