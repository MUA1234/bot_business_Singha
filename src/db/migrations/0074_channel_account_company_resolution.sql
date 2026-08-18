-- 0074 — resolve the RECEIVING company from trusted channel configuration (FOUND-003).
--
-- WHY: the WhatsApp webhook stamped every inbound message with a hardcoded pilot company constant
-- (`DEFAULT_COMPANY_ID`). In a multi-company system that is not a placeholder, it is a
-- cross-company leak waiting for the second company: every message any business receives would be
-- attributed to the pilot, and CLAUDE.md's "every record must have explicit company scope" would be
-- satisfied only by coincidence.
--
-- The trustworthy routing key is the ACCOUNT THAT RECEIVED the message — for WhatsApp Cloud API,
-- `entry[].changes[].value.metadata.phone_number_id`, which Meta sets and the message sender cannot
-- influence. `channel_accounts` maps that account to exactly one company.
--
-- THE SINGLE-TENANT FALLBACK, stated plainly. A strict resolver applied to a database with no
-- mappings yet would silently stop the running pilot's WhatsApp intake at deploy time. So when — and
-- ONLY when — the channel has NO mappings at all AND the database holds EXACTLY ONE company, the
-- resolver returns that company with match `single_tenant_fallback`. Two properties make this safe
-- rather than a loophole:
--   * with one company, there is no other company to leak to; and
--   * the moment a second company exists, or any mapping is configured for the channel, the fallback
--     stops applying and an unmapped account fails closed to `unmapped`.
-- It is a bridge for an existing single-company deployment, not a default. Configuring the mapping
-- is an owner action, recorded as an owner gate.
--
-- Forward-only, idempotent DDL. No feature flag (a correctness boundary, not a capability).

begin;

-- ── Normalisation ─────────────────────────────────────────────────────────────────────────────
-- The provider account id is an OPAQUE PROVIDER IDENTIFIER (WhatsApp `phone_number_id`, an inbox
-- address), NOT a dialled phone number. It is therefore compared as text, case-insensitively and
-- trimmed — deliberately NOT digit-stripped, because stripping would make the numeric
-- `phone_number_id` and a typed-in display number look interchangeable when they are not.
create or replace function public.normalize_channel_account(p_raw text)
returns text
language sql
immutable
set search_path = pg_catalog, extensions, public, pg_temp
as $$
  select nullif(lower(btrim(coalesce(p_raw, ''))), '');
$$;

create table if not exists public.channel_accounts (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  channel             text not null check (channel in ('whatsapp', 'email', 'sms')),
  -- WhatsApp Cloud API: value.metadata.phone_number_id. Email: the receiving mailbox address.
  provider_account_id text not null,
  -- For humans reading the configuration screen; never used for matching.
  display_label       text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  created_by          uuid
);

-- GLOBAL uniqueness, not per company: one receiving account belongs to exactly ONE company. A
-- company-scoped index would let two companies both claim the same number, which is the leak.
create unique index if not exists channel_accounts_provider_uq
  on public.channel_accounts (channel, provider_account_id)
  where is_active;

alter table public.channel_accounts enable row level security;

drop policy if exists channel_accounts_read on public.channel_accounts;
create policy channel_accounts_read on public.channel_accounts
  for select using (public.has_company_access(company_id));

-- Supabase's default privileges grant INSERT/UPDATE/DELETE on every new table to `authenticated`.
-- This mapping decides WHICH COMPANY owns an inbound message, so a member-writable row would be a
-- cross-company redirection by data entry. Writes are service-only; reads stay under RLS.
revoke insert, update, delete, truncate on public.channel_accounts from anon, authenticated;
grant select on public.channel_accounts to authenticated;
grant all on public.channel_accounts to service_role;

-- ── Resolver: exactly one active mapping, the documented single-tenant bridge, or fail closed ──
create or replace function public.resolve_channel_company(
  p_channel text,
  p_provider_account_id text
)
returns table (company_id uuid, match text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_norm       text;
  v_count      int;
  v_mappings   int;
  v_companies  int;
  v_company    uuid;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'resolve_channel_company is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  v_norm := public.normalize_channel_account(p_provider_account_id);
  if v_norm is null or public.normalize_channel_account(p_channel) is null then
    return query select null::uuid, 'empty'::text;
    return;
  end if;

  select count(*) into v_count
    from public.channel_accounts a
   where a.channel = p_channel and a.provider_account_id = v_norm and a.is_active;

  if v_count = 1 then
    return query
      select a.company_id, 'exact'::text
        from public.channel_accounts a
       where a.channel = p_channel and a.provider_account_id = v_norm and a.is_active;
    return;
  elsif v_count > 1 then
    -- The partial unique index makes this unreachable today; kept so a future schema change fails
    -- closed rather than silently picking a company.
    return query select null::uuid, 'ambiguous'::text;
    return;
  end if;

  -- Single-tenant bridge. Both conditions are required, and either one becoming false disables it.
  select count(*) into v_mappings from public.channel_accounts a where a.channel = p_channel and a.is_active;
  if v_mappings = 0 then
    select count(*) into v_companies from public.companies;
    if v_companies = 1 then
      select c.id into v_company from public.companies c;
      return query select v_company, 'single_tenant_fallback'::text;
      return;
    end if;
  end if;

  return query select null::uuid, 'unmapped'::text;
end;
$$;

revoke all on function public.resolve_channel_company(text, text) from public, anon, authenticated;
revoke all on function public.normalize_channel_account(text) from public, anon, authenticated;
grant execute on function public.resolve_channel_company(text, text) to service_role;
grant execute on function public.normalize_channel_account(text) to service_role;

do $$
declare bad text;
begin
  select string_agg(priv, ', ') into bad
    from (
      select 'channel_accounts:' || r.rolname || ':' || pr.privilege as priv
        from (values ('anon'), ('authenticated')) as r(rolname)
        cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as pr(privilege)
       where has_table_privilege(r.rolname, 'public.channel_accounts', pr.privilege)
    ) x;
  if bad is not null then
    raise exception '0074 fail-closed: untrusted write privilege remains — %', bad;
  end if;

  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('resolve_channel_company', 'normalize_channel_account')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if bad is not null then
    raise exception '0074 fail-closed: % reachable by anon/authenticated', bad;
  end if;
end $$;

commit;
