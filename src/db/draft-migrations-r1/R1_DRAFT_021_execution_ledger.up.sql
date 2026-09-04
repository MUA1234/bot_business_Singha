-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_021 — the R2E execution ledger and the SECOND, separate enablement switch.
--
-- ── Why a second enablement table (R2E-F-004) ─────────────────────────────────────────────
--
-- `management_kernel_enablement` (draft 011) says a company's OBSERVATION cycle may run: it may
-- read, detect, recommend and file management items. The owner's direction is that this must not
-- implicitly confer the right to produce business effects. Being observed and being acted upon are
-- different powers, granted at different moments; a company that agreed to the first did not
-- thereby agree to the second.
--
-- Reusing one row for both would make the more dangerous power the silent consequence of the
-- safer one. So execution gets its own table, its own default of FALSE, and its own attribution.
--
-- ── Why the ledger records attempts, not successes (R2E-F-003) ────────────────────────────
--
-- `management_item_decisions` (draft 004) records approve/reject/edit/delegate. It has no
-- `execute` value and no attempt, result or failure columns, so there is nowhere to record that an
-- approved action was TRIED. That is the record duplicate-prevention depends on: a system that
-- writes only successes cannot tell a first attempt from a retry after a crash, because the
-- evidence of the first attempt is exactly what the crash destroyed.
--
-- Every attempt is therefore claimed BEFORE the handler runs, under a unique idempotency key, and
-- resolved afterwards. A row in `attempting` whose lease has expired is a crash, and it is
-- recoverable precisely because it was written first.

-- ── 1. Execution enablement — separate, and default false ────────────────────────────────
create table if not exists management_execution_enablement (
  company_id     uuid primary key,
  enabled        boolean not null default false,
  -- Attribution: enabling the production of business effects is not an anonymous act.
  enabled_by     uuid,
  enabled_at     timestamptz,
  disabled_by    uuid,
  disabled_at    timestamptz,
  note           text,
  updated_at     timestamptz not null default now()
);

drop trigger if exists management_execution_enablement_touch on management_execution_enablement;
create trigger management_execution_enablement_touch
  before update on management_execution_enablement
  for each row execute function r1_draft_touch_updated_at();

-- ── 2. The execution ledger ──────────────────────────────────────────────────────────────
--
-- `idempotency_key` is UNIQUE PER COMPANY, not globally: a key is a caller's own token and two
-- companies must never be able to collide, nor to probe each other's keys by guessing one.
create table if not exists management_execution_attempts (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null,
  item_id            uuid,
  action_id          text not null,
  idempotency_key    text not null,

  -- The claim, written BEFORE the handler is invoked.
  status             text not null
                       check (status in ('attempting', 'executed', 'refused', 'failed')),

  -- Refusals carry the closed reason from the contract, so "we chose not to" is never stored as
  -- though it were "we tried and it broke".
  refusal_reason     text,
  -- Non-sensitive. No cursor, no token, no customer name, no row contents.
  detail             text,

  -- What the handler produced, when it produced anything. NULL unless status = 'executed'.
  effect_ref         text,
  handler            text,

  -- The authority actually resolved at EXECUTION time, not at recommendation time.
  resolved_authority text,
  approved_by        uuid,

  -- Crash recovery. An 'attempting' row past its lease was interrupted.
  lease_expires_at   timestamptz,

  created_at         timestamptz not null default now(),
  completed_at       timestamptz,

  -- A terminal row must say what happened; a non-terminal row must not pretend it did.
  constraint execution_attempt_terminal_shape check (
    (status = 'attempting' and completed_at is null and effect_ref is null)
    or (status = 'executed' and completed_at is not null and effect_ref is not null)
    or (status = 'refused'  and completed_at is not null and refusal_reason is not null)
    or (status = 'failed'   and completed_at is not null)
  )
);

-- THE duplicate-prevention invariant. One key, one attempt row, per company — enforced by the
-- database rather than by the executor's own care, because the executor is what crashes.
create unique index if not exists management_execution_attempts_key_uniq
  on management_execution_attempts (company_id, idempotency_key);

