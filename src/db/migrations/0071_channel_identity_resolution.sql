-- 0070 — trusted channel identity resolution (FOUND-003 prerequisite).
--
-- WHY: today an inbound WhatsApp message is processed as a CUSTOMER placing an order, whatever the
-- sender actually is, because nothing resolves the sender to a record. An employee texting
-- "paid LKR 45,000 to Acme for cement" is asked for a delivery address. Fixing that safely requires
-- identity to come from TRUSTED RECORDS — never from the wording of the message, which an attacker
-- controls entirely.
--
-- DESIGN
--   * `channel_identities` maps (company, channel, normalised identity) -> (actor_type, actor_id).
--     A row is an assertion by the business that this phone number or address IS that party.
--   * Normalisation is deterministic and lives in the database, so the app cannot drift from it:
--     phone-like channels reduce to digits only; email lower-cases and trims.
--   * Resolution FAILS CLOSED. Exactly one match resolves; zero matches is `unknown`; more than one
--     is `ambiguous`. Neither of the latter may ever be treated as staff.
--   * Matching is exact on the normalised identity first. A secondary national-suffix match (last 9
--     digits) covers the common local-vs-international format difference, and is ALSO required to be
--     unique — a suffix that matches two parties is ambiguous, not a guess.
--   * Backfilled from the phone/email columns already held on profiles, customers and suppliers, so
--     existing data participates without re-entry. `verified_at` stays NULL for backfilled rows:
--     they are asserted, not verified, and the distinction is preserved for later hardening.

begin;

create or replace function public.normalize_channel_identity(p_channel text, p_raw text)
returns text
language sql
immutable
set search_path = pg_catalog, extensions, public, pg_temp
as $$
  select case
    when p_raw is null or btrim(p_raw) = '' then null
    when lower(btrim(p_channel)) in ('whatsapp', 'sms', 'phone', 'voice')
      then nullif(regexp_replace(p_raw, '[^0-9]', '', 'g'), '')
    when lower(btrim(p_channel)) = 'email'
      then nullif(lower(btrim(p_raw)), '')
    else nullif(lower(btrim(p_raw)), '')
  end;
$$;

create table if not exists public.channel_identities (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  channel       text not null check (channel in ('whatsapp', 'email', 'sms', 'phone', 'voice')),
  identity      text not null,                 -- normalised; see normalize_channel_identity
  actor_type    text not null check (actor_type in ('staff', 'customer', 'supplier')),
  actor_id      uuid not null,                 -- profiles.id | customers.id | suppliers.id
  display_name  text,
  verified_at   timestamptz,                   -- NULL = asserted (e.g. backfilled), not verified
  created_at    timestamptz not null default now(),
  created_by    uuid
);

-- One party per identity per channel per company. This is what makes "exactly one match" meaningful.
create unique index if not exists channel_identities_unique_idx
  on public.channel_identities (company_id, channel, identity);

-- Suffix lookup for the local-vs-international format difference.
create index if not exists channel_identities_suffix_idx
  on public.channel_identities (company_id, channel, right(identity, 9));

alter table public.channel_identities enable row level security;

-- Readable by a member of the company; written only by the service boundary. Identity mappings
-- decide whether a sender is treated as staff, so a self-service insert would be privilege
-- escalation by data entry.
drop policy if exists channel_identities_read on public.channel_identities;
create policy channel_identities_read on public.channel_identities
  for select using (public.has_company_access(company_id));

-- Supabase's default privileges grant INSERT/UPDATE/DELETE on every new table to `authenticated`.
-- An identity mapping decides whether a sender is treated as STAFF, so a member-writable mapping
-- would be privilege escalation by data entry. Writes are service-only; reads stay under RLS.
revoke insert, update, delete, truncate on public.channel_identities from anon, authenticated;
grant select on public.channel_identities to authenticated;
grant all on public.channel_identities to service_role;

-- ── Backfill from records the business already holds ────────────────────────────────────────────
insert into public.channel_identities (company_id, channel, identity, actor_type, actor_id, display_name)
select p.company_id, 'whatsapp', public.normalize_channel_identity('whatsapp', p.phone), 'staff', p.id, p.full_name
  from public.profiles p
 where public.normalize_channel_identity('whatsapp', p.phone) is not null
   and p.is_active
on conflict (company_id, channel, identity) do nothing;

insert into public.channel_identities (company_id, channel, identity, actor_type, actor_id, display_name)
select c.company_id, 'whatsapp', public.normalize_channel_identity('whatsapp', c.phone), 'customer', c.id, c.name
  from public.customers c
 where public.normalize_channel_identity('whatsapp', c.phone) is not null
