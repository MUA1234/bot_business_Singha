-- 0079 — hand a leased dispatch back instead of burning it (remediation R1 §3, OF-001).
--
-- The scheduled drain claims a bounded batch and works within a deadline. When the deadline arrives
-- with items still unprocessed, holding their leases until expiry would stall them for the whole
-- lease window, and reporting them as failures would consume attempts they never used — a drain
-- that runs slightly long would dead-letter healthy work.
--
-- `release_inbound_dispatch` is the third outcome: the receipt goes back to `pending`, the lease is
-- cleared, and the attempt is GIVEN BACK, so the next run picks it up as if it had never been
-- claimed. It is the dispatch-lifecycle twin of `release_source_event` (0077).

begin;

create or replace function public.release_inbound_dispatch(p_event uuid, p_owner text)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v record;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'release_inbound_dispatch is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  select s.id, s.dispatch_state, s.dispatch_owner, s.dispatch_attempts
    into v from public.source_events s where s.id = p_event for update;
  if not found then raise exception 'source event % not found', p_event; end if;

  -- A settled receipt is not released. Only work still in flight can be handed back.
  if v.dispatch_state is distinct from 'dispatching' then return false; end if;
  if v.dispatch_owner is distinct from p_owner then
    raise exception 'dispatch lease is held by a different worker' using errcode = 'lock_not_available';
  end if;

  update public.source_events
     set dispatch_state = 'pending',
         dispatch_owner = null,
         dispatch_lease_expires_at = null,
         -- The attempt is returned: the drain ran out of time, the receipt did not misbehave.
         dispatch_attempts = greatest(0, coalesce(v.dispatch_attempts, 1) - 1)
   where id = p_event;
  return true;
end;
$$;

revoke all on function public.release_inbound_dispatch(uuid, text) from public, anon, authenticated;
grant execute on function public.release_inbound_dispatch(uuid, text) to service_role;

do $$
begin
  if has_function_privilege('anon', 'public.release_inbound_dispatch(uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.release_inbound_dispatch(uuid,text)', 'EXECUTE') then
    raise exception '0079 fail-closed: release_inbound_dispatch is reachable by an untrusted role';
  end if;
end $$;

commit;
