-- 0072 — durable task ROUTING state (AIM-003).
--
-- WHY: AI-captured tasks were routed to nobody. `requires_human` was written and read only by a
-- badge, the follow-ups cron selects only tasks that already have an assignee, and the Analyze
-- screen told the operator "routed for human approval" when no request, queue, recipient or record
-- existed. A UI string is not routing.
--
-- SEPARATION OF LIFECYCLES (owner instruction): `tasks.status` remains the WORK lifecycle
-- (captured → in_progress → completed …). Routing is a SEPARATE lifecycle with its own row, so a
-- task can be `in_progress` while its routing is `escalated`, and neither overloads the other.
--
-- THE AUTHORITY BOUNDARY: a proposed assignee coming from model output is UNTRUSTED INPUT. The
-- routing RPC re-validates membership, active status, capability and cross-company isolation AT THE
-- TRANSACTION BOUNDARY, so an assignee who was eligible when recommended but is not at commit time
-- is refused. The AI may recommend; it cannot make anyone eligible.

begin;

create table if not exists public.task_routing (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  task_id             uuid not null references public.tasks(id) on delete cascade,

  routing_state       text not null check (routing_state in (
                        'assigned', 'awaiting_approval', 'needs_routing', 'manual_review',
                        'no_eligible_assignee', 'failed_retryable', 'escalated')),
  -- Deterministic, machine-readable WHY. Never free prose: the UI renders from this.
  reason_code         text not null,
  required_capability text,

  -- What the recommender PROPOSED (untrusted). Kept for audit even when refused.
  proposed_assignees  jsonb not null default '[]'::jsonb,
  -- What was actually committed after revalidation. Exactly one of these may be set.
  assignee_id         uuid,
  queue_name          text,
  approval_request_id uuid,

  attempt_count       integer not null default 0,
  next_attempt_at     timestamptz,

  -- Who decided, and whether a human or a machine did.
  decided_by          uuid,
  decided_by_source   text not null default 'system' check (decided_by_source in ('ai', 'human', 'system')),

  -- Exactly one active routing row per task; superseded rows stay for history.
  is_active           boolean not null default true,
  superseded_by       uuid references public.task_routing(id) on delete set null,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- An assignment must name an assignee; a queue routing must name a queue. A state that claims a
  -- destination must HAVE one — that is the whole point of this table.
  constraint task_routing_destination_ck check (
    (routing_state = 'assigned' and assignee_id is not null)
    or (routing_state = 'awaiting_approval' and approval_request_id is not null)
    or (routing_state not in ('assigned', 'awaiting_approval'))
  )
);

create unique index if not exists task_routing_one_active_idx
  on public.task_routing (task_id) where is_active;
create index if not exists task_routing_company_state_idx
  on public.task_routing (company_id, routing_state) where is_active;
create index if not exists task_routing_retry_idx
  on public.task_routing (next_attempt_at) where is_active and routing_state = 'failed_retryable';

-- Append-only history. Every transition lands here, including refusals.
create table if not exists public.task_routing_events (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  task_id         uuid not null references public.tasks(id) on delete cascade,
  routing_id      uuid references public.task_routing(id) on delete set null,
  from_state      text,
  to_state        text not null,
  reason_code     text not null,
  detail          jsonb not null default '{}'::jsonb,
  actor_id        uuid,
  actor_source    text not null default 'system',
  created_at      timestamptz not null default now()
);
create index if not exists task_routing_events_task_idx on public.task_routing_events (task_id, created_at);

alter table public.task_routing enable row level security;
alter table public.task_routing_events enable row level security;

drop policy if exists task_routing_read on public.task_routing;
create policy task_routing_read on public.task_routing
  for select using (public.has_company_access(company_id));
drop policy if exists task_routing_events_read on public.task_routing_events;
create policy task_routing_events_read on public.task_routing_events
  for select using (public.has_company_access(company_id));

