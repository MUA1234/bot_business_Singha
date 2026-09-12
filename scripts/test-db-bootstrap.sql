-- Disposable integration-test database bootstrap.
--
-- The migrations are written for SUPABASE, so they assume objects a plain PostgreSQL 16
-- cluster does not have: the `auth` schema with `auth.users` and `auth.uid()`, the API roles
-- (`anon`, `authenticated`, `service_role`), an `extensions` schema holding pgcrypto, and
-- Supabase's default table grants. Without them `npm run migrate` dies on 0001 with
-- `schema "auth" does not exist`, and with a half-made version the RLS suites fail ~100 tests
-- with `permission denied` / `violates row-level security policy`. Nothing in the repo used
-- to carry this, so every session rediscovered it; it is now one command.
--
--   createdb singha_test
--   psql -d singha_test -v ON_ERROR_STOP=1 -f scripts/test-db-bootstrap.sql
--   DATABASE_URL=postgresql://…/singha_test npm run migrate
--   DATABASE_URL=postgresql://…/singha_test npm run test:integration
--
-- Use a DISPOSABLE database. One integration file (`rpc-concurrency`) commits a posted
-- journal, and posted accounting history is immutable by design, so its company and posting
-- user cannot be cleaned up and accumulate one per run. NEVER point this at production —
-- `rpc-concurrency` also refuses to run when DATABASE_URL matches PRODUCTION_DB_HOST.

create schema if not exists auth;
create schema if not exists extensions;

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  -- service_role bypasses RLS on Supabase; the boundary tests rely on that being true.
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator noinherit login; end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create extension if not exists pgcrypto with schema extensions;

-- USAGE only. Migration 0067 FAILS CLOSED if any API role holds CREATE on public/extensions
-- (it is the `pg_temp` relation-shadowing defence), so granting CREATE here breaks the migration.
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
revoke create on schema public, extensions from anon, authenticated, service_role, public;

-- Supabase grants the API roles access to everything a migration creates. These are DEFAULT
-- privileges, applied as each table is created — which is why this file must run BEFORE the
-- migrations: the migrations' own REVOKEs (0062/0067 lock the SECURITY DEFINER functions to
-- `service_role`) then run afterwards and win, exactly as they do on the hosted project.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

-- Supabase's `auth.users` (migrations FK to it) and the JWT accessors RLS policies call.
create table if not exists auth.users (
  id                 uuid primary key default extensions.gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
grant all on auth.users to anon, authenticated, service_role;

-- PostgREST sets the whole claim set as the JSON `request.jwt.claims`; the older per-claim
-- GUC form is kept first for parity with Supabase's own definition. Reading only one of the
-- two is the subtle failure that makes every RLS write test fail while reads still pass.
create or replace function auth.uid() returns uuid language sql stable as $f$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$f$;

create or replace function auth.role() returns text language sql stable as $f$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$f$;