on conflict (company_id, channel, identity) do nothing;

insert into public.channel_identities (company_id, channel, identity, actor_type, actor_id, display_name)
select s.company_id, 'whatsapp', public.normalize_channel_identity('whatsapp', s.phone), 'supplier', s.id, s.name
  from public.suppliers s
 where public.normalize_channel_identity('whatsapp', s.phone) is not null
on conflict (company_id, channel, identity) do nothing;

insert into public.channel_identities (company_id, channel, identity, actor_type, actor_id, display_name)
select c.company_id, 'email', public.normalize_channel_identity('email', c.email), 'customer', c.id, c.name
  from public.customers c
 where public.normalize_channel_identity('email', c.email) is not null
on conflict (company_id, channel, identity) do nothing;

insert into public.channel_identities (company_id, channel, identity, actor_type, actor_id, display_name)
select s.company_id, 'email', public.normalize_channel_identity('email', s.email), 'supplier', s.id, s.name
  from public.suppliers s
 where public.normalize_channel_identity('email', s.email) is not null
on conflict (company_id, channel, identity) do nothing;

-- ── Resolver: exactly one match, or fail closed ────────────────────────────────────────────────
create or replace function public.resolve_channel_identity(
  p_company uuid,
  p_channel text,
  p_raw_identity text
)
returns table (actor_type text, actor_id uuid, display_name text, match text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_norm  text;
  v_count int;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'resolve_channel_identity is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if p_company is null then
    raise exception 'p_company is required — identity is never resolved across companies';
  end if;

  v_norm := public.normalize_channel_identity(p_channel, p_raw_identity);
  if v_norm is null then
    return query select 'unknown'::text, null::uuid, null::text, 'empty'::text;
    return;
  end if;

  -- 1. Exact match on the normalised identity.
  select count(*) into v_count
    from public.channel_identities ci
   where ci.company_id = p_company and ci.channel = p_channel and ci.identity = v_norm;

  if v_count = 1 then
    return query
      select ci.actor_type, ci.actor_id, ci.display_name, 'exact'::text
        from public.channel_identities ci
       where ci.company_id = p_company and ci.channel = p_channel and ci.identity = v_norm;
    return;
  elsif v_count > 1 then
    -- The unique index makes this unreachable today; kept so a future schema change fails closed
    -- rather than silently picking a row.
    return query select 'ambiguous'::text, null::uuid, null::text, 'exact_multiple'::text;
    return;
  end if;

  -- 2. National-suffix match, which must ALSO be unique.
  if length(v_norm) >= 9 then
    select count(*) into v_count
      from public.channel_identities ci
     where ci.company_id = p_company and ci.channel = p_channel
       and right(ci.identity, 9) = right(v_norm, 9);

    if v_count = 1 then
      return query
        select ci.actor_type, ci.actor_id, ci.display_name, 'suffix'::text
          from public.channel_identities ci
         where ci.company_id = p_company and ci.channel = p_channel
           and right(ci.identity, 9) = right(v_norm, 9);
      return;
    elsif v_count > 1 then
      return query select 'ambiguous'::text, null::uuid, null::text, 'suffix_multiple'::text;
      return;
    end if;
  end if;

  return query select 'unknown'::text, null::uuid, null::text, 'no_match'::text;
end;
$$;

revoke all on function public.resolve_channel_identity(uuid, text, text) from public, anon, authenticated;
revoke all on function public.normalize_channel_identity(text, text) from public, anon, authenticated;
grant execute on function public.resolve_channel_identity(uuid, text, text) to service_role;
grant execute on function public.normalize_channel_identity(text, text) to service_role;

do $$
declare bad text;
begin
  -- Table privileges: no untrusted write path may survive this migration.
  select string_agg(priv, ', ') into bad
    from (
      select 'channel_identities:' || r.rolname || ':' || pr.privilege as priv
        from (values ('anon'), ('authenticated')) as r(rolname)
        cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as pr(privilege)
       where has_table_privilege(r.rolname, 'public.channel_identities', pr.privilege)
    ) x;
  if bad is not null then
    raise exception '0070 fail-closed: untrusted write privilege remains — %', bad;
  end if;

  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('resolve_channel_identity', 'normalize_channel_identity')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if bad is not null then
    raise exception '0070 fail-closed: % reachable by anon/authenticated', bad;
  end if;
end $$;

commit;
