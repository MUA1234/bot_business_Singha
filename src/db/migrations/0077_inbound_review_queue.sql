-- 0075 — the manual-review queue an inbound message actually lands in (FOUND-003).
--
-- WHY: `recordForReview` wrote a structured LOG LINE. The raw event was already durable, so nothing
-- was lost, but nobody was ever going to see it: there was no row, no queue and no screen. A message
-- the system honestly could not handle disappeared into an operator's log aggregator. "Fails closed
-- to manual review" is only true if manual review is a place.
--
-- DESIGN
--   * `inbound_reviews` is one row per message that needs a person, company-scoped, carrying WHY it
--     could not be handled, who the sender resolved to, and a BOUNDED excerpt of the message.
--   * Recording is idempotent on (company, channel, provider message id), so a webhook redelivery
--     or a retried dispatch cannot produce a queue full of duplicates.
--   * Resolution is a service-only RPC that INDEPENDENTLY re-checks the acting user holds
--     `operations.inbound.review` in that company and writes an audit event in the same
--     transaction. The application's own permission check is not trusted as the only gate.
--   * The queue is capability-gated for READ as well. It contains untrusted third-party message
--     text, which is not something every member of a company should be able to browse.
--
-- The message body stored here is UNTRUSTED CONTENT. It is displayed to a reviewer as data and must
-- never be treated as instructions (CLAUDE.md AI safety).
--
-- Forward-only, idempotent DDL. No feature flag (a correctness boundary, not a capability).

begin;

-- ── Capability ────────────────────────────────────────────────────────────────────────────────
insert into public.permissions (key, label) values
  ('operations.inbound.review', 'Operations: review inbound messages that need a person')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('owner_management',     'operations.inbound.review'),
  ('system_administrator', 'operations.inbound.review'),
  ('finance_reviewer',     'operations.inbound.review')
on conflict do nothing;

-- ── ONE capability implementation, usable for an EXPLICIT actor ───────────────────────────────
-- `has_capability` reads auth.uid(), which is null in a service-role worker. A service-only RPC
-- that must verify a NAMED actor therefore needs a user-scoped form. Copying the rule would let the
-- two drift, so the rule moves here and `has_capability` becomes a thin wrapper over it — same
-- direct-plus-delegated semantics, one place to change.
create or replace function public.actor_has_capability(p_user uuid, p_company uuid, p_capability text)
returns boolean
language sql stable security definer set search_path = pg_catalog, extensions, public, pg_temp
as $$
  select p_user is not null and (
    -- (a) Direct: the user's own active membership roles grant the capability.
    exists (
      select 1
      from public.memberships m
      join public.membership_roles mr on mr.membership_id = m.id
      join public.role_permissions rp on rp.role_key = mr.role_key
      where m.user_id = p_user
        and m.company_id = p_company
        and m.status = 'active'
        and rp.permission_key = p_capability
    )
    or
    -- (b) Delegated: an active, in-window delegation TO the user, where the DELEGATOR actually
    --     holds the capability (a delegate never exceeds the delegator) and the delegation domain
    --     covers this capability (null domain = all domains).
    exists (
      select 1
      from public.delegations d
      join public.memberships tm on tm.id = d.to_membership   and tm.user_id = p_user and tm.status = 'active'
      join public.memberships fm on fm.id = d.from_membership and fm.status = 'active'
      join public.membership_roles fmr on fmr.membership_id = fm.id
      join public.role_permissions frp on frp.role_key = fmr.role_key
      where d.company_id = p_company
        and now() between d.starts_at and d.ends_at
        and frp.permission_key = p_capability
        and (
          d.domain is null
          or split_part(p_capability, '.', 1) = d.domain
          or p_capability = d.domain
          or p_capability like d.domain || '.%'
        )
    )
  );
$$;

create or replace function public.has_capability(target_company uuid, capability text)
returns boolean
language sql stable security definer set search_path = pg_catalog, extensions, public, pg_temp
as $$
  select public.actor_has_capability(auth.uid(), target_company, capability);
$$;

