-- 0082 — the database half of R1 review loop 1.
--
-- An independent adversarial review of the remediation package returned CHANGES REQUESTED with two
-- P0 findings and twelve smaller ones. Three of them are enforceable only at the database, and each
-- was reproduced on a disposable local PostgreSQL before being accepted.
--
-- R-02 (P0). `processSourceEvent` documents "idempotency is guaranteed upstream: the Inngest
--   function keys on the source_event_id so this runs at most once per event". R1 §4 wired a SECOND
--   caller — the sweeper — which retries the same event up to five times, and `createDraft` is an
--   unconditional INSERT with no uniqueness on `financial_events.source_event_id`. Any failure
--   AFTER the draft duplicated the financial event. Observed: one captured payment, one downstream
--   failure, one successful retry → TWO `awaiting_approval` drafts for LKR 45,000, the first
--   orphaned with no approval request. CLAUDE.md: "A duplicate event must never create a duplicate
--   task, receipt, payment, reimbursement or ledger entry."
--
-- R-03 (P1). `task_routing_provenance_guard` deliberately left `is_active` and `superseded_by`
--   writable so supersession works, and `service_role` holds table-level UPDATE/DELETE. An
--   automated caller therefore never needed to forge provenance: it could deactivate the standing
--   HUMAN decision and then route again as AI. Observed: `update task_routing set is_active=false`
--   → UPDATE 1, then `route_task_as_ai` succeeded where it had correctly refused a moment earlier.
--   `delete from task_routing` also succeeded, so a decision was not append-only either.
--
-- R-13 (P2). Migration 0081 had no `begin;`/`commit;` of its own, unlike 0078–0080. The runner
--   wraps each file, but the disposable-database scripts and the documented hosted-hotfix path use
--   `psql -f`, where a failure in the closing fail-closed check would leave the change committed.
--   Fixed in 0081 itself; noted here so the sequence tells the whole story.

