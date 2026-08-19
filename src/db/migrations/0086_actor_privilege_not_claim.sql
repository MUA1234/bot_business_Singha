-- 0086_actor_privilege_not_claim.sql
-- FOUND-006 correction loop 2 — G-01 (P0). Independent security review 2.
--
-- WHAT WAS BROKEN
-- ---------------
-- `_resolve_actor(p_by)` (migration 0049, WP17) read `request.jwt.claims` directly and converted
-- the CLAIMED role into AUTHORITY:
--
--     if v_role = 'service_role' then v_actor := null; v_type := 'system';
--
-- Nine SECURITY DEFINER finance RPCs — every one EXECUTE-able by `authenticated` — then gated
-- their capability check on that value:
--
--     if v_type = 'user' and not public.has_capability(p_company,'finance.journal.post') then raise
--
-- so `v_type = 'system'` SKIPPED the capability check entirely. Reproduced on a disposable local
-- PostgreSQL 16 from a genuine login role that is a member of `authenticated` and NOTHING else
-- (`pg_has_role(current_user,'service_role','MEMBER')` = false, `pg_has_role(session_user, …)` =
-- false — no SET ROLE, this is NOT OF-017):
--
--     set local role authenticated;
--     -- honest claim: ERROR: missing capability finance.journal.post
--     select set_config('request.jwt.claims','{"role":"service_role"}',true);
--     select public.post_manual_journal(…);   -- posted 999,999.0000, status 'posted', posted_by NULL
--
-- The same forgery defeated the supplier bank-change maker-checker: the system path sets
-- `v_actor := null`, and the separation-of-duties test `v_requested_by = v_actor` is never true
-- against NULL, so one unprivileged caller could both request and approve a bank-detail change.
--
-- Pre-existing (reproduces identically at 0083), so 0084/0085 did not introduce it — but this is
-- the package chartered to close exactly this class, and its precondition is context 5 of the
-- package's own threat model ("arbitrary SQL under the shared `authenticated` role"). Migration
-- 0084 revoked EXECUTE on `_resolve_actor` from anon/authenticated, which reads like remediation
-- and is not: the function is only ever called from SECURITY DEFINER bodies running as the owner,
-- so the revoke changed nothing while the claim-to-authority conversion stayed live through them.
--
-- CLAUDE.md financial controls: "Material journals are posted only by a human-initiated,
-- permission-checked, transactional path."
--
-- THE FIX
-- -------
-- Delete the branch. There is no role test left, so no claim value can select a privileged path.
-- The actor is the authenticated SUBJECT and the type is ALWAYS 'user', which makes the nine RPCs'
-- existing `if v_type='user' and not has_capability(…)` gate unconditional without touching one
-- line of their bodies — the fix lands at the single point all nine already share, which is where
-- migration 0075 put this kind of rule for exactly this reason ("two drift, so the rule moves
-- here").
--
-- Why not a human/service split here: the split IS the right pattern (0084 used it), but it is
-- only worth its cost where a service caller exists. There is none. `supabaseRpcClient()` — the
-- only client any of the nine is called through — is documented as "ALWAYS the authenticated
-- client … NEVER routes a user-initiated financial RPC through the service role", no worker,
-- accounting-core module or other database function calls any of the nine, and posting a material
-- journal with no human and no permission check is what the financial control above forbids. So
-- the system path is removed rather than re-granted. If a genuine service caller is ever needed,
-- it gets a `service_role`-granted sibling entrypoint per 0084's pattern — never a claim branch.
--
-- Identity still comes from the `sub` claim (via `auth.uid()`'s inputs). That is IMPERSONATION,
-- the known and documented inherent residual under this topology (OF-014 residual), and it is
-- strictly smaller than what is fixed here: an impersonator must know a real privileged user's
-- id AND that user must genuinely hold the capability, which is then checked for real. Before
-- this migration, no capability was needed at all.
--
-- Forward-only. One CREATE OR REPLACE, no data change, no grant change.

begin;

-- ── The single point of truth: a claim never selects a branch ────────────────────────────────
create or replace function public._resolve_actor(p_by uuid, out v_actor uuid, out v_type text)
language plpgsql
stable
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_claims text := nullif(pg_catalog.current_setting('request.jwt.claims', true), '');
  v_json   json;
  v_sub    text;
begin
  -- Fail-closed: a call with no JWT claims at all is never trusted.
  if v_claims is null then
    raise exception 'access denied: missing JWT claims'
      using errcode = 'insufficient_privilege';
  end if;
  begin
    v_json := v_claims::json;
  exception when others then
    raise exception 'access denied: malformed JWT claims'
      using errcode = 'insufficient_privilege';
  end;

  -- NO role test. There is deliberately no branch here for any claimed role, so there is nothing
  -- for a forged `role` to select. A caller that reached this point did so by holding EXECUTE on a
  -- SECURITY DEFINER entrypoint; that grant is the authority, and the capability check in the
  -- entrypoint decides what the named human may actually do.
  v_sub := nullif(v_json ->> 'sub', '');
  if v_sub is null then
    raise exception 'access denied: caller without a subject — this entrypoint is human-only'
      using errcode = 'insufficient_privilege';
  end if;
  begin
    v_actor := v_sub::uuid;
  exception when others then
    raise exception 'access denied: malformed subject'
      using errcode = 'insufficient_privilege';
  end;

  -- A caller may not stamp somebody else's identity into the ledger or the audit trail.
  if p_by is not null and p_by <> v_actor then
    raise exception 'actor mismatch: p_by does not match the authenticated user'
      using errcode = 'insufficient_privilege';
  end if;

  -- INVARIANT: 'user' and nothing else. Every caller's `v_type='user' and not has_capability(…)`
  -- gate is therefore unconditional.
  v_type := 'user';
end
$$;

revoke all on function public._resolve_actor(uuid) from public, anon, authenticated;

-- ── Fail closed: prove the branch is gone, in this transaction, before committing ────────────
do $$
declare
  v_actor uuid;
  v_type  text;
  v_ok    boolean := false;
begin
  -- A forged service_role claim carrying no subject must now be REFUSED, not promoted.
  perform pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin
    select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(null) a;
  exception when others then
    v_ok := true;
  end;
  if not v_ok then
    raise exception '0086 fail-closed: a forged service_role claim still resolves (actor=%, type=%)',
      v_actor, v_type;
  end if;

  -- A forged service_role claim carrying a subject resolves to that HUMAN — never to 'system'.
  perform pg_catalog.set_config(
    'request.jwt.claims',
    '{"role":"service_role","sub":"00000000-0000-0000-0000-0000000000aa"}', true);
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(null) a;
  if v_type <> 'user' or v_actor is null then
    raise exception '0086 fail-closed: claim text still selects a non-user actor (actor=%, type=%)',
      v_actor, v_type;
  end if;

  perform pg_catalog.set_config('request.jwt.claims', '', true);
end
$$;

-- ── The invariant 0085 could not express: TRANSITIVE claim reachability ──────────────────────
-- 0085 asserted over SECURITY DEFINER functions whose OWN body mentions `caller_jwt_role`. That
-- cannot see this defect and never could: `_resolve_actor` is SECURITY INVOKER (outside the
-- population entirely) and the nine callers name neither `caller_jwt_role` nor `current_setting`.
-- Review 2 also demonstrated two evasions of the source-text form — dynamic SQL assembling the
-- helper name, and reading the GUC directly.
--
-- So the invariant is restated over the CALL GRAPH: every api-reachable SECURITY DEFINER function
-- that can reach claim text by any path must be on a reviewed allowlist. That does not, and
-- cannot, prove those functions use claims safely — a function may legitimately derive IDENTITY
-- from `sub`. What it guarantees is that the set cannot GROW silently: a new api-reachable
-- definer function that touches claim text fails this assertion and the permanent test gate until
-- a person adds it deliberately.
do $$
declare
  v_unexpected text;
  v_missing    text;
  v_allowed    text[] := array[
    -- RLS/identity helpers: derive the caller's identity from `sub`; they grant no authority.
    'authority_ceiling(uuid,text)',
    'has_capability(uuid,text)',
    'has_company_access(uuid)',
    'has_membership(uuid)',
    'has_permission(uuid,text)',
    'is_admin()',
    'my_company()',
    'my_department()',
    'within_authority(uuid,text,numeric,text)',
    'within_authority_for_event(uuid,uuid)',
    -- RESTRICTIVE claim use: these refuse a service context outright (verified by execution).
    'decide_approval(uuid,uuid,text,text)',
    'route_task_as_human(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid)',
    -- Capability-gated read (0084 split).
    'quotation_status_for_capable(uuid,uuid)',
    -- The nine finance entrypoints. Human-only as of THIS migration: identity from `sub`,
    -- capability check unconditional.
    'decide_supplier_bank_change(uuid,uuid,text,uuid,text)',
    'post_customer_invoice(uuid,uuid,text,text,uuid,date,text)',
    'post_manual_journal(uuid,date,text,text,uuid,jsonb,text)',
    'post_supplier_bill(uuid,uuid,text,text,uuid,date,text)',
    'reimburse_expense_claim(uuid,uuid,text,text,uuid,date,text)',
    'request_supplier_bank_change(uuid,uuid,text,text,uuid)',
    'reverse_journal(uuid,uuid,uuid,date,text)',
    'settle_customer_invoice(uuid,uuid,numeric,text,text,uuid,date,text)',
    'settle_supplier_bill(uuid,uuid,numeric,text,text,uuid,date,text)'
  ];
begin
  create temporary table if not exists _0086_reach (sig text) on commit drop;
  delete from _0086_reach;

  insert into _0086_reach (sig)
  with recursive
  seed as (
    select p.oid
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'auth')
       and (p.prosrc like '%request.jwt%' or p.prosrc like '%current_setting%')
  ),
  -- Call graph, approximated by "the caller's body names the callee and opens a paren". Crude in
  -- the safe direction: it over-approximates edges, so it cannot MISS a caller.
  edges as (
    select c.oid as caller, e.oid as callee
      from pg_catalog.pg_proc c
      join pg_catalog.pg_namespace cn on cn.oid = c.pronamespace and cn.nspname = 'public'
      join pg_catalog.pg_proc e on e.oid <> c.oid
      join pg_catalog.pg_namespace en on en.oid = e.pronamespace and en.nspname in ('public', 'auth')
     where c.prosrc ~ ('(^|[^a-zA-Z0-9_])' || e.proname || '[[:space:]]*\(')
  ),
  closure as (
    select oid from seed
    union
    select ed.caller from edges ed join closure cl on cl.oid = ed.callee
  )
  select p.oid::pg_catalog.regprocedure::text
    from closure c
    join pg_catalog.pg_proc p on p.oid = c.oid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
   where p.prosecdef
     and (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
          or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  -- `regprocedure` renders schema-qualified when `public` is not on the ambient search_path, so
  -- compare on the bare signature rather than on the rendering. (Review 2, G-06: 0085 compared the
  -- rendering and aborted spuriously under `search_path = pg_catalog`.)
  select pg_catalog.string_agg(sig, ', ' order by sig) into v_unexpected
    from (
      select pg_catalog.replace(sig, 'public.', '') as sig from _0086_reach
      except
      select pg_catalog.unnest(v_allowed)
    ) x;
  if v_unexpected is not null then
    raise exception '0086: api-reachable SECURITY DEFINER function(s) can reach JWT claim text and '
                    'are not on the reviewed allowlist: %. Add them deliberately after reviewing '
                    'whether the claim is used for IDENTITY (allowed) or AUTHORITY (not allowed).',
      v_unexpected;
  end if;

  -- Fail closed the other way too: an allowlist entry that no longer exists is stale, and a stale
  -- entry silently pre-approves a function that comes back. (Review 2, G-07.)
  select pg_catalog.string_agg(sig, ', ' order by sig) into v_missing
    from (
      select pg_catalog.unnest(v_allowed) as sig
      except
      select pg_catalog.replace(sig, 'public.', '') from _0086_reach
    ) y;
  if v_missing is not null then
    raise exception '0086: stale allowlist entr(y/ies) — no longer api-reachable claim readers: %. '
                    'Remove them, so the allowlist cannot pre-approve a function that returns.',
      v_missing;
  end if;
end
$$;

comment on function public._resolve_actor(uuid) is
  'FOUND-006/0086: resolves the acting HUMAN from the authenticated subject. There is deliberately '
  'no branch on the claimed role — before 0086 a forged `role=service_role` claim yielded '
  'actor_type=system, which skipped the capability check in all nine finance RPCs and defeated the '
  'bank-change maker-checker. v_type is now always ''user''. A service caller does not belong here: '
  'it gets a service_role-granted sibling entrypoint (0084''s pattern), never a claim branch.';

commit;
