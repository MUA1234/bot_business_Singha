-- 0049_wp17_system_actor.sql
-- Correction brief 0048 — WP17: make the system-actor path explicit.
--
-- Problem: `_resolve_actor(p_by)` (migration 0044) records a caller-supplied `p_by` as the
-- actor when `auth.uid()` is null (the service/worker path). A background worker could
-- therefore stamp an ARBITRARY HUMAN identity into the ledger's `posted_by` and the audit
-- trail's `actor_id`, tagged `actor_type = 'system'` — an impersonation hole (invariant:
-- "service workers must be explicitly identified as system actors and must not impersonate
-- an arbitrary user ID").
--
-- Fix: on the service/worker path (no JWT), IGNORE the caller-supplied `p_by` entirely and
-- record a NULL human actor with `actor_type = 'system'`. Traceability comes from the audit
-- row's idempotency_key / correlation, not a spoofable human id. The authenticated-user path
-- is unchanged (actor derived from `auth.uid()`; a mismatched `p_by` is still rejected), and
-- anonymous callers are still rejected.
--
-- Forward-only; CREATE OR REPLACE of a single function. No data change. No behaviour change
-- for authenticated user RPCs. Every posting RPC (post_manual_journal, post_customer_invoice,
-- post_supplier_bill, settle_*, reimburse_*) derives its actor from this function, so the fix
-- applies uniformly.

create or replace function public._resolve_actor(p_by uuid, out v_actor uuid, out v_type text)
language plpgsql stable set search_path = public as $$
begin
  if public.caller_jwt_role() = 'anon' then
    raise exception 'anonymous callers are not allowed';
  end if;
  if auth.uid() is not null then
    -- Authenticated user: actor is auth.uid(); a supplied p_by must match (no spoofing).
    if p_by is not null and p_by <> auth.uid() then
      raise exception 'actor mismatch: p_by does not match the authenticated user';
    end if;
    v_actor := auth.uid();
    v_type  := 'user';
  else
    -- Service/worker path (no JWT). Do NOT trust a caller-supplied human id: ignore p_by and
    -- record a null human actor tagged as system. This makes worker impersonation of a human
    -- in the ledger/audit trail impossible.
    v_actor := null;
    v_type  := 'system';
  end if;
end $$;
