-- MOD-003: configuration is human-governed; attempt telemetry remains worker-only.
insert into public.permissions (key, label) values
  ('ai.model_budget.manage', 'Manage AI model budget policies')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('owner_management', 'ai.model_budget.manage'),
  ('system_administrator', 'ai.model_budget.manage')
on conflict (role_key, permission_key) do nothing;

alter table public.ai_model_attempts enable row level security;
alter table public.ai_model_budget_policies enable row level security;
alter table public.ai_model_budget_policies add column if not exists version integer not null default 1;

create policy ai_model_budget_policies_read on public.ai_model_budget_policies
  for select using (public.has_capability(company_id, 'ai.model_budget.manage'));
create policy ai_model_budget_policies_write on public.ai_model_budget_policies
  for all using (public.has_capability(company_id, 'ai.model_budget.manage'))
  with check (public.has_capability(company_id, 'ai.model_budget.manage'));

revoke insert, update, delete on public.ai_model_attempts from authenticated;
revoke insert, update, delete on public.ai_model_budget_policies from authenticated;

create or replace function public.set_ai_model_budget_policy(
  p_company uuid, p_task text, p_max_cost_usd numeric, p_active boolean default true,
  p_expected_version integer default null
) returns integer
language plpgsql security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare v_actor uuid := auth.uid(); v_version integer;
begin
  if v_actor is null or not public.actor_has_capability(v_actor, p_company, 'ai.model_budget.manage') then
    raise exception 'actor lacks ai.model_budget.manage' using errcode = 'insufficient_privilege';
  end if;
  if p_task not in ('extraction', 'quotation', 'management') or p_max_cost_usd is null or p_max_cost_usd <= 0 then
    raise exception 'invalid AI model budget policy';
  end if;
  select version into v_version from public.ai_model_budget_policies
   where company_id=p_company and task=p_task for update;
  if v_version is null then
    if p_expected_version is not null and p_expected_version <> 0 then raise exception 'stale policy version'; end if;
    insert into public.ai_model_budget_policies (company_id, task, max_cost_usd, is_active, version, updated_at)
    values (p_company, p_task, p_max_cost_usd, p_active, 1, now()) returning version into v_version;
  else
    if p_expected_version is null or p_expected_version <> v_version then raise exception 'stale policy version'; end if;
    update public.ai_model_budget_policies set max_cost_usd=p_max_cost_usd, is_active=p_active,
      version=version+1, updated_at=now() where company_id=p_company and task=p_task returning version into v_version;
  end if;
  insert into public.audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, 'user', v_actor::text, 'ai.model_budget_policy_set', 'ai_model_budget_policy', p_task,
    jsonb_build_object('task', p_task, 'max_cost_usd', p_max_cost_usd, 'is_active', p_active, 'version', v_version));
  return v_version;
end $$;

revoke all on function public.set_ai_model_budget_policy(uuid,text,numeric,boolean,integer) from public, anon, service_role;
grant execute on function public.set_ai_model_budget_policy(uuid,text,numeric,boolean,integer) to authenticated;