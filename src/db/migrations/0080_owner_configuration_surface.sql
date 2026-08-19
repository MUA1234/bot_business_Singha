-- 0080 — owner configuration as an audited workflow, not hand-edited SQL (R1 §5, OF-004/OF-005).
--
-- Two things had to be done by editing the database directly: mapping a receiving WhatsApp number
-- to its company, and giving someone the capability to work the inbound review queue. Both are
-- security-relevant — the first decides which company owns a message, the second decides who can
-- read untrusted third-party text — and neither had a surface, a validation step or an audit trail.
--
-- WHAT STAYS AN OWNER GATE. The VALUES and the ACTIVATION. A mapping is created INACTIVE and does
-- nothing until an owner activates it; a capability is granted only by someone who already holds
-- `admin.identity.manage`. Nothing here grants anything automatically or invents a mapping.
--
-- Every function is service-only with an in-function role gate, re-checks the ACTING PERSON's
-- capability inside the transaction, and writes its audit event in the same transaction as the
-- change.

begin;

-- ── Mapping: create (inactive), validate, activate, deactivate ─────────────────────────────────
create or replace function public.admin_upsert_channel_account(
  p_company uuid,
  p_channel text,
  p_provider_account_id text,
  p_label text,
  p_actor uuid
)
returns table (account_id uuid, created boolean, conflict text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_norm text;
  v_id uuid;
  v_owner_company uuid;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'admin_upsert_channel_account is a service-only boundary' using errcode = 'insufficient_privilege';
  end if;
  if not public.actor_has_capability(p_actor, p_company, 'admin.organisation.manage') then
    raise exception 'admin.organisation.manage is required to map a receiving account'
      using errcode = 'insufficient_privilege';
  end if;

  v_norm := public.normalize_channel_account(p_provider_account_id);
  if v_norm is null then raise exception 'a receiving account id is required'; end if;
  if lower(btrim(coalesce(p_channel, ''))) not in ('whatsapp', 'email', 'sms') then
    raise exception 'unsupported channel %', p_channel;
  end if;

  -- VALIDATION BEFORE ACTIVATION: an account already claimed by another company is reported as a
  -- conflict rather than silently taken over. Deciding which company owns a number is the owner's.
  select a.company_id into v_owner_company
    from public.channel_accounts a
   where a.channel = lower(btrim(p_channel)) and a.provider_account_id = v_norm and a.is_active;
  if v_owner_company is not null and v_owner_company <> p_company then
    return query select null::uuid, false, 'claimed_by_another_company'::text;
    return;
  end if;

  select a.id into v_id from public.channel_accounts a
   where a.company_id = p_company and a.channel = lower(btrim(p_channel)) and a.provider_account_id = v_norm;
  if v_id is not null then
    update public.channel_accounts set display_label = coalesce(nullif(btrim(p_label), ''), display_label)
     where id = v_id;
    insert into public.audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
    values (p_company, 'user', p_actor::text, 'channel_account.updated', 'channel_account', v_id::text,
            jsonb_build_object('channel', lower(btrim(p_channel)), 'account', v_norm));
    return query select v_id, false, null::text;
    return;
  end if;

  -- Created INACTIVE. A new mapping changes nothing until someone activates it deliberately.
  insert into public.channel_accounts (company_id, channel, provider_account_id, display_label, is_active, created_by)
  values (p_company, lower(btrim(p_channel)), v_norm, nullif(btrim(p_label), ''), false, p_actor)
  returning id into v_id;

  insert into public.audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, 'user', p_actor::text, 'channel_account.created', 'channel_account', v_id::text,
          jsonb_build_object('channel', lower(btrim(p_channel)), 'account', v_norm, 'active', false));
  return query select v_id, true, null::text;
end;
$$;

create or replace function public.admin_set_channel_account_active(
  p_company uuid,
  p_account uuid,
  p_active boolean,
  p_actor uuid
)
returns table (account_id uuid, is_active boolean, conflict text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v record;
  v_other uuid;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'admin_set_channel_account_active is a service-only boundary' using errcode = 'insufficient_privilege';
  end if;
  if not public.actor_has_capability(p_actor, p_company, 'admin.organisation.manage') then
    raise exception 'admin.organisation.manage is required to activate a receiving account'
      using errcode = 'insufficient_privilege';
  end if;

  select a.id, a.company_id, a.channel, a.provider_account_id, a.is_active into v
    from public.channel_accounts a where a.id = p_account for update;
  if not found or v.company_id is distinct from p_company then
    raise exception 'channel account not found in this company';
  end if;

  if p_active then
    -- Re-validated AT ACTIVATION: the conflict may have appeared since the mapping was created.
    select a.company_id into v_other from public.channel_accounts a
     where a.channel = v.channel and a.provider_account_id = v.provider_account_id
       and a.is_active and a.id <> v.id;
    if v_other is not null then
      return query select v.id, v.is_active, 'claimed_by_another_company'::text;
      return;
    end if;
  end if;

  update public.channel_accounts set is_active = p_active where id = v.id;
  insert into public.audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, 'user', p_actor::text,
          case when p_active then 'channel_account.activated' else 'channel_account.deactivated' end,
          'channel_account', v.id::text,
          jsonb_build_object('channel', v.channel, 'account', v.provider_account_id));
  return query select v.id, p_active, null::text;
