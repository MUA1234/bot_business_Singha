-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_011 — the runtime entrypoint's own state: company enablement, the run ledger,
-- and the company-scoped concurrency lock.
--
-- ENABLEMENT IS DELIBERATELY A SERVER-SIDE RECORD, NOT A CLIENT FLAG. There is no
-- pre-existing company-settings table in this repository, so one is introduced here — but
-- its AUTHORITY comes entirely from the existing capability matrix
-- (`admin.organisation.manage`), not from a new permission system. A company row is the
-- second of two independent switches: the global server flag is the first, and the kernel
-- runs only when BOTH are true.

create table if not exists management_kernel_enablement (
  company_id   uuid primary key,
  enabled      boolean not null default false,
  -- Who turned it on, and when. Enabling a system that reads every department's data is a
  -- decision that must be attributable.
  enabled_by   uuid,
  enabled_at   timestamptz,
  disabled_by  uuid,
  disabled_at  timestamptz,
  note         text,
  updated_at   timestamptz not null default now()
);

drop trigger if exists management_kernel_enablement_touch on management_kernel_enablement;
create trigger management_kernel_enablement_touch
  before update on management_kernel_enablement
  for each row execute function r1_draft_touch_updated_at();

-- ── The run ledger ─────────────────────────────────────────────────────────────────────
-- Every cycle attempt is recorded, including the ones that did nothing. A cycle that was
-- skipped because the flag was off, or because another cycle held the lock, is as
-- important to record as one that produced work: it is the difference between "nothing
-- needed attention" and "nothing looked".
create table if not exists management_cycle_runs (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  correlation_id    text not null,
  trigger_mode      text not null check (trigger_mode in ('manual', 'scheduled', 'test')),
  actor_id          uuid,

  status            text not null
    check (status in ('completed', 'partial', 'skipped_disabled', 'skipped_locked', 'failed')),

  sources_registered  integer not null default 0,
  sources_succeeded   integer not null default 0,
  sources_failed      integer not null default 0,
  items_created       integer not null default 0,
  items_reused        integer not null default 0,
  observations_skipped integer not null default 0,
  observations_rejected integer not null default 0,

  -- Departments whose adapter failed. A cycle carrying ANY of these is `partial`, never
  -- `completed` — one failing adapter must not become a silent success.
  unobserved_departments text[] not null default '{}',
  failure_reason    text,

  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  duration_ms       integer,

  -- A `completed` run must have observed everything it registered. This is the invariant
  -- that stops a partial sweep being reported as a clean one.
  constraint management_cycle_runs_complete_ck check (
    status <> 'completed'
    or (sources_failed = 0 and cardinality(unobserved_departments) = 0)
  ),
  constraint management_cycle_runs_partial_ck check (
    status <> 'partial'
    or (sources_failed > 0 or cardinality(unobserved_departments) > 0)
  )
);

create index if not exists management_cycle_runs_company_idx
  on management_cycle_runs (company_id, started_at desc);
create index if not exists management_cycle_runs_correlation_idx
  on management_cycle_runs (correlation_id);

-- Append-only: a run record is what happened, and it is not revised afterwards. The runner
-- writes ONE row when the cycle ends, so there is no in-flight row to update.
create or replace function r1_draft_runs_append_only() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  raise exception 'management_cycle_runs is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists management_cycle_runs_no_update on management_cycle_runs;
create trigger management_cycle_runs_no_update
  before update or delete on management_cycle_runs
  for each row execute function r1_draft_runs_append_only();

