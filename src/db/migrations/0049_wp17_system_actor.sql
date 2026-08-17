-- 0049_wp17_system_actor.sql
-- Correction brief 0048 — WP17: make the system-actor path explicit and trust-bounded.
--
-- Problem: `_resolve_actor(p_by)` (migration 0044) recorded a caller-supplied `p_by` as the
-- actor whenever `auth.uid()` was null, treating ANY "no JWT" caller as a trusted worker.
-- That is a weak trust boundary: missing/malformed claims, or an unknown role, silently
-- obtained the system path, and a worker could stamp an arbitrary human identity into the
-- ledger (`posted_by`) and audit trail (`actor_id`) while tagging it `actor_type='system'`.
--
-- Fix: the system path is available ONLY to an explicit `service_role` JWT. Everything else
-- is rejected (fail-closed):
--   * role = 'service_role'  → actor_type='system', actor_id=NULL, caller-supplied p_by ignored;
--   * role = 'authenticated' → must carry a subject (sub); actor = sub; a mismatched p_by is
--                              rejected (no spoofing);
--   * missing claims, malformed claims, anon, or any unknown/absent role → rejected.
-- EXECUTE is revoked from PUBLIC (only the SECURITY DEFINER posting RPCs, owned by the
-- definer, call it internally).
--
-- Forward-only; CREATE OR REPLACE of one function + a REVOKE. No data change. The
-- authenticated-user posting path is unchanged. Every posting RPC (post_manual_journal,
-- post_customer_invoice, post_supplier_bill, settle_*, reimburse_*) derives its actor from
-- this function, so the boundary applies uniformly.

create or replace function public._resolve_actor(p_by uuid, out v_actor uuid, out v_type text)
language plpgsql stable set search_path = public as $$
declare
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_json   json;
  v_role   text;
  v_sub    text;
begin
  -- Fail-closed: a call with no JWT claims at all is never trusted.
  if v_claims is null then
    raise exception 'access denied: missing JWT claims';
  end if;
  -- Malformed claims are rejected with a clean error, not a raw cast failure.
  begin
    v_json := v_claims::json;
  exception when others then
    raise exception 'access denied: malformed JWT claims';
  end;
  v_role := v_json ->> 'role';
  v_sub  := nullif(v_json ->> 'sub', '');

  if v_role = 'service_role' then
    -- Trusted system/worker path — ONLY an explicit service_role. Ignore any caller-supplied
    -- p_by; record no human actor. Traceability comes from the audit idempotency/correlation.
    v_actor := null;
    v_type  := 'system';
  elsif v_role = 'authenticated' then
    -- Authenticated user MUST carry a subject; the actor is derived from it (no spoofing).
    if v_sub is null then
      raise exception 'access denied: authenticated caller without a subject';
    end if;
    if p_by is not null and p_by <> v_sub::uuid then
      raise exception 'actor mismatch: p_by does not match the authenticated user';
    end if;
    v_actor := v_sub::uuid;
    v_type  := 'user';
  else
    -- anon, unknown role, or absent role → rejected.
    raise exception 'access denied: caller role % is not permitted', coalesce(v_role, '(none)');
  end if;
end $$;

-- The resolver is an internal primitive: only the SECURITY DEFINER posting RPCs (running as
-- their definer/owner) may call it. Keep it unavailable to anon/authenticated callers.
revoke execute on function public._resolve_actor(uuid) from public;