create index if not exists management_execution_attempts_item
  on management_execution_attempts (company_id, item_id, created_at desc);

-- ── 3. Append-mostly: a terminal attempt is history ──────────────────────────────────────
--
-- An attempt may be resolved ONCE — 'attempting' → terminal. It may never be re-opened, edited
-- into a different outcome, or deleted. A ledger that can be rewritten after the fact cannot
-- answer the only question it exists to answer.
create or replace function r1_draft_execution_attempt_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'management_execution_attempts is append-only (delete refused)'
      using errcode = 'insufficient_privilege';
  end if;

  if old.status <> 'attempting' then
    raise exception 'execution attempt % is already terminal (%) and cannot be changed',
      old.id, old.status
      using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'attempting' then
    raise exception 'execution attempt % must resolve to a terminal status', old.id
      using errcode = 'check_violation';
  end if;

  -- The identity of an attempt is fixed at claim time. Only the OUTCOME may be written.
  if new.company_id <> old.company_id
     or new.idempotency_key <> old.idempotency_key
     or new.action_id <> old.action_id
     or new.id <> old.id then
    raise exception 'execution attempt % identity is immutable', old.id
      using errcode = 'insufficient_privilege';
  end if;

  -- A BEFORE trigger returning NULL SKIPS the operation silently. R2D-F-006 was exactly that
  -- defect: a guard returned NEW on DELETE, NEW is NULL for a delete, and every delete was
  -- discarded without error. DELETE is refused above by raising, never by returning NULL.
  return new;
end;
$fn$;

drop trigger if exists management_execution_attempts_guard on management_execution_attempts;
create trigger management_execution_attempts_guard
  before update or delete on management_execution_attempts
  for each row execute function r1_draft_execution_attempt_guard();

-- ── 4. RLS ───────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.has_capability(uuid, text)') is null then
    raise notice 'R1_DRAFT_021: base identity functions absent — policies SKIPPED (standalone draft database)';
    return;
  end if;

  execute 'revoke all on table public.management_execution_enablement from public, anon';
  execute 'revoke all on table public.management_execution_attempts from public, anon';
  execute 'alter table public.management_execution_enablement enable row level security';
  execute 'alter table public.management_execution_attempts enable row level security';

  -- Any member may SEE whether execution is enabled for their company, and what was attempted.
  -- A system that can act on a company must be legible to that company.
  begin
    execute 'create policy management_execution_enablement_sel on public.management_execution_enablement
               for select to authenticated using (public.has_company_access(company_id))';
  exception when duplicate_object then null; end;
  begin
    execute 'create policy management_execution_attempts_sel on public.management_execution_attempts
               for select to authenticated using (public.has_company_access(company_id))';
  exception when duplicate_object then null; end;

  -- Enabling EXECUTION is administrative, and deliberately the same capability that gates
  -- enabling the kernel — a company should not be able to acquire the more dangerous switch
  -- through a lesser role than the safer one.
  begin
    execute 'create policy management_execution_enablement_ins on public.management_execution_enablement
               for insert to authenticated
               with check (public.has_capability(company_id, ''admin.organisation.manage''))';
  exception when duplicate_object then null; end;
  begin
    execute 'create policy management_execution_enablement_upd on public.management_execution_enablement
               for update to authenticated
               using (public.has_capability(company_id, ''admin.organisation.manage''))
               with check (public.has_capability(company_id, ''admin.organisation.manage''))';
  exception when duplicate_object then null; end;

  -- There is NO insert or update policy for the ledger. An authenticated client cannot write an
  -- execution record at all: it cannot fabricate an attempt, cannot claim an idempotency key to
  -- block a real one, and cannot mark a failure as executed. Writes belong to the server-side
  -- executor alone.
end $$;

-- Reads only. The ledger is written by the server, never by a session.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.management_execution_enablement to authenticated';
    execute 'grant select on public.management_execution_attempts to authenticated';
  end if;
end $$;

