-- 0084 — FOUND-006: a caller's database PRIVILEGE decides service authority, never its request text.
--
-- THE PRINCIPLE. PostgreSQL grants and role membership are privilege. `request.jwt.claims` is
-- request METADATA that any caller holding the role can set with `set_config`. A function that
-- converts a claimed JWT role into service authority is therefore trusting the caller to describe
-- their own privilege. Migration 0083 closed the unauthenticated half of the one place that did so
-- and left the predicate, because neither available primitive could identify the caller inside a
-- SECURITY DEFINER body. This migration removes the predicate by changing the ARCHITECTURE.
--
-- WHAT WAS PROVEN FIRST, on a disposable local PostgreSQL, under the real PostgREST role pattern
-- (connect as `authenticator`, `SET LOCAL ROLE authenticated` / `service_role`):
--
--   context                     current_user        session_user
--   SECURITY DEFINER body       postgres (OWNER)    authenticator
--   SECURITY INVOKER body       authenticated       authenticator
--   SECURITY INVOKER trigger    authenticated       authenticator
--
-- So inside a DEFINER body `current_user` is the owner and says nothing about the caller, and
-- `session_user` is `authenticator` in EVERY request — and Supabase grants `authenticator`
-- membership of `service_role`, so `pg_has_role(session_user, 'service_role', 'MEMBER')` would have
-- been true for every ordinary web request. Both rejected primitives are rejected on evidence.
--
-- What IS provable: inside a SECURITY INVOKER body, `current_user` is the caller's effective role,
-- and `has_function_privilege(current_user, '<service-only fn>', 'EXECUTE')` is a database
-- privilege the caller either holds or does not. Measured: `authenticated` → false,
-- `service_role` → true. That is the signal this migration uses.
--
-- WHAT THIS DOES NOT SOLVE, and must not be claimed to. `anon`, `authenticated` and `service_role`
-- are SHARED database roles. A caller who can execute ARBITRARY SQL as `authenticated` can forge
-- `sub` and therefore `auth.uid()`, and so impersonate any user to every RLS policy. That is a
-- property of the shared-role architecture, not of any helper's name, and it is out of the
-- supported client boundary unless the design moves to per-user database identity or
-- cryptographically verified claims. See docs/architecture-v2/FOUND_006_TRUST_MODEL.md.