-- Routing decides who is accountable for work. A member-writable routing row would let a person
-- assign work to themselves or away from themselves, so writes are service-only.
revoke insert, update, delete, truncate on public.task_routing from anon, authenticated;
revoke insert, update, delete, truncate on public.task_routing_events from anon, authenticated;
grant select on public.task_routing to authenticated;
grant select on public.task_routing_events to authenticated;
grant all on public.task_routing to service_role;
grant all on public.task_routing_events to service_role;

-- Append-only: history may never be rewritten, even by the service role.
create or replace function public.task_routing_events_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  raise exception 'task_routing_events is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;
drop trigger if exists task_routing_events_immutable_trg on public.task_routing_events;
create trigger task_routing_events_immutable_trg
  before update or delete on public.task_routing_events
  for each row execute function public.task_routing_events_append_only();

-- ── Eligibility, revalidated at the transaction boundary ───────────────────────────────────────
-- Returns a deterministic reason code, or NULL when the candidate is eligible. A model-proposed
-- assignee passes through exactly this check; being proposed grants nothing.
create or replace function public.task_assignee_ineligible_reason(
  p_company uuid,
  p_assignee uuid,
  p_capability text,
  p_submitter uuid default null
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_ok boolean;
begin
  if p_assignee is null then return 'no_assignee_proposed'; end if;

  -- Membership in THIS company, and active. Cross-company isolation is enforced here: a person who
  -- belongs to another company simply has no active membership row for this one.
  select exists (
    select 1 from public.memberships m
     where m.company_id = p_company and m.user_id = p_assignee and m.status = 'active'
  ) into v_ok;
  if not v_ok then return 'not_active_member_of_company'; end if;

  -- The profile must exist in this company and be active.
  select exists (
    select 1 from public.profiles pr
     where pr.id = p_assignee and pr.company_id = p_company and pr.is_active
  ) into v_ok;
  if not v_ok then return 'profile_inactive_or_missing'; end if;

  -- Required capability, when the work names one.
  if coalesce(btrim(p_capability), '') <> '' then
    select public.has_capability(p_assignee, p_capability) into v_ok;
    if not coalesce(v_ok, false) then return 'lacks_required_capability'; end if;
  end if;

  -- Separation of duties: the person who raised the work does not approve or verify their own.
  if p_submitter is not null and p_submitter = p_assignee then
    return 'separation_of_duties';
  end if;

  return null;
end;
$$;

-- ── The atomic routing transition ──────────────────────────────────────────────────────────────
create or replace function public.route_task(
  p_company uuid,
  p_task uuid,
  p_desired_state text,
  p_reason_code text,
  p_required_capability text default null,
  p_proposed jsonb default '[]'::jsonb,
  p_assignee uuid default null,
  p_queue text default null,
  p_approval uuid default null,
  p_actor uuid default null,
  p_actor_source text default 'system',
  p_submitter uuid default null
)
returns table (routing_id uuid, routing_state text, reason_code text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_task     record;
  v_prev     record;
  v_state    text := p_desired_state;
  v_reason   text := p_reason_code;
  v_assignee uuid := p_assignee;
  v_id       uuid;
  v_bad      text;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'route_task is a service-only boundary' using errcode = 'insufficient_privilege';
  end if;
  if p_company is null or p_task is null then raise exception 'company and task are required'; end if;

  -- Lock the task: two concurrent routers serialise here, so neither can commit a conflicting
  -- active assignment.
  select t.id, t.company_id, t.status into v_task
    from public.tasks t where t.id = p_task for update;
  if not found then raise exception 'task % not found', p_task; end if;

  -- Cross-company isolation: a task is routed only within its own company.
  if v_task.company_id is distinct from p_company then
    raise exception 'task does not belong to this company' using errcode = 'insufficient_privilege';
  end if;

  -- Terminal work is not routable.
  if v_task.status in ('completed', 'cancelled') then
    raise exception 'task is % and cannot be routed', v_task.status using errcode = 'invalid_parameter_value';
  end if;

  -- Revalidate eligibility AT COMMIT TIME. A candidate who was eligible when recommended but is not
  -- now is refused, and the outcome degrades truthfully rather than assigning anyway.
  if v_state = 'assigned' then
    v_bad := public.task_assignee_ineligible_reason(p_company, v_assignee, p_required_capability, p_submitter);
    if v_bad is not null then
      v_state    := case when v_bad = 'no_assignee_proposed' then 'needs_routing' else 'no_eligible_assignee' end;
      v_reason   := v_bad;
      v_assignee := null;
    end if;
  end if;

  if v_state = 'awaiting_approval' and p_approval is null then
    v_state  := 'manual_review';
    v_reason := 'approval_required_but_no_approval_record';
  end if;

  -- Supersede the previous active routing rather than deleting it; history is preserved.
  --
  -- ORDER MATTERS. `task_routing_one_active_idx` is a partial UNIQUE index on (task_id) WHERE
  -- is_active, so the previous row must be deactivated BEFORE the new one is inserted — otherwise
  -- two active rows exist momentarily and the index rejects the insert. Both statements are in the
  -- same transaction under the task-row lock taken above, so no window exists in which a task has
  -- zero active routings as far as any other transaction can observe.
  select * into v_prev from public.task_routing r where r.task_id = p_task and r.is_active for update;
  if v_prev.id is not null then
    update public.task_routing set is_active = false, updated_at = now() where id = v_prev.id;
  end if;

  insert into public.task_routing (
    company_id, task_id, routing_state, reason_code, required_capability, proposed_assignees,
    assignee_id, queue_name, approval_request_id, attempt_count, decided_by, decided_by_source
  ) values (
    p_company, p_task, v_state, v_reason, nullif(btrim(coalesce(p_required_capability, '')), ''),
    coalesce(p_proposed, '[]'::jsonb),
    case when v_state = 'assigned' then v_assignee else null end,
    case when v_state = 'assigned' then null else nullif(btrim(coalesce(p_queue, '')), '') end,
    case when v_state = 'awaiting_approval' then p_approval else null end,
    coalesce(v_prev.attempt_count, 0) + 1,
    p_actor, coalesce(p_actor_source, 'system')
  ) returning id into v_id;

  if v_prev.id is not null then
    update public.task_routing set superseded_by = v_id, updated_at = now() where id = v_prev.id;
  end if;

  insert into public.task_routing_events (company_id, task_id, routing_id, from_state, to_state, reason_code, detail, actor_id, actor_source)
  values (p_company, p_task, v_id, v_prev.routing_state, v_state, v_reason,
          jsonb_build_object('proposed', coalesce(p_proposed, '[]'::jsonb), 'refused_reason', v_bad),
          p_actor, coalesce(p_actor_source, 'system'));

  return query select v_id, v_state, v_reason;
end;
$$;

revoke all on function public.route_task(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.task_assignee_ineligible_reason(uuid,uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.task_routing_events_append_only() from public, anon, authenticated;
grant execute on function public.route_task(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid,text,uuid) to service_role;
grant execute on function public.task_assignee_ineligible_reason(uuid,uuid,text,uuid) to service_role;
grant execute on function public.task_routing_events_append_only() to service_role;

do $$
declare bad text;
begin
  select string_agg(x.priv, ', ') into bad from (
    select t.tbl || ':' || r.rolname || ':' || pr.privilege as priv
      from (values ('public.task_routing'),('public.task_routing_events')) as t(tbl)
      cross join (values ('anon'),('authenticated')) as r(rolname)
      cross join (values ('INSERT'),('UPDATE'),('DELETE')) as pr(privilege)
     where has_table_privilege(r.rolname, t.tbl, pr.privilege)
  ) x;
  if bad is not null then raise exception '0072 fail-closed: untrusted write privilege remains — %', bad; end if;

  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('route_task','task_assignee_ineligible_reason','task_routing_events_append_only')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if bad is not null then raise exception '0072 fail-closed: % reachable by anon/authenticated', bad; end if;
end $$;

commit;