-- ── The company-scoped concurrency lock ────────────────────────────────────────────────
-- A SESSION advisory lock, not a row lock: the cycle spans several transactions (each
-- adapter's persistence is its own unit of work), so a transaction-scoped lock would be
-- released halfway through. `pg_try_advisory_lock` returns immediately rather than queuing,
-- so a second simultaneous cycle reports `skipped_locked` instead of piling up behind the
-- first — which is the honest outcome for a periodic sweep.
create or replace function r1_draft_try_cycle_lock(p_company uuid)
returns boolean
language sql
set search_path = pg_catalog, public, pg_temp
as $$
  select pg_try_advisory_lock(hashtext('r1_management_cycle'), hashtext(p_company::text));
$$;

create or replace function r1_draft_release_cycle_lock(p_company uuid)
returns boolean
language sql
set search_path = pg_catalog, public, pg_temp
as $$
  select pg_advisory_unlock(hashtext('r1_management_cycle'), hashtext(p_company::text));
$$;

-- ── Policies ───────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.has_capability(uuid, text)') is null then
    raise notice 'R1_DRAFT_011: base identity functions absent — policies SKIPPED (standalone draft database)';
    return;
  end if;

  -- No permissive default anywhere.
  execute 'revoke all on table public.management_kernel_enablement from public, anon';
  execute 'revoke all on table public.management_cycle_runs from public, anon';
  execute 'alter table public.management_kernel_enablement enable row level security';
  execute 'alter table public.management_cycle_runs enable row level security';

  -- Any member may SEE whether the kernel is enabled for their company, and what the last
  -- cycles did. Transparency about what the system is doing to a company's data is not a
  -- privilege.
  begin
    execute 'create policy management_kernel_enablement_sel on public.management_kernel_enablement
               for select to authenticated using (public.has_company_access(company_id))';
  exception when duplicate_object then null; end;
  begin
    execute 'create policy management_cycle_runs_sel on public.management_cycle_runs
               for select to authenticated using (public.has_company_access(company_id))';
  exception when duplicate_object then null; end;

  -- ENABLING is administrative: it starts a system that reads every department.
  begin
    execute 'create policy management_kernel_enablement_ins on public.management_kernel_enablement
               for insert to authenticated
               with check (public.has_capability(company_id, ''admin.organisation.manage''))';
  exception when duplicate_object then null; end;
  begin
    execute 'create policy management_kernel_enablement_upd on public.management_kernel_enablement
               for update to authenticated
               using (public.has_capability(company_id, ''admin.organisation.manage''))
               with check (public.has_capability(company_id, ''admin.organisation.manage''))';
  exception when duplicate_object then null; end;

  -- Run records are written by the SERVER only. No authenticated INSERT policy exists, so
  -- a user cannot fabricate a cycle result that says the business was observed.
  execute 'grant select on table public.management_kernel_enablement to authenticated';
  execute 'grant select, insert, update on table public.management_kernel_enablement to service_role';
  execute 'grant select on table public.management_cycle_runs to authenticated';
  execute 'grant select, insert on table public.management_cycle_runs to service_role';

  if to_regclass('public.companies') is not null then
    begin
      alter table public.management_kernel_enablement
        add constraint management_kernel_enablement_company_fk
        foreign key (company_id) references public.companies(id) on delete cascade;
    exception when duplicate_object then null; end;
    begin
      alter table public.management_cycle_runs
        add constraint management_cycle_runs_company_fk
        foreign key (company_id) references public.companies(id) on delete restrict;
    exception when duplicate_object then null; end;
  end if;
end
$$;

-- ── Lock helpers are SERVICE-ONLY ──────────────────────────────────────────────────────
-- DEFECT FOUND BY ADVERSARIAL REVIEW: PostgreSQL grants EXECUTE on a new function to PUBLIC
-- by default, so `anon` could call these. An unauthenticated caller taking the advisory lock
-- for a company would make every real cycle report `skipped_locked` — a denial of service
-- against the management system, requiring no credentials at all.
--
-- The cycle runs through the service-role client, so only that role needs EXECUTE.
do $$
begin
  execute 'revoke all on function public.r1_draft_try_cycle_lock(uuid) from public';
  execute 'revoke all on function public.r1_draft_release_cycle_lock(uuid) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.r1_draft_try_cycle_lock(uuid) from anon';
    execute 'revoke all on function public.r1_draft_release_cycle_lock(uuid) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.r1_draft_try_cycle_lock(uuid) from authenticated';
    execute 'revoke all on function public.r1_draft_release_cycle_lock(uuid) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.r1_draft_try_cycle_lock(uuid) to service_role';
    execute 'grant execute on function public.r1_draft_release_cycle_lock(uuid) to service_role';
  end if;
end
$$;
