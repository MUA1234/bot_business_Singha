-- 0083 — correction loop 2. The LAST correction loop this package gets.
--
-- Combines the second independent review's confirmed findings with the two the owner's directive
-- asked me to establish myself. Each was reproduced on a DISPOSABLE LOCAL PostgreSQL first.
--
-- S-01 (P0, INTRODUCED BY MY OWN LOOP-1 FIX). Making `createDraft` idempotent stopped the duplicate
--   draft and created a worse bug: the returned event is no longer in `detected`, and the very next
--   pipeline step asserts that it is. Every second execution failed permanently, burned all five
--   sweeper attempts and dead-lettered — leaving a captured payment in `awaiting_approval` with NO
--   approval request, invisible on every screen and unapprovable forever. And because nothing on the
--   Inngest path settles `source_events.status`, the sweeper R1 §4 added claims rows Inngest already
--   processed, so with the mandated stack configured EVERY finance capture dead-lettered.
--   The database half is here (an approval request is unique per financial event, so a resumed run
--   cannot create a second one); the code half makes the pipeline resumable.
--
-- S-03 (P2). The last-holder check I added in 0082 read without locking, so two concurrent revokes
--   both saw two holders and both proceeded — reaching exactly the zero-administrator state the
--   migration's own comment called unreachable. Observed: holders before 2, both calls fulfilled,
--   holders after 0.
--
-- S-04 (P2). The same check fired when the subject held nothing at all, and when the company had
--   zero holders — refusing a no-op with a false statement.
--
-- OF-014 (P1, mine). `_quotation_status_for_guard` combines PUBLIC EXECUTE with a PERMISSIVE
--   `caller_jwt_role() = 'service_role'` branch. Measured on a genuine `authenticated`-only login
--   role: honest call → NULL; with `set_config('request.jwt.claims','{"role":"service_role"}')` →
--   `sent`. `anon` can do it too. It is the ONLY one of the 28 functions consulting
--   `caller_jwt_role()` where forging the claim gains anything — the other 27 are gated by EXECUTE
--   grants, which is the systemic control and which held under every probe.
--
-- A2 (the owner's directive). Heuristic duplicate SUSPICION is separated from exact idempotency and
--   may no longer terminally suppress a payment. `duplicate_reviews` records the evidence and the
--   human decision.

begin;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (1) S-01 — one approval request per financial event
-- ─────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare v_dupes bigint;
begin
  select count(*) into v_dupes from (
    select financial_event_id from public.approval_requests
     where financial_event_id is not null and status = 'pending'
     group by financial_event_id having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception '0083: % financial events already have more than one PENDING approval request', v_dupes;
  end if;
end $$;

-- Scoped to PENDING deliberately. The invariant that matters is "one OPEN approval track per
-- payment": two people must never be approving the same event down two separate requests. A later
-- corrective request, after the first has settled to approved/rejected/cancelled, is a legitimate
-- flow and stays possible.
create unique index if not exists approval_requests_open_per_event_uq
  on public.approval_requests (financial_event_id)
  where financial_event_id is not null and status = 'pending';

comment on index public.approval_requests_open_per_event_uq is
  'One OPEN approval request per financial event (S-01). The consumer pipeline has two callers and '
  'both retry, so a resumed run must not be able to raise a second live request for the same '
  'payment. Settled requests are unconstrained, so a corrective resubmission still works.';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (2) OF-014 — remove the UNAUTHENTICATED reach; the predicate itself needs a boundary change
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT I PROVED, and why this fix is GRANTS ONLY.
--
-- The directive allowed a `pg_has_role(current_user, 'service_role', 'MEMBER')` check only after
-- proving its behaviour in this function's exact execution context. That proof FAILED, in both
-- available forms:
--
--   * the function is SECURITY DEFINER, so `current_user` inside the body is the OWNER
--     (`postgres`), never the caller — it says nothing about who called;
--   * `session_user` is the role the client authenticated as, which under PostgREST is
--     `authenticator` — and Supabase grants `authenticator` membership of `service_role` so it can
--     `SET ROLE` to it. `pg_has_role(session_user, 'service_role', 'MEMBER')` would therefore be
--     TRUE for every ordinary web request, which is worse than the defect it replaces.
--
-- Measured consequence of trying it anyway: `wp12-enqueue-item-race` — "a raw service_role session
-- with NO JWT claims cannot mutate quotation_items in any status" — FAILED, because the guard
-- stopped failing closed. A correction that breaks a fail-closed control is not a correction, so
-- the predicate is left exactly as migration 0067 wrote it.
--
-- What this migration DOES take is the part that is unambiguously safe and provable — the reach:
--   * `anon` and PUBLIC lose EXECUTE entirely, closing the UNAUTHENTICATED half of the disclosure,
--     which needed no session at all (measured: an anon-only login role read a quotation's status
--     by asserting `{"role":"service_role"}` in request metadata);
--   * `authenticated` keeps it, because the quotation-item freeze trigger runs for real editors.
--
-- WHAT REMAINS, and is NOT solved here: a caller able to execute ARBITRARY SQL as the
-- `authenticated` database role can still forge the claim and read one quotation's status per known
-- id. Closing it needs the caller's role to be readable inside the guard, which means moving the
-- check into the INVOKER-context trigger and splitting the function — a boundary change, not a
-- line. It is recorded as part of the FOUND-006 residual and named as the next bounded package.
-- FOUND-006 stays unaccepted.
revoke all on function public._quotation_status_for_guard(uuid, uuid) from public, anon;
grant execute on function public._quotation_status_for_guard(uuid, uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (3) S-03 / S-04 — the last-holder check, locked and correctly scoped
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_set_membership_role(
  p_company uuid,
  p_user uuid,
  p_role_key text,
  p_grant boolean,
  p_actor uuid
)
returns table (resolved_membership uuid, granted boolean)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_membership uuid;
  v_subject_holds boolean;
  v_holders bigint;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'admin_set_membership_role is a service-only boundary' using errcode = 'insufficient_privilege';
  end if;
  if not public.actor_has_capability(p_actor, p_company, 'admin.identity.manage') then
    raise exception 'admin.identity.manage is required to change what someone can do'
      using errcode = 'insufficient_privilege';
  end if;
  -- A CLOSED LIST, and not a small one: `owner_management` carries finance.approve.*,
  -- admin.organisation.manage, governance.approval_policy.manage, hr.staff.manage and
  -- operations.task.manage; `finance_reviewer` carries all four finance.approve.* plus
  -- submit_for_approval. The caller must hold admin.identity.manage to use this at all.
  if p_role_key not in ('finance_reviewer', 'owner_management', 'project_manager') then
    raise exception 'role % is not grantable through this surface', p_role_key
      using errcode = 'insufficient_privilege';
  end if;
  if p_actor = p_user and p_grant then
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
    if p_role_key = 'owner_management' then
      -- LOCK the holder rows before counting. Reading without a lock let two concurrent revokes
      -- each observe two holders and each proceed, leaving the company with none (S-03). Locking
      -- the membership_roles rows serialises the two calls on the rows they are about to remove.
      perform 1
         from public.membership_roles mr
         join public.memberships m on m.id = mr.membership_id
        where mr.company_id = p_company
          and mr.role_key = 'owner_management'
          and m.status = 'active'
        for update of mr;

      -- Only refuse when THIS revoke would actually empty the company. Firing when the subject
      -- holds nothing, or when nobody holds it at all, refused a no-op with a false statement (S-04).
      select exists (
        select 1 from public.membership_roles mr
         where mr.membership_id = v_membership and mr.role_key = 'owner_management'
      ) into v_subject_holds;

      if v_subject_holds then
        v_holders := public._role_holder_count(p_company, 'owner_management');
        if v_holders <= 1 then
          raise exception 'refusing to remove the last holder of owner_management in this company'
            using errcode = 'restrict_violation';
        end if;
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

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (4) A2 — heuristic duplicate SUSPICION, separated from exact idempotency
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Exact idempotency is unchanged and stays where it belongs: the canonical event identity (0076)
-- and the one-draft-per-source-event index (0082). What changes is that a HEURISTIC score may no
-- longer terminally suppress a payment.
--
-- Before this, a score ≥ 0.7 moved the financial event to `duplicate`, which `src/domain/lifecycle`
-- defines as TERMINAL with no transition out, `duplicate_candidates` was read by no screen, and the
-- source event settled as completed. A second genuine payment was therefore silently and
-- irreversibly discarded. Same amount + same day alone scores 0.8; same supplier + same amount with
-- no date proximity (monthly rent, salaries, instalments) scores exactly 0.7.
create table if not exists public.duplicate_reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- The event under suspicion, and the earlier one it resembles.
  financial_event_id uuid not null references public.financial_events(id) on delete cascade,
  matched_event_id uuid not null references public.financial_events(id) on delete cascade,
  score numeric(5,4) not null,
  /** Per-feature contributions, so a reviewer sees WHY rather than a bare number. */
  feature_contributions jsonb not null default '{}'::jsonb,
  /** Which evidence was actually present, and which was missing. Missing is never a match. */
  evidence_present text[] not null default '{}',
  evidence_missing text[] not null default '{}',
  algorithm_version text not null,
  state text not null default 'open',
  resolution text,
  resolved_by uuid references public.users(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  constraint duplicate_reviews_state_ck check (state in ('open', 'resolved')),
  constraint duplicate_reviews_resolution_ck check (
    (state = 'open' and resolution is null and resolved_by is null and resolved_at is null)
    or
    (state = 'resolved' and resolution in ('confirmed_duplicate', 'distinct_event')
     and resolved_by is not null and resolved_at is not null)
  ),
  -- A pair is raised ONCE. A re-run of the pipeline finds the existing review rather than stacking.
  constraint duplicate_reviews_pair_uq unique (financial_event_id, matched_event_id),
  -- An event never resembles itself.
  constraint duplicate_reviews_distinct_ck check (financial_event_id <> matched_event_id)
);

create index if not exists duplicate_reviews_open_idx
  on public.duplicate_reviews (company_id, created_at desc) where state = 'open';

alter table public.duplicate_reviews enable row level security;

-- SERVICE-ONLY writes (classified in security/rls-classification.json). Supabase's default grants
-- hand `authenticated` full DML on a new table, so an explicit REVOKE is required — RLS with no
-- write policy is not the same control, and the WP10 gate checks the GRANT.
revoke all on public.duplicate_reviews from anon, authenticated;
grant select on public.duplicate_reviews to authenticated;

drop policy if exists duplicate_reviews_read on public.duplicate_reviews;
create policy duplicate_reviews_read on public.duplicate_reviews
  for select using (public.has_company_access(company_id));

comment on table public.duplicate_reviews is
  'HEURISTIC duplicate suspicion awaiting a person. Distinct from exact idempotency, which is the '
  'canonical event identity (0076) and the one-draft-per-source-event index (0082). A score here '
  'NEVER terminally suppresses a payment: the financial event pauses in a reversible state and a '
  'human decides. Reproduced before this existed: two genuinely different payments to one supplier '
  'on one day scored 1.0 and the second was terminally discarded, unreadable by any screen.';

commit;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (5) S-01 case (b) — the durable consumer settles its own receipt
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- The Inngest consumer processed a capture and left `source_events.status` untouched, so the
-- scheduled sweeper claimed the same row afterwards. Before loop 1 that produced a duplicate draft;
-- after it, a permanent stall. This lets the durable consumer settle a receipt it finished, WITHOUT
-- holding a sweeper lease — it never had one.
begin;

create or replace function public.settle_processed_source_event(p_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare v record;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'settle_processed_source_event is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  select s.id, s.status, s.lease_owner into v
    from public.source_events s where s.id = p_id for update;
  if not found then raise exception 'source event % not found', p_id; end if;

  -- Never steal a row a sweeper is actively working, and never revive a terminal one.
  if v.lease_owner is not null then return 'leased_elsewhere'; end if;
  if v.status in ('completed', 'processed', 'dead_letter') then return v.status; end if;

  update public.source_events
     set status = 'completed', processed_at = now(), lease_expires_at = null
   where id = p_id;
  return 'completed';
end;
$$;

revoke all on function public.settle_processed_source_event(uuid) from public, anon, authenticated;
grant execute on function public.settle_processed_source_event(uuid) to service_role;

commit;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (6) S-05 — the reviewer LIST and the reviewer COUNT ask the same question
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- `inbound_setup_status.reviewers` counts by CAPABILITY, which includes delegations. The setup
-- screen listed by a hardcoded three-role-key filter. With one delegation in place the screen
-- showed "2 people who can review" beside a list of one, and offered "Make reviewer" to somebody
-- who already could. Loop 1 unified only the active-membership half and claimed they "cannot drift
-- apart"; this makes that true by giving the list the count's own predicate.
begin;

create or replace function public.inbound_reviewer_user_ids(p_company uuid)
returns table (user_id uuid)
language plpgsql
stable
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'inbound_reviewer_user_ids is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if p_company is null then
    raise exception 'p_company is required';
  end if;

  return query
  select distinct m.user_id
    from public.memberships m
   where m.company_id = p_company
     and m.status = 'active'
     and public.actor_has_capability(m.user_id, p_company, 'operations.inbound.review');
end;
$$;

revoke all on function public.inbound_reviewer_user_ids(uuid) from public, anon, authenticated;
grant execute on function public.inbound_reviewer_user_ids(uuid) to service_role;

comment on function public.inbound_reviewer_user_ids(uuid) is
  'The people the inbound-setup screen lists as able to review, using the SAME predicate '
  'inbound_setup_status counts by. Two different definitions on one screen is how a delegated '
  'reviewer appeared in the number and not in the list.';

commit;
