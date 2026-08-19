-- 0085 — FOUND-006 correction loop 1. An independent security review returned CHANGES REQUESTED.
--
-- Kept separate from 0084 rather than editing it, so what was reviewed and what the review changed
-- stay separately auditable — the same reason 0077 followed 0076 and 0083 followed 0082.
--
-- F-02 (P2). 0084 asserted that no api-reachable SECURITY DEFINER function converts a JWT claim into
--   service authority, but it asserted it by matching ONE syntactic form —
--   `or public.caller_jwt_role() = 'service_role'` — which is the shape that happened to exist in the
--   function being removed. A bare `if public.caller_jwt_role() = 'service_role' then …` is invisible
--   to it, and so are swapped operands, `in ('service_role')`, `is not distinct from`, and an
--   unqualified call. Demonstrated by the reviewer: a deliberately permissive probe function granted
--   to `authenticated` was NOT flagged.
--
--   The replacement does not try to parse intent out of SQL text. It asserts REACHABILITY against an
--   exact-signature allowlist: an api-reachable SECURITY DEFINER function may reference
--   `caller_jwt_role` only if it is one of the two whose use is RESTRICTIVE — proven by reading them,
--   and re-proven by the tests. Any new one, in any syntax, fails this.

begin;

-- `regprocedure` renders SCHEMA-QUALIFIED whenever `public` is not on the ambient search_path, so
-- an allowlist of bare signatures silently stops matching and this assertion aborts a deployment
-- that is perfectly healthy. A hosted runner, or a role whose default search_path omits `public`,
-- is exactly that case. Pin it for the transaction (0067's doctrine, applied to a DO block —
-- `DO` takes no SET clause of its own), and compare on the bare signature as well, so neither
-- rendering can produce a false alarm. (Security review 2, G-06.)
set local search_path = pg_catalog, extensions, public, pg_temp;

do $$
declare
  -- Compared as `regprocedure` text, NOT `pg_get_function_identity_arguments` — the latter includes
  -- PARAMETER NAMES, so an allowlist written against it never matches. That trap has bitten this
  -- repository before.
  v_allowed text[] := array[
    -- `decide_approval` refuses when the claim says `anon` or `auth.uid()` is null. The claim can
    -- only TIGHTEN: forging `service_role` does not remove the auth.uid() requirement.
    'decide_approval(uuid,uuid,text,text)',
    -- `route_task_as_human` REFUSES a caller whose claim says `service_role`. Forging it makes the
    -- function refuse, which is the safe direction.
    'route_task_as_human(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid)'
  ];
  v_bad text;
begin
  select string_agg(sig, ', ' order by sig) into v_bad
    from (
      select replace(p.oid::regprocedure::text, 'public.', '') as sig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prosecdef
         and (has_function_privilege('anon', p.oid, 'EXECUTE')
              or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
         and p.prosrc like '%caller_jwt_role%'
    ) s
   where s.sig <> all (v_allowed);
  if v_bad is not null then
    raise exception
      '0085: api-reachable SECURITY DEFINER function(s) consult caller_jwt_role outside the restrictive allowlist: %', v_bad;
  end if;
end $$;

commit;