-- ── 5. Durable idempotency for internal task creation ────────────────────────────────────
--
-- Deliberately NOT a column on `tasks`. `tasks` is a hosted production table and altering it
-- requires a numbered migration and owner approval; this draft may not do either. A side table
-- also keeps the key's lifetime independent of the task's.
create table if not exists management_task_idempotency (
  company_id      uuid not null,
  idempotency_key text not null,
  task_id         uuid not null,
  created_at      timestamptz not null default now(),
  primary key (company_id, idempotency_key)
);

-- ── 6. The one allowlisted handler, as an atomic RPC ─────────────────────────────────────
--
-- ── Why the key is claimed BEFORE the task exists ────────────────────────────────────────
--
-- The task id is generated first and the KEY ROW is inserted first. The unique index then
-- arbitrates: exactly one caller's insert survives, that caller creates the task under the id it
-- already claimed, and every other caller reads the winner's id and reports a duplicate.
--
-- The obvious ordering — create the task, then record the key — cannot be made correct. Two
-- concurrent callers both insert a task before either records a key, so the effect has already
-- happened twice by the time the database is asked to arbitrate.
--
-- `on conflict do nothing` takes a speculative insertion lock, so a caller racing an UNCOMMITTED
-- insert of the same key WAITS for that transaction rather than skipping past it. It then sees
-- either the committed winner (duplicate) or a free key (its own insert succeeds). This is
-- correct under READ COMMITTED, where each statement takes a fresh snapshot; under REPEATABLE
-- READ the follow-up SELECT would read a snapshot older than the winner's commit, so the function
-- asserts it found a row rather than returning a NULL task id.
--
-- There is NO assignee parameter. Assigning a person is a separate authority, and an argument the
-- function does not accept is an authority it cannot be talked into exercising.
create or replace function r1_draft_create_internal_task(
  p_company_id       uuid,
  p_idempotency_key  text,
  p_title            text,
  p_description      text,
  p_requires_evidence boolean,
  p_created_by       uuid
)
returns table (task_id uuid, created boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_new_id  uuid := gen_random_uuid();
  v_claimed uuid;
  v_found   uuid;
begin
  if p_company_id is null then
    raise exception 'company_id is required' using errcode = 'null_value_not_allowed';
  end if;
  if coalesce(btrim(p_idempotency_key), '') = '' then
    raise exception 'idempotency_key is required' using errcode = 'null_value_not_allowed';
  end if;
  if coalesce(btrim(p_title), '') = '' then
    raise exception 'title is required' using errcode = 'null_value_not_allowed';
  end if;

  insert into public.management_task_idempotency (company_id, idempotency_key, task_id)
  values (p_company_id, p_idempotency_key, v_new_id)
  on conflict (company_id, idempotency_key) do nothing
  returning management_task_idempotency.task_id into v_claimed;

  if v_claimed is null then
    -- Replay, or a lost race. Return the winner's task; create nothing.
    select t.task_id into v_found
      from public.management_task_idempotency t
     where t.company_id = p_company_id
       and t.idempotency_key = p_idempotency_key;

    if v_found is null then
      -- Only reachable under an isolation level whose snapshot predates the winner's commit.
      -- Failing loudly is correct: returning NULL would let a caller record an execution
      -- against a task that does not exist.
      raise exception 'idempotency key claimed but not visible — isolation level must be READ COMMITTED'
        using errcode = 'serialization_failure';
    end if;

    return query select v_found, false;
    return;
  end if;

  -- We hold the key. Create the task under the id the key already names. Unassigned.
  insert into public.tasks (id, company_id, title, description, status, requires_evidence, created_by)
  values (v_new_id, p_company_id, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''),
          'captured', coalesce(p_requires_evidence, false), p_created_by);

  return query select v_new_id, true;
end;
$fn$;

-- Service-only. An authenticated session must not be able to call the handler directly and
-- bypass the executor's boundary, policy, authority and approval checks.
do $$
begin
  execute 'revoke all on function public.r1_draft_create_internal_task(uuid, text, text, text, boolean, uuid) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.r1_draft_create_internal_task(uuid, text, text, text, boolean, uuid) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.r1_draft_create_internal_task(uuid, text, text, text, boolean, uuid) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.r1_draft_create_internal_task(uuid, text, text, text, boolean, uuid) to service_role';
  end if;
end $$;