end;
$$;

-- ── Who may work the inbound review queue ─────────────────────────────────────────────────────
-- A capability is granted by giving a person a ROLE that carries it. Only a small allowlist of
-- roles is grantable here, and only by someone who already holds admin.identity.manage.
create or replace function public.admin_set_membership_role(
  p_company uuid,
  p_user uuid,
  p_role_key text,
  p_grant boolean,
  p_actor uuid
)
-- The OUT column is named `resolved_membership`, not `membership_id`: the latter collides with the
-- column of the same name in `membership_roles` and makes the DELETE below ambiguous.
returns table (resolved_membership uuid, granted boolean)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_membership uuid;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'admin_set_membership_role is a service-only boundary' using errcode = 'insufficient_privilege';
  end if;
  if not public.actor_has_capability(p_actor, p_company, 'admin.identity.manage') then
    raise exception 'admin.identity.manage is required to change what someone can do'
      using errcode = 'insufficient_privilege';
  end if;
  -- A closed list. This surface exists to staff the review queue, not to hand out any role.
  if p_role_key not in ('finance_reviewer', 'owner_management', 'project_manager') then
    raise exception 'role % is not grantable through this surface', p_role_key
      using errcode = 'insufficient_privilege';
  end if;
  if p_actor = p_user and p_grant then
    -- Self-elevation is the classic hole. Someone else grants it.
    raise exception 'a person may not grant themselves a role through this surface'
      using errcode = 'insufficient_privilege';
  end if;

  select m.id into v_membership from public.memberships m
   where m.user_id = p_user and m.company_id = p_company and m.status = 'active';
  if v_membership is null then
    raise exception 'that person has no active membership in this company';
  end if;

  if p_grant then
    insert into public.membership_roles (membership_id, company_id, role_key)
    values (v_membership, p_company, p_role_key)
    on conflict do nothing;
  else
    delete from public.membership_roles mr where mr.membership_id = v_membership and mr.role_key = p_role_key;
  end if;

  insert into public.audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, 'user', p_actor::text,
          case when p_grant then 'membership_role.granted' else 'membership_role.revoked' end,
          'membership', v_membership::text,
          jsonb_build_object('role_key', p_role_key, 'subject_user', p_user));

  return query select v_membership, p_grant;
end;
$$;

-- ── Setup status: what is configured, what is still required ──────────────────────────────────
create or replace function public.inbound_setup_status(p_company uuid)
returns table (
  active_accounts bigint,
  inactive_accounts bigint,
  conflicting_accounts bigint,
  reviewers bigint,
  open_reviews bigint,
  single_tenant_bridge_in_use boolean
)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'inbound_setup_status is a service-only boundary' using errcode = 'insufficient_privilege';
  end if;
  if p_company is null then
    raise exception 'p_company is required — setup status is per company';
  end if;

  return query
  select
    (select count(*) from public.channel_accounts a where a.company_id = p_company and a.is_active),
    (select count(*) from public.channel_accounts a where a.company_id = p_company and not a.is_active),
    -- An account this company holds that ANOTHER company also holds actively.
    (select count(*) from public.channel_accounts a
      where a.company_id = p_company
        and exists (select 1 from public.channel_accounts b
                     where b.channel = a.channel and b.provider_account_id = a.provider_account_id
                       and b.company_id <> a.company_id and b.is_active)),
    (select count(distinct m.user_id)
       from public.memberships m
      where m.company_id = p_company and m.status = 'active'
        and public.actor_has_capability(m.user_id, p_company, 'operations.inbound.review')),
    (select count(*) from public.inbound_reviews r where r.company_id = p_company and r.state = 'open'),
    -- TRUE while messages are attributed by the documented bridge rather than by configuration.
    (select count(*) = 0 from public.channel_accounts a where a.channel = 'whatsapp' and a.is_active)
      and (select count(*) = 1 from public.companies);
end;
$$;

revoke all on function public.admin_upsert_channel_account(uuid,text,text,text,uuid) from public, anon, authenticated;
revoke all on function public.admin_set_channel_account_active(uuid,uuid,boolean,uuid) from public, anon, authenticated;
revoke all on function public.admin_set_membership_role(uuid,uuid,text,boolean,uuid) from public, anon, authenticated;
revoke all on function public.inbound_setup_status(uuid) from public, anon, authenticated;
grant execute on function public.admin_upsert_channel_account(uuid,text,text,text,uuid) to service_role;
grant execute on function public.admin_set_channel_account_active(uuid,uuid,boolean,uuid) to service_role;
grant execute on function public.admin_set_membership_role(uuid,uuid,text,boolean,uuid) to service_role;
grant execute on function public.inbound_setup_status(uuid) to service_role;

do $$
declare bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('admin_upsert_channel_account','admin_set_channel_account_active',
                       'admin_set_membership_role','inbound_setup_status')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if bad is not null then
    raise exception '0080 fail-closed: % reachable by anon/authenticated', bad;
  end if;
end $$;

commit;