begin;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (1) The quotation status read, split into three by privilege
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- SHARED IMPLEMENTATION — reachable by NO api role. It carries no authorization at all, so it can
-- only ever run inside a wrapper that already established one, or from another function owned by
-- the same owner (the WP12 delivery RPCs).
create or replace function public._quotation_status_read(p_company uuid, p_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare v_status text;
begin
  -- FOR UPDATE is the reason this function exists: migration 0067 added the lock to close an
  -- unlocked parent-status read that raced the atomic enqueue. Keep it.
  select q.status into v_status
    from public.quotations q
   where q.id = p_id and q.company_id = p_company
   for update;
  return v_status;
end;
$$;
revoke all on function public._quotation_status_read(uuid, uuid) from public, anon, authenticated, service_role;

-- THE HUMAN PATH — authorization is the CAPABILITY, and the grant is `authenticated` only.
create or replace function public.quotation_status_for_capable(p_company uuid, p_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if not public.has_capability(p_company, 'sales.quotation.manage') then
    return null;   -- fail closed: the caller is not classified, and the trigger refuses on null
  end if;
  return public._quotation_status_read(p_company, p_id);
end;
$$;
revoke all on function public.quotation_status_for_capable(uuid, uuid) from public, anon, service_role;
grant execute on function public.quotation_status_for_capable(uuid, uuid) to authenticated;

-- THE SERVICE PATH — there is NO branch inside it. The EXECUTE GRANT is the authorization, which is
-- the whole point: a caller holding the `authenticated` role cannot execute this however its JWT
-- text reads, and a caller holding `service_role` can even if its JWT text says `authenticated`.
create or replace function public.quotation_status_for_service(p_company uuid, p_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  return public._quotation_status_read(p_company, p_id);
end;
$$;
revoke all on function public.quotation_status_for_service(uuid, uuid) from public, anon, authenticated;
grant execute on function public.quotation_status_for_service(uuid, uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (2) The freeze trigger chooses by PRIVILEGE HELD, in the one context where the caller is knowable
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.quotation_items_enforce_frozen()
returns trigger
language plpgsql
set search_path = pg_catalog, extensions, public, pg_temp   -- SECURITY INVOKER (the default)
as $$
declare s_new text; s_old text; v_is_service boolean;
begin
  if public._is_quotation_delivery_owner() then
    return coalesce(new, old);  -- trusted maintenance override, unchanged
  end if;

  -- SECURITY INVOKER, so `current_user` IS the caller's effective role — proven under the PostgREST
  -- pattern, where a DEFINER body would have seen the owner and `session_user` would have seen
  -- `authenticator` for every request alike. `has_function_privilege` asks whether the caller holds
  -- a GRANT, which no amount of request metadata can change.
  v_is_service := pg_catalog.has_function_privilege(
    current_user, 'public.quotation_status_for_service(uuid,uuid)', 'EXECUTE');

  -- IF/ELSE with SEPARATE assignments, deliberately, not a CASE expression. PL/pgSQL plans a
  -- statement on first execution and PostgreSQL ACL-checks EVERY function referenced in that plan —
  -- including the branch that will not be taken. A `case when v_is_service then service(...) else
  -- capable(...) end` therefore raised `permission denied for function
  -- quotation_status_for_service` for an authenticated caller that had correctly chosen the capable
  -- branch. Two statements are two plans, and only the executed one is planned.
  if tg_op in ('INSERT','UPDATE') then
    if v_is_service then
      s_new := public.quotation_status_for_service(new.company_id, new.quotation_id);
    else
      s_new := public.quotation_status_for_capable(new.company_id, new.quotation_id);
    end if;
    if s_new is null then
      raise exception 'quotation_items % refused: caller holds neither sales.quotation.manage for quotation % nor the service grant — fail closed (WP12 snapshot immutability)',
        tg_op, new.quotation_id using errcode = 'insufficient_privilege';
    end if;
    if s_new in ('queued','sent','accepted','rejected') then
      raise exception 'quotation_items % refused: parent quotation % is frozen (status %) (WP12 snapshot immutability)',
        tg_op, new.quotation_id, s_new using errcode = 'insufficient_privilege';
    end if;
  end if;

  if tg_op in ('UPDATE','DELETE') then
    if v_is_service then
      s_old := public.quotation_status_for_service(old.company_id, old.quotation_id);
    else
      s_old := public.quotation_status_for_capable(old.company_id, old.quotation_id);
    end if;
    if s_old is null then
      raise exception 'quotation_items % refused: caller holds neither sales.quotation.manage for quotation % nor the service grant — fail closed (WP12 snapshot immutability)',
        tg_op, old.quotation_id using errcode = 'insufficient_privilege';
    end if;
    if s_old in ('queued','sent','accepted','rejected') then
      raise exception 'quotation_items % refused: parent quotation % is frozen (status %) (WP12 snapshot immutability)',
        tg_op, old.quotation_id, s_old using errcode = 'insufficient_privilege';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

-- The claim-branch function is GONE, not merely unreferenced.
drop function if exists public._quotation_status_for_guard(uuid, uuid);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (3) Internal helpers lose API-role EXECUTE they never needed
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Verified before revoking: NO SECURITY INVOKER function in `public` calls either of these, so every
-- caller is a DEFINER body running as its owner. An api role holding EXECUTE on them bought nothing
-- and widened the surface for no purpose.
revoke all on function public.caller_jwt_role() from public, anon, authenticated;
revoke all on function public._resolve_actor(uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (4) Fail closed on the invariant this migration establishes
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- No SECURITY DEFINER function reachable by `anon` or `authenticated` may contain a PERMISSIVE
-- `caller_jwt_role() = 'service_role'` branch — that is the exact shape that let request text stand
-- in for privilege. A RESTRICTIVE use (refusing when the claim says service_role, as
-- `route_task_as_human` does) is fine and is not matched here.
do $$
declare v_bad text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     and p.prosrc ~ 'or\s+public\.caller_jwt_role\(\)\s*=\s*''service_role''';
  if v_bad is not null then
    raise exception '0084: SECURITY DEFINER functions reachable by an api role still convert a JWT claim into service authority: %', v_bad;
  end if;
end $$;

commit;
