-- 0054_wp11_approval_scope_currency_delegation.sql
-- Correction brief 0048 — WP11: complete approval authority (organisational scope, currency,
-- and delegation bounds).
--
-- Problems in decide_approval / within_authority (0046):
--   1. authority was checked for capability, maker-checker, lifecycle, amount, currency and domain,
--      but NOT for organisational scope — a division/project/site/cost-centre-restricted approver
--      could approve a financial event allocated to a scope they do not control, and an event could
--      be split across allocations to dodge scope; the amount ceiling was also not clearly compared
--      to the WHOLE event.
--   2. the delegated-authority branch checked the delegation's currency but NOT the delegator's own
--      `authority_rules.currency` against the event — a currency-restricted delegator could confer
--      effective authority in another currency.
--
-- Fix (additive schema + a new event-aware authority function; no data reinterpretation):
--   * authority_rules and delegations gain an explicit `is_company_wide` flag and
--     division/project/site/cost-centre scope columns. Existing rows default to
--     is_company_wide = FALSE with NULL scope — i.e. they authorise NOTHING until an owner
--     explicitly scopes them (requirement #3: no silent widening to company-wide).
--   * `within_authority_for_event(company, financial_event_id)` evaluates, for auth.uid():
--       active membership; domain; event currency (strict — a NULL rule/delegation currency does
--       NOT mean "all currencies", requirement #7); the WHOLE event amount vs the ceiling
--       (splitting across allocations cannot bypass it, requirement #5); every allocation within an
--       authorised scope (requirement #6); explicit company-wide authority when the event has no
--       allocations; delegation validity window, amount and currency; and the delegation scope being
--       a SUBSET of the delegator's own active, currency-matched, sufficient authority.
--   * decide_approval now authorises a financial event through this function.
--
-- NOT changed here (deliberate): requirement #8 (replacing the generic `approve` capability with a
-- domain-specific approval capability) is an owner-gated change to the permission catalogue and role
-- map; CLAUDE.md forbids autonomously changing permissions/approvals. The generic `approve`
-- capability remains the gate; the substantive amount/currency/scope/delegation authority is now
-- enforced by within_authority_for_event. The domain-capability split is a documented follow-up.
--
-- Forward-only, idempotent. `within_authority` (0046) is left intact for non-event callers.

-- ── Schema: explicit company-wide flag + organisational scope ─────────────────
alter table authority_rules add column if not exists is_company_wide boolean not null default false;
alter table authority_rules add column if not exists division_id    uuid references divisions(id);
alter table authority_rules add column if not exists project_id     uuid references projects(id);
alter table authority_rules add column if not exists site_id        uuid references sites(id);
alter table authority_rules add column if not exists cost_centre_id uuid references cost_centres(id);

alter table delegations add column if not exists is_company_wide boolean not null default false;
alter table delegations add column if not exists division_id    uuid references divisions(id);
alter table delegations add column if not exists project_id     uuid references projects(id);
alter table delegations add column if not exists site_id        uuid references sites(id);
alter table delegations add column if not exists cost_centre_id uuid references cost_centres(id);

-- ── Scope-cover predicate ─────────────────────────────────────────────────────
-- Does a COVERER scope (c_*) cover a TARGET scope (t_*)?  A company-wide coverer covers anything;
-- a company-wide target needs a company-wide coverer; an empty (all-null, non-company-wide) coverer
-- covers nothing (no silent widening); otherwise every dimension the coverer constrains must equal
-- the target's. Used both for allocation coverage (target = an allocation, t_cw = false) and for the
-- delegation-⊆-delegator subset check (target = the delegation's scope).
create or replace function public._scope_covers(
  c_cw boolean, c_div uuid, c_proj uuid, c_site uuid, c_cc uuid,
  t_cw boolean, t_div uuid, t_proj uuid, t_site uuid, t_cc uuid
) returns boolean language sql immutable set search_path = public as $$
  select case
    when coalesce(c_cw, false) then true
    when coalesce(t_cw, false) then false
    when c_div is null and c_proj is null and c_site is null and c_cc is null then false
    else (c_div  is null or c_div  = t_div)
     and (c_proj is null or c_proj = t_proj)
     and (c_site is null or c_site = t_site)
     and (c_cc   is null or c_cc   = t_cc)
  end;
$$;

-- ── Event-aware authority (deny-by-default) ───────────────────────────────────
create or replace function public.within_authority_for_event(p_company uuid, p_event uuid)
returns boolean language sql stable security definer set search_path = public as $$
  with ev as (
    select amount, currency, coalesce(event_type, 'payment') as domain
    from financial_events where id = p_event and company_id = p_company
  ),
  alloc as (
    select division_id, project_id, site_id, cost_centre_id
    from financial_event_allocations where financial_event_id = p_event and company_id = p_company
  ),
  -- Qualifying bases for auth.uid(): domain + strict currency + WHOLE-event amount ceiling.
  -- Each row is a scope the approver may act within.
  own_basis as (
    select ar.is_company_wide as cw, ar.division_id, ar.project_id, ar.site_id, ar.cost_centre_id
    from ev
    join memberships m on m.user_id = auth.uid() and m.company_id = p_company and m.status = 'active'
    join authority_rules ar on ar.membership_id = m.id and ar.company_id = p_company
    where ar.domain = ev.domain
      and ar.currency is not null and ar.currency = ev.currency
      and (ar.is_unlimited or (ar.max_amount is not null and ev.amount <= ar.max_amount))
  ),
  del_basis as (
    -- Delegated authority: the delegation defines the scope the delegate may act within, and it must
    -- be a SUBSET of the delegator's own currency-matched, sufficient, active authority.
    select d.is_company_wide as cw, d.division_id, d.project_id, d.site_id, d.cost_centre_id
    from ev
    join delegations d on d.company_id = p_company and now() between d.starts_at and d.ends_at
    join memberships tm on tm.id = d.to_membership and tm.user_id = auth.uid() and tm.status = 'active'
    join memberships fm on fm.id = d.from_membership and fm.status = 'active'
    where (d.domain = ev.domain or d.domain is null)
      and d.currency is not null and d.currency = ev.currency
      and d.max_amount is not null and ev.amount <= d.max_amount
      and exists (
        select 1 from authority_rules ar2
        where ar2.membership_id = fm.id and ar2.company_id = p_company and ar2.domain = ev.domain
          and ar2.currency is not null and ar2.currency = ev.currency
          and (ar2.is_unlimited or (ar2.max_amount is not null and ev.amount <= ar2.max_amount))
          and public._scope_covers(ar2.is_company_wide, ar2.division_id, ar2.project_id, ar2.site_id, ar2.cost_centre_id,
                                   d.is_company_wide, d.division_id, d.project_id, d.site_id, d.cost_centre_id)
      )
  ),
  basis as (select * from own_basis union all select * from del_basis)
  select case
    when not exists (select 1 from ev) then false
    when not exists (select 1 from alloc) then
      exists (select 1 from basis where cw)                              -- no allocations → company-wide only
    else
      exists (select 1 from basis)                                       -- at least one qualifying basis, and…
      and not exists (                                                   -- …no allocation left uncovered
        select 1 from alloc a
        where not exists (
          select 1 from basis b
          where public._scope_covers(b.cw, b.division_id, b.project_id, b.site_id, b.cost_centre_id,
                                     false, a.division_id, a.project_id, a.site_id, a.cost_centre_id)
        )
      )
  end;
$$;

-- ── decide_approval: authorise a financial event through the event-aware function ──
create or replace function public.decide_approval(
  p_company uuid, p_request uuid, p_action text, p_note text default null
) returns text
language plpgsql security definer set search_path = public as $$
declare v_status text; v_required int; v_maker uuid; v_fe uuid; v_amount numeric; v_ccy text; v_approvals int; v_new_status text;
begin
  if public.caller_jwt_role() = 'anon' or auth.uid() is null then raise exception 'approvals require an authenticated user'; end if;
  if p_action not in ('approve','reject') then raise exception 'action must be approve or reject'; end if;
  if not public.has_capability(p_company, 'approve') then raise exception 'missing capability approve'; end if;

  select status, approvals_required, submitted_by, financial_event_id
    into v_status, v_required, v_maker, v_fe
  from approval_requests where id = p_request and company_id = p_company for update;
  if not found then raise exception 'Approval request not found'; end if;
  if v_status <> 'pending' then raise exception 'Approval request is not pending (is %)', v_status; end if;
  if v_maker = auth.uid() then raise exception 'the maker cannot approve their own request (separation of duties)'; end if;

  -- Deny-by-default amount/currency/scope authority when the request carries a financial event.
  if p_action = 'approve' and v_fe is not null then
    select amount, currency into v_amount, v_ccy from financial_events where id = v_fe and company_id = p_company;
    if v_amount is not null and not public.within_authority_for_event(p_company, v_fe) then
      raise exception 'event %/% is outside your approval authority (amount, currency or organisational scope)', v_amount, v_ccy;
    end if;
  end if;

  begin
    insert into approval_actions (approval_request_id, company_id, actor_user_id, action, note)
    values (p_request, p_company, auth.uid(), p_action, p_note);
  exception when unique_violation then
    null;   -- already acted → no double count; fall through to recompute status.
  end;

  if p_action = 'reject' then
    v_new_status := 'rejected';
    update approval_requests set status = 'rejected' where id = p_request and company_id = p_company and status = 'pending';
  else
    select count(distinct actor_user_id) into v_approvals from approval_actions where approval_request_id = p_request and action = 'approve';
    if v_approvals >= v_required then
      v_new_status := 'approved';
      update approval_requests set status = 'approved' where id = p_request and company_id = p_company and status = 'pending';
    else
      v_new_status := 'pending';
    end if;
  end if;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, 'user', auth.uid(), 'approval.' || p_action, 'approval_request', p_request, jsonb_build_object('status', v_new_status));
  return v_new_status;
end $$;

-- ── Grants ────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.within_authority_for_event(uuid, uuid) from public;
    grant execute on function public.within_authority_for_event(uuid, uuid) to authenticated, service_role;
    revoke all on function public.decide_approval(uuid,uuid,text,text) from public;
    grant execute on function public.decide_approval(uuid,uuid,text,text) to authenticated, service_role;
  end if;
end $$;