-- actor_has_capability takes an ARBITRARY user id, so an untrusted caller could use it to probe
-- other people's permissions. It stays service-only; has_capability (SECURITY DEFINER, same owner)
-- reaches it for RLS.
revoke all on function public.actor_has_capability(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.actor_has_capability(uuid, uuid, text) to service_role;

-- ── The queue ─────────────────────────────────────────────────────────────────────────────────
create table if not exists public.inbound_reviews (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  source_event_id     uuid references public.source_events(id) on delete set null,
  channel             text not null check (channel in ('whatsapp', 'email', 'sms')),
  provider_message_id text not null,
  -- Who the sender resolved to AT THE TIME. Kept as a snapshot: a later mapping change must not
  -- silently rewrite why a reviewer was asked to look.
  sender_identity     text,
  actor_type          text,
  identity_match      text,
  reason_code         text not null,
  reason_detail       text,
  -- UNTRUSTED third-party text, bounded. Displayed as data, never executed or obeyed.
  body_excerpt        text,
  state               text not null default 'open' check (state in ('open', 'resolved', 'dismissed')),
  resolution_note     text,
  resolved_by         uuid,
  resolved_at         timestamptz,
  created_at          timestamptz not null default now(),
  -- A resolved row must say who resolved it and when. Enforced, not merely expected.
  constraint inbound_reviews_resolution_complete check (
    (state = 'open' and resolved_by is null and resolved_at is null)
    or (state <> 'open' and resolved_by is not null and resolved_at is not null)
  )
);

-- One review per message. Makes recording idempotent under webhook redelivery.
create unique index if not exists inbound_reviews_message_uq
  on public.inbound_reviews (company_id, channel, provider_message_id);
create index if not exists inbound_reviews_open_idx
  on public.inbound_reviews (company_id, created_at desc) where state = 'open';

alter table public.inbound_reviews enable row level security;

drop policy if exists inbound_reviews_read on public.inbound_reviews;
create policy inbound_reviews_read on public.inbound_reviews
  for select using (public.has_capability(company_id, 'operations.inbound.review'));

revoke insert, update, delete, truncate on public.inbound_reviews from anon, authenticated;
grant select on public.inbound_reviews to authenticated;
grant all on public.inbound_reviews to service_role;

-- ── Record (idempotent) ───────────────────────────────────────────────────────────────────────
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
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'record_inbound_review is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
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

  -- Already queued (redelivery / retry). Return the ORIGINAL row; change nothing about it.
  select r.id into v_id from public.inbound_reviews r
   where r.company_id = p_company and r.channel = p_channel
     and r.provider_message_id = btrim(p_provider_message_id);
  return query select v_id, false;
end;
$$;

-- ── Resolve (capability-checked at the database, audited in the same transaction) ─────────────
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
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'resolve_inbound_review is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if p_state not in ('resolved', 'dismissed') then
    raise exception 'p_state must be resolved or dismissed (got %)', p_state;
  end if;
  if p_actor is null then
    raise exception 'p_actor is required — a resolution must name the person who made it';
  end if;
  -- The application already checked permission. This is the INDEPENDENT check: a bug or a bypass in
  -- the app must not be enough to clear someone else's queue.
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
    -- Already decided. Return the existing state rather than overwriting someone else's decision.
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
declare bad text;
begin
  select string_agg(priv, ', ') into bad
    from (
      select 'inbound_reviews:' || r.rolname || ':' || pr.privilege as priv
        from (values ('anon'), ('authenticated')) as r(rolname)
        cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as pr(privilege)
       where has_table_privilege(r.rolname, 'public.inbound_reviews', pr.privilege)
    ) x;
  if bad is not null then
    raise exception '0075 fail-closed: untrusted write privilege remains — %', bad;
  end if;

  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('record_inbound_review', 'resolve_inbound_review', 'actor_has_capability')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if bad is not null then
    raise exception '0075 fail-closed: % reachable by anon/authenticated', bad;
  end if;

  -- has_capability is an RLS predicate evaluated in the CALLER's role and must STAY reachable.
  if not has_function_privilege('authenticated', 'public.has_capability(uuid,text)', 'EXECUTE') then
    raise exception '0075 fail-closed: has_capability is no longer executable by authenticated — RLS would deny everything';
  end if;
end $$;

commit;
