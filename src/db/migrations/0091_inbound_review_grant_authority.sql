-- 0090 — OF-018: inbound-review service authority is the EXECUTE grant, not request text.
--
-- Both RPCs are callable only by service_role. Their previous caller_jwt_role() checks made a
-- genuine direct service connection fail when it had no request claims or claim text that differed
-- from service_role. Keep the grant as the authority boundary; preserve all business controls.

begin;

create or replace function public.record_inbound_review(
  p_company uuid,
  p_channel text,
  p_provider_message_id text,
  p_reason_code text,
  p_reason_detail text default null,
  p_source_event uuid default null,
  p_sender_identity text default null,
  p_actor_type text default null,
  p_identity_match text default null,
  p_body_excerpt text default null
)
returns table (review_id uuid, created boolean)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_company is null then raise exception 'p_company is required'; end if;
  if coalesce(btrim(p_provider_message_id), '') = '' then
    raise exception 'p_provider_message_id is required — a queue row must be traceable to its message';
  end if;
  if coalesce(btrim(p_reason_code), '') = '' then
    raise exception 'p_reason_code is required — a review with no stated reason is not reviewable';
  end if;

  insert into public.inbound_reviews (
    company_id, source_event_id, channel, provider_message_id,
    sender_identity, actor_type, identity_match, reason_code, reason_detail, body_excerpt
  ) values (
    p_company, p_source_event, p_channel, btrim(p_provider_message_id),
    left(p_sender_identity, 128), left(p_actor_type, 32), left(p_identity_match, 32),
    left(btrim(p_reason_code), 64), left(p_reason_detail, 500), left(p_body_excerpt, 500)
  )
  on conflict (company_id, channel, provider_message_id) do nothing
  returning id into v_id;

  if v_id is not null then
    return query select v_id, true;
    return;
  end if;

  select r.id into v_id from public.inbound_reviews r
   where r.company_id = p_company and r.channel = p_channel
     and r.provider_message_id = btrim(p_provider_message_id);
  return query select v_id, false;
end;
$$;

create or replace function public.resolve_inbound_review(
  p_company uuid,
  p_review uuid,
  p_actor uuid,
  p_state text,
  p_note text default null
)
returns table (review_id uuid, state text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_row public.inbound_reviews%rowtype;
begin
  if p_state not in ('resolved', 'dismissed') then
    raise exception 'p_state must be resolved or dismissed (got %)', p_state;
  end if;
  if p_actor is null then
    raise exception 'p_actor is required — a resolution must name the person who made it';
  end if;
  if not public.actor_has_capability(p_actor, p_company, 'operations.inbound.review') then
    raise exception 'actor lacks operations.inbound.review in this company'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from public.inbound_reviews r
   where r.id = p_review and r.company_id = p_company
   for update;
  if v_row.id is null then
    raise exception 'inbound review not found in this company';
  end if;
  if v_row.state <> 'open' then
    return query select v_row.id, v_row.state;
    return;
  end if;

  update public.inbound_reviews
     set state = p_state, resolution_note = left(p_note, 500), resolved_by = p_actor, resolved_at = now()
   where id = v_row.id;

  insert into public.audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (
    p_company, 'user', p_actor::text, 'inbound.review_resolved', 'inbound_review', v_row.id::text,
    jsonb_build_object(
      'state', p_state,
      'reason_code', v_row.reason_code,
      'channel', v_row.channel,
      'provider_message_id', v_row.provider_message_id
    )
  );

  return query select v_row.id, p_state;
end;
$$;

revoke all on function public.record_inbound_review(uuid,text,text,text,text,uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.resolve_inbound_review(uuid,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.record_inbound_review(uuid,text,text,text,text,uuid,text,text,text,text) to service_role;
grant execute on function public.resolve_inbound_review(uuid,uuid,uuid,text,text) to service_role;

do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.record_inbound_review(uuid,text,text,text,text,uuid,text,text,text,text)',
    'public.resolve_inbound_review(uuid,uuid,uuid,text,text)'
  ] loop
    if not has_function_privilege('service_role', signature, 'EXECUTE')
      or has_function_privilege('anon', signature, 'EXECUTE')
      or has_function_privilege('authenticated', signature, 'EXECUTE') then
      raise exception '0090 fail-closed: inbound-review RPC grants are unsafe for %', signature;
    end if;
    if position('caller_jwt_role' in pg_get_functiondef(signature::regprocedure)) > 0 then
      raise exception '0090 fail-closed: inbound-review RPC still consults request claim text: %', signature;
    end if;
  end loop;
end $$;

commit;