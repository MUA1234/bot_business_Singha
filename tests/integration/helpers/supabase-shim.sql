-- Supabase-compatibility shim for a DISPOSABLE CI Postgres (WP F.5).
-- Applied ONCE before migrations so the RLS/adversarial/concurrency integration tests can
-- run against a plain Postgres service container instead of a hosted Supabase project.
-- It provides exactly what the migrations + tests depend on: the auth roles, auth.uid()/
-- auth.role() reading request.jwt.claims, and the default grants Supabase gives its roles.
-- NEVER apply this to a real Supabase project (those objects already exist there).

create extension if not exists pgcrypto;

-- Auth roles (service_role bypasses RLS, like Supabase; authenticated is subject to RLS).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

-- Let the migration/test connection SET ROLE to these (no-op for a superuser, needed otherwise).
grant anon, authenticated, service_role to current_user;

create schema if not exists auth;

-- auth.uid(): the 'sub' claim as uuid, or null when there is no JWT / no sub.
create or replace function auth.uid() returns uuid
  language sql stable
as $$ select (nullif(current_setting('request.jwt.claims', true), '')::json->>'sub')::uuid $$;

-- auth.role(): the 'role' claim (authenticated / anon / service_role), or null.
create or replace function auth.role() returns text
  language sql stable
as $$ select nullif(current_setting('request.jwt.claims', true), '')::json->>'role' $$;

grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- Supabase grants its API roles broad table DML and relies on RLS to constrain. Mirror
-- that with DEFAULT PRIVILEGES so every table the migrations create is reachable by
-- 'authenticated' (then RLS + the 0038 REVOKEs on service-only tables constrain it).
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to authenticated, service_role;
alter default privileges in schema public grant execute on functions to authenticated, service_role;