begin;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (1) R-02 — one drafted financial event per source event, enforced by the database
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Fail closed if the invariant is already broken, rather than creating an index that silently
-- cannot be built or, worse, quietly picking a winner.
do $$
declare v_dupes bigint;
begin
  select count(*) into v_dupes from (
    select source_event_id from public.financial_events
     where source_event_id is not null
     group by source_event_id having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception '0082: % source events already have more than one financial event — resolve them before applying', v_dupes;
  end if;
end $$;

-- Partial: a manually created financial event has no source event and is unconstrained.
create unique index if not exists financial_events_source_event_uq
  on public.financial_events (source_event_id)
  where source_event_id is not null;

comment on index public.financial_events_source_event_uq is
  'One drafted financial event per inbound source event (R-02). The consumer pipeline retries, and '
  'an unconditional insert turned every post-draft failure into a duplicate draft of the same payment.';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (2) R-03 — a standing decision cannot be stepped around, only superseded
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- The lifecycle columns stay writable for the TRUSTED writer, because that is how supersession
-- works. What changes is that they are no longer writable by anyone else — same positive owner
-- allowlist the INSERT branch already used, rather than a role denylist.
create or replace function public.task_routing_provenance_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    -- A routing decision is part of the record of how work was directed. Removing one erases the
    -- evidence that a person decided something; the trusted boundary never deletes.
    if not public._is_task_routing_owner() then
      raise exception 'a routing decision is not deletable — supersede it instead'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- Only the trusted writer may create a routing row at all. A POSITIVE owner allowlist: a
    -- bespoke custom role is refused exactly as service_role is.
    if not public._is_task_routing_owner() then
      raise exception 'task_routing rows are created only by the routing boundary (route_task_as_human / _as_ai / _as_system)'
        using errcode = 'insufficient_privilege';
    end if;
    if new.decided_by_source = 'human' then
      if new.decided_by is null then
        raise exception 'a human routing decision must record the person who made it';
      end if;
      if new.decided_by_model is not null or new.decided_by_component is not null then
        raise exception 'a human routing decision must not carry machine provenance';
      end if;
    else
      if new.decided_by is not null then
        raise exception 'a % routing decision must not carry a human identity', new.decided_by_source;
      end if;
      if coalesce(btrim(coalesce(new.decided_by_component, '')), '') = '' then
        raise exception 'a % routing decision must name the component that made it', new.decided_by_source;
      end if;
    end if;
    return new;
  end if;

  -- UPDATE. Provenance was already immutable; the LIFECYCLE columns are now restricted to the
  -- trusted writer too. Without this, an automated caller did not need to forge `human` — it could
  -- deactivate the human decision and then route again as `ai`, which is the same outcome by a
  -- different door.
  if (new.is_active is distinct from old.is_active
      or new.superseded_by is distinct from old.superseded_by)
     and not public._is_task_routing_owner() then
    raise exception 'only the routing boundary may supersede a routing decision (route_task_as_human / _as_ai / _as_system)'
      using errcode = 'insufficient_privilege';
  end if;

  if new.decided_by is distinct from old.decided_by
     or new.decided_by_source is distinct from old.decided_by_source
     or new.decided_by_component is distinct from old.decided_by_component
     or new.decided_by_model is distinct from old.decided_by_model
     or new.decided_by_policy_version is distinct from old.decided_by_policy_version
     or new.task_id is distinct from old.task_id
     or new.company_id is distinct from old.company_id
     or new.routing_state is distinct from old.routing_state
     or new.assignee_id is distinct from old.assignee_id then
    raise exception 'a routing decision is immutable — supersede it with a new one instead'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

-- The trigger must now also fire on DELETE. Recreated rather than altered so the event list is
-- stated in one place.
drop trigger if exists task_routing_provenance_trg on public.task_routing;
create trigger task_routing_provenance_trg
  before insert or update or delete on public.task_routing
  for each row execute function public.task_routing_provenance_guard();

-- TRUNCATE bypasses row triggers entirely, which would erase every routing decision in one
-- statement while leaving the per-row guard above untouched.
create or replace function public.task_routing_no_truncate()
returns trigger
language plpgsql
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  raise exception 'task_routing cannot be truncated' using errcode = 'restrict_violation';
end;
$$;
revoke all on function public.task_routing_no_truncate() from public, anon, authenticated, service_role;

drop trigger if exists task_routing_no_truncate_trg on public.task_routing;
create trigger task_routing_no_truncate_trg
  before truncate on public.task_routing
  for each statement execute function public.task_routing_no_truncate();

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (3) R-07 — the last holder of company administration cannot be revoked away
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- `admin_set_membership_role` guarded self-GRANT but not self-REVOKE, and nothing protected the
-- last holder. Observed: an actor with `admin.identity.manage` revoked `owner_management` from the
-- only person holding it, leaving the company with no administrator — and could then revoke it from
-- themselves. Granting is still bounded by the existing allowlist; this closes the other direction.
create or replace function public._role_holder_count(p_company uuid, p_role text)
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
  select count(distinct m.user_id)
    from public.membership_roles mr
    join public.memberships m on m.id = mr.membership_id
   where mr.company_id = p_company
     and mr.role_key = p_role
     and m.status = 'active';
$$;
revoke all on function public._role_holder_count(uuid, text) from public, anon, authenticated, service_role;

create or replace function public.admin_set_membership_role(
  p_company uuid,
  p_user uuid,
  p_role_key text,
  p_grant boolean,
  p_actor uuid
)
-- The OUT column is named `resolved_membership`, not `membership_id`: the latter collides with the
-- column of the same name in `membership_roles` and makes the DELETE below ambiguous.
returns table (resolved_membership uuid, granted boolean)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_membership uuid;
  v_holders bigint;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'admin_set_membership_role is a service-only boundary' using errcode = 'insufficient_privilege';
  end if;
  if not public.actor_has_capability(p_actor, p_company, 'admin.identity.manage') then
    raise exception 'admin.identity.manage is required to change what someone can do'
      using errcode = 'insufficient_privilege';
  end if;
  -- A CLOSED LIST, and it is not a small one: `owner_management` carries finance.approve.*,
  -- admin.organisation.manage, governance.approval_policy.manage, hr.staff.manage and
  -- operations.task.manage, and `finance_reviewer` carries all four finance.approve.* plus
  -- submit_for_approval. Saying this surface "does not hand out any role" was wrong; it hands out
  -- three, two of which are substantial. The list is kept because staffing a company needs it, and
  -- the caller must hold admin.identity.manage to use it at all.
  if p_role_key not in ('finance_reviewer', 'owner_management', 'project_manager') then
    raise exception 'role % is not grantable through this surface', p_role_key
      using errcode = 'insufficient_privilege';
  end if;
  if p_actor = p_user and p_grant then
    -- Self-elevation is the classic hole. Someone else grants it.
    raise exception 'a person may not grant themselves a role through this surface'
      using errcode = 'insufficient_privilege';
  end if;

  select m.id into v_membership from public.memberships m
   where m.user_id = p_user and m.company_id = p_company and m.status = 'active';
  if v_membership is null then
    raise exception 'that person has no active membership in this company';
  end if;

  if p_grant then
    insert into public.membership_roles (membership_id, company_id, role_key)
    values (v_membership, p_company, p_role_key)
    on conflict do nothing;
  else
    -- LAST-HOLDER PROTECTION (R-07). Granting was guarded; revoking was not, and nothing stopped an
    -- actor from removing company administration from the only person who had it — including
    -- themselves, since the self-check covered only the grant direction. A company with no
    -- administrator cannot appoint one, which is not a state any screen should be able to reach.
    if p_role_key = 'owner_management' then
      v_holders := public._role_holder_count(p_company, 'owner_management');
      if v_holders <= 1 then
        raise exception 'refusing to remove the last holder of owner_management in this company'
          using errcode = 'restrict_violation';
      end if;
    end if;
    delete from public.membership_roles mr where mr.membership_id = v_membership and mr.role_key = p_role_key;
  end if;

  insert into public.audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, 'user', p_actor::text,
          case when p_grant then 'membership_role.granted' else 'membership_role.revoked' end,
          'membership', v_membership::text,
          jsonb_build_object('role_key', p_role_key, 'subject_user', p_user));

  return query select v_membership, p_grant;
end;
$$;

revoke all on function public.admin_set_membership_role(uuid, uuid, text, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_set_membership_role(uuid, uuid, text, boolean, uuid) to service_role;

commit;
