-- 0087_duplicate_review_resolution.sql
-- OF-016 — the authorized resolution workflow for a suspected-duplicate financial event.
--
-- WHAT WAS MISSING
-- ----------------
-- Migration 0083 made duplicate suspicion honest: a score may pause a payment, it may not discard
-- one. It created `duplicate_reviews` with the candidate, the prior match, the score, the
-- per-feature contributions, the evidence present and missing, and the rule version — and it left
-- the payment in the REVERSIBLE state `awaiting_information`.
--
-- Then it stopped. There is no resolution RPC, no screen and no write grant (`revoke all … from
-- anon, authenticated; grant select … to authenticated`). A real payment pauses, correctly and
-- reversibly, with nothing in the product able to move it again. Nothing is lost — but nothing
-- proceeds either, and the paused payment is on no screen. That is OF-016, recorded as a MATERIAL
-- BLOCKER during the 0083 evidence-closure pass and deliberately left for this package.
--
-- WHAT THIS ADDS
-- --------------
-- The workflow AROUND the existing evidence. No column of 0083's record is redesigned or
-- discarded, and every historic pending row becomes visible and resolvable with no data migration.
--
--   * `finance.duplicate.resolve` — a narrow capability, seeded to the finance/owner roles.
--   * `financial_events.duplicate_of_event_id` — the link a confirmation writes.
--   * `resolve_duplicate_review(review, resolution, reason)` — human-only, one transaction.
--   * `duplicate_review_queue(company)` — the reviewer's read, capability-gated.
--   * Terminal resolutions are immutable; the table takes no direct DML from an api role.
--
-- THE TRUST BOUNDARY (FOUND-006, migrations 0084–0086)
-- ----------------------------------------------------
-- The resolution RPC is HUMAN-ONLY and says so through GRANTS, not through claim text:
--
--   * EXECUTE granted to `authenticated` and to nobody else — not `anon`, not `service_role`.
--     A service worker cannot forge a human decision because it cannot call the function.
--   * The actor is `auth.uid()`. There is no `p_actor` parameter to spoof.
--   * The COMPANY is read from the review row, never from the caller. There is no `p_company`
--     parameter, so a caller cannot name a company it does not belong to.
--   * Active membership and the capability are resolved INSIDE the transaction, after the rows are
--     locked, so a membership revoked mid-flight cannot be raced.
--   * There is deliberately NO `caller_jwt_role()` gate. Migration 0075 added one on top of its
--     EXECUTE grants; it is fail-closed and therefore not a hole, but it refuses a genuine caller
--     whose claim text differs, which is the second half of the rule FOUND-006 enforces. That is
--     tracked separately as OF-018 and is not copied here.
--
-- LOCK ORDER (documented once, shared with the finance worker)
-- ------------------------------------------------------------
--   source_events  →  financial_events  →  duplicate_reviews  →  approval_requests / payments
--
-- The source event first, because it is the processing LINEARIZATION object: `claim_source_events`
-- takes `for update skip locked` on it before anything else, so a reviewer holding that lock makes
-- the worker skip the row rather than queue behind it. Every statement below acquires locks in
-- this order and no other, which is what makes an AB-BA deadlock against the worker impossible.
--
-- Forward-only. Additive DDL, one new column, no destructive data change.

begin;

set local search_path = pg_catalog, extensions, public, pg_temp;

-- ── 1. The capability ────────────────────────────────────────────────────────────────────────
insert into public.permissions (key, label) values
  ('finance.duplicate.resolve', 'Finance: resolve a suspected duplicate')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('finance_reviewer',      'finance.duplicate.resolve'),
  ('owner_management',      'finance.duplicate.resolve'),
  ('system_administrator',  'finance.duplicate.resolve')
on conflict do nothing;

-- ── 2. The link a confirmation writes ────────────────────────────────────────────────────────
alter table public.financial_events
  add column if not exists duplicate_of_event_id uuid references public.financial_events(id);

comment on column public.financial_events.duplicate_of_event_id is
  'Set ONLY by resolve_duplicate_review when a human confirms this event duplicates an earlier one. '
  'The earlier event is untouched. Never written by the pipeline and never inferred from a score.';

create index if not exists financial_events_duplicate_of_idx
  on public.financial_events (duplicate_of_event_id) where duplicate_of_event_id is not null;

-- ── 3. The resolution vocabulary and the required reason ─────────────────────────────────────
-- 0083 wrote `distinct_event`; the approved vocabulary is `dismissed_distinct`. No row can be
-- affected: nothing could resolve a review before this migration, so every existing row is
-- `state='open'` with a NULL resolution. Verified fail-closed below rather than assumed.
do $$
declare v_resolved bigint;
begin
  select count(*) into v_resolved from public.duplicate_reviews where state <> 'open';
  if v_resolved > 0 then
    raise exception '0087: % duplicate_reviews row(s) are already resolved — the resolution '
                    'vocabulary cannot be changed under them. Migrate them explicitly.', v_resolved;
  end if;
end
$$;

alter table public.duplicate_reviews drop constraint if exists duplicate_reviews_resolution_ck;
alter table public.duplicate_reviews
  add constraint duplicate_reviews_resolution_ck check (
    (state = 'open'
      and resolution is null and resolved_by is null and resolved_at is null
      and resolution_note is null)
    or
    (state = 'resolved'
      and resolution in ('confirmed_duplicate', 'dismissed_distinct')
      and resolved_by is not null and resolved_at is not null
      -- A decision without a reason is not a reviewable decision.
      and resolution_note is not null and btrim(resolution_note) <> '')
  );

-- ── 4. Reading the queue is capability-gated, not merely company-scoped ──────────────────────
-- A duplicate review quotes two financial events with amounts and counterparties. `inbound_reviews`
-- (0075) is capability-gated for SELECT for the same reason; this matches that precedent.
drop policy if exists duplicate_reviews_read on public.duplicate_reviews;
create policy duplicate_reviews_read on public.duplicate_reviews
  for select using (public.has_capability(company_id, 'finance.duplicate.resolve'));

-- No direct DML from an api role, ever. The RPC is the only writer.
revoke all on public.duplicate_reviews from anon, authenticated;
grant select on public.duplicate_reviews to authenticated;

-- ── 5. A terminal resolution is immutable ────────────────────────────────────────────────────
-- SECURITY **INVOKER**, deliberately and load-bearingly. Inside a SECURITY DEFINER body
-- `current_user` is the function's OWNER, not the caller — the trap FOUND-006 §3 measured — so a
-- definer version of this trigger would see `postgres` for every writer and wave all of them
-- through. An invoker trigger is the one context where `current_user` really is the caller. (A
-- trigger function needs no EXECUTE grant to fire, so this costs nothing.)
create or replace function public.duplicate_reviews_immutable_when_resolved()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare v_trusted boolean;
begin
  -- The owner of the resolution RPC is the one writer allowed to move a review into `resolved`.
  -- When that SECURITY DEFINER function performs its UPDATE, this trigger runs inside its context
  -- and `current_user` IS the owner. Anyone else — including a direct `service_role` UPDATE, which
  -- is the only api-adjacent role holding table DML — is refused, in both directions.
  select p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
    into v_trusted
    from pg_catalog.pg_proc p
   where p.oid = 'public.resolve_duplicate_review(uuid,text,text)'::pg_catalog.regprocedure;
  if coalesce(v_trusted, false) then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'a duplicate review is evidence — it is not deletable'
      using errcode = 'insufficient_privilege';
  end if;
  if old.state = 'resolved' then
    raise exception 'duplicate review % is resolved (%) — a terminal decision is immutable', old.id, old.resolution
      using errcode = 'insufficient_privilege';
  end if;
  raise exception 'a duplicate review is resolved through resolve_duplicate_review, not by direct write'
    using errcode = 'insufficient_privilege';
end
$$;

-- ── 6. The resolution RPC ────────────────────────────────────────────────────────────────────
create or replace function public.resolve_duplicate_review(
  p_review     uuid,
  p_resolution text,
  p_reason     text
)
returns table (review_id uuid, state text, resolution text, financial_event_id uuid, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_rev      public.duplicate_reviews%rowtype;
  v_company  uuid;
  v_fe       public.financial_events%rowtype;
  v_src      uuid;
  v_src_row  public.source_events%rowtype;
  v_reason   text := left(btrim(coalesce(p_reason, '')), 500);
  v_drafts   int;
  v_approvals int;
begin
  -- ── identity, from the trusted request context only ───────────────────────────────────────
  if v_actor is null then
    raise exception 'a duplicate review is a human decision — no authenticated subject'
      using errcode = 'insufficient_privilege';
  end if;
  if p_resolution not in ('confirmed_duplicate', 'dismissed_distinct') then
    raise exception 'p_resolution must be confirmed_duplicate or dismissed_distinct (got %)', p_resolution;
  end if;
  if v_reason = '' then
    raise exception 'a reason is required — a decision without one is not reviewable';
  end if;

  -- ── LOCK ORDER, step 0: find the review WITHOUT locking, only to learn the source event ────
  -- Read-only, no lock taken, so this cannot invert the order below.
  select * into v_rev from public.duplicate_reviews r where r.id = p_review;
  if v_rev.id is null then
    raise exception 'duplicate review not found';
  end if;
  v_company := v_rev.company_id;

  select fe.source_event_id into v_src
    from public.financial_events fe where fe.id = v_rev.financial_event_id;

  -- ── LOCK ORDER, step 1: the source event — the processing linearization object ────────────
  -- Taken FIRST so a concurrent `claim_source_events` (`for update skip locked`) skips the row
  -- instead of racing us, and so every actor in this system acquires these three locks in one
  -- direction only.
  if v_src is not null then
    select * into v_src_row from public.source_events s where s.id = v_src for update;
  end if;

  -- ── LOCK ORDER, step 2: the financial event ────────────────────────────────────────────────
  select * into v_fe from public.financial_events fe
   where fe.id = v_rev.financial_event_id for update;
  if v_fe.id is null then
    raise exception 'the financial event behind this review no longer exists';
  end if;

  -- ── LOCK ORDER, step 3: the review itself ─────────────────────────────────────────────────
  select * into v_rev from public.duplicate_reviews r where r.id = p_review for update;

  -- ── authority, re-checked at commit time under the locks ──────────────────────────────────
  -- Membership must be ACTIVE now, not when the page was rendered. `actor_has_capability` walks
  -- active memberships and their roles, so an inactive or removed member fails here.
  if not public.actor_has_capability(v_actor, v_company, 'finance.duplicate.resolve') then
    raise exception 'you do not hold finance.duplicate.resolve in this company'
      using errcode = 'insufficient_privilege';
  end if;
  -- Cross-company defence in depth: the review names its own company and the event must agree.
  if v_fe.company_id is distinct from v_company then
    raise exception 'company mismatch between the review and its financial event — refusing'
      using errcode = 'insufficient_privilege';
  end if;

  -- ── idempotent replay: the standing decision wins, and is returned ────────────────────────
  if v_rev.state = 'resolved' then
    return query select v_rev.id, v_rev.state, v_rev.resolution, v_rev.financial_event_id, true;
    return;
  end if;

  -- The pause state this workflow exists to release. Anything else means somebody or something
  -- already moved the event, and guessing would be worse than stopping.
  if v_fe.state <> 'awaiting_information' then
    raise exception 'the financial event is in state % — only an event paused in '
                    'awaiting_information can be resolved here', v_fe.state
      using errcode = 'invalid_parameter_value';
  end if;

  -- ── the decision ──────────────────────────────────────────────────────────────────────────
  if p_resolution = 'confirmed_duplicate' then
    -- Fail CLOSED if downstream work already exists. A confirmation must create no business
    -- effect, and it must not quietly stand on top of one that is already there. Financial
    -- evidence is never deleted automatically — a person decides what to do with it.
    select count(*) into v_approvals from public.approval_requests a
     where a.financial_event_id = v_fe.id;
    select count(*) into v_drafts from public.payments p
     where p.source_event_id = v_src and v_src is not null;
    if v_approvals > 0 or v_drafts > 0 then
      raise exception 'inconsistent: this paused event already has % approval request(s) and % '
                      'payment(s). Confirming a duplicate here would leave financial evidence '
                      'behind it. Resolve those first.', v_approvals, v_drafts
        using errcode = 'raise_exception';
    end if;

    update public.financial_events
       set state = 'duplicate',
           duplicate_of_event_id = v_rev.matched_event_id,
           updated_at = now()
     where id = v_fe.id;

    -- No longer claimable: the worker must not pick this up again after a person has decided.
    if v_src is not null then
      update public.source_events
         set status = 'completed',
             processed_at = coalesce(processed_at, now()),
             lease_owner = null,
             lease_expires_at = null
       where id = v_src;
    end if;

  else  -- dismissed_distinct
    -- Back to the durable resumable state. The EXISTING idempotent consumer does the finance work;
    -- nothing here creates a draft, an approval or a journal.
    update public.financial_events
       set state = 'draft', updated_at = now()
     where id = v_fe.id;

    -- Available to the processor exactly once. `attempts` is deliberately NOT reset — the history
    -- of how hard this event has been tried is part of its record, and zeroing it would make a
    -- much-retried event look fresh.
    if v_src is not null then
      update public.source_events
         set status = 'pending',
             next_attempt_at = now(),
             lease_owner = null,
             lease_acquired_at = null,
             lease_expires_at = null,
             processed_at = null
       where id = v_src;
    end if;
  end if;

  update public.duplicate_reviews
     set state = 'resolved',
         resolution = p_resolution,
         resolved_by = v_actor,
         resolved_at = now(),
         resolution_note = v_reason
   where id = v_rev.id;

  -- Audit in the SAME transaction as the state change: a resolution can never be recorded without
  -- its trail, and the trail names the real human, not a role.
  insert into public.audit_events
    (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (
    v_company, 'user', v_actor::text, 'finance.duplicate_review_resolved',
    'duplicate_review', v_rev.id::text,
    jsonb_build_object(
      'resolution',         p_resolution,
      'reason',             v_reason,
      'financial_event_id', v_rev.financial_event_id,
      'matched_event_id',   v_rev.matched_event_id,
      'source_event_id',    v_src,
      'score',              v_rev.score,
      'algorithm_version',  v_rev.algorithm_version,
      'evidence_present',   to_jsonb(v_rev.evidence_present),
      'evidence_missing',   to_jsonb(v_rev.evidence_missing)
    )
  );

  return query select v_rev.id, 'resolved'::text, p_resolution, v_rev.financial_event_id, false;
end
$$;

-- HUMAN-ONLY, by grant. `service_role` is excluded deliberately: a worker must not be able to
-- forge a person's decision, and no code path needs it to.
revoke all on function public.resolve_duplicate_review(uuid, text, text) from public, anon, service_role;
grant execute on function public.resolve_duplicate_review(uuid, text, text) to authenticated;

-- The immutability trigger names the RPC's owner, so create it only once the function exists.
drop trigger if exists duplicate_reviews_immutable on public.duplicate_reviews;
create trigger duplicate_reviews_immutable
  before update or delete on public.duplicate_reviews
  for each row execute function public.duplicate_reviews_immutable_when_resolved();

-- ── 7. The reviewer's read ───────────────────────────────────────────────────────────────────
-- One call returning everything the screen must show, so the UI cannot drift from the record:
-- both transactions, their amounts and currencies, dates, counterparties, the score, the
-- per-feature contributions, what evidence was present and what was missing, and the rule version.
create or replace function public.duplicate_review_queue(p_company uuid)
returns table (
  review_id uuid, state text, resolution text, score numeric,
  feature_contributions jsonb, evidence_present text[], evidence_missing text[],
  algorithm_version text, created_at timestamptz,
  resolved_by uuid, resolved_by_name text, resolved_at timestamptz, resolution_note text,
  candidate_event_id uuid, candidate_amount numeric, candidate_currency text,
  candidate_date date, candidate_counterparty text, candidate_state text,
  candidate_purpose text, candidate_source_event_id uuid,
  matched_event_id uuid, matched_amount numeric, matched_currency text,
  matched_date date, matched_counterparty text, matched_state text, matched_purpose text
)
language sql
stable
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
  select
    r.id, r.state, r.resolution, r.score,
    r.feature_contributions, r.evidence_present, r.evidence_missing,
    r.algorithm_version, r.created_at,
    r.resolved_by, u.full_name, r.resolved_at, r.resolution_note,
    c.id, c.amount, c.currency::text, c.transaction_date, c.counterparty_name, c.state,
    c.purpose, c.source_event_id,
    m.id, m.amount, m.currency::text, m.transaction_date, m.counterparty_name, m.state, m.purpose
  from public.duplicate_reviews r
  join public.financial_events c on c.id = r.financial_event_id
  join public.financial_events m on m.id = r.matched_event_id
  left join public.users u on u.id = r.resolved_by
  where r.company_id = p_company
    and public.actor_has_capability(auth.uid(), p_company, 'finance.duplicate.resolve')
  order by (r.state = 'open') desc, r.created_at desc;
$$;

revoke all on function public.duplicate_review_queue(uuid) from public, anon;
grant execute on function public.duplicate_review_queue(uuid) to authenticated;

comment on function public.duplicate_review_queue(uuid) is
  'OF-016: the reviewer''s read. SECURITY DEFINER so it can join both financial events, but it '
  'returns nothing unless auth.uid() holds finance.duplicate.resolve in the company asked for — '
  'the capability is checked in the predicate, so there is no row to leak on the way out.';

-- ── 8. Fail closed on the boundary this package depends on ───────────────────────────────────
do $$
declare bad text;
begin
  -- The resolution RPC must be human-only. If `service_role` can call it, a worker can forge a
  -- person's decision and the audit trail becomes a lie.
  if has_function_privilege('service_role', 'public.resolve_duplicate_review(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.resolve_duplicate_review(uuid,text,text)', 'EXECUTE') then
    raise exception '0087 fail-closed: resolve_duplicate_review must be executable by `authenticated` only';
  end if;
  if not has_function_privilege('authenticated', 'public.resolve_duplicate_review(uuid,text,text)', 'EXECUTE') then
    raise exception '0087 fail-closed: a human cannot reach resolve_duplicate_review';
  end if;

  -- No direct write path to the evidence table.
  select string_agg(priv, ', ') into bad
    from (
      select 'duplicate_reviews:' || rr.rolname || ':' || pr.privilege as priv
        from (values ('anon'), ('authenticated')) as rr(rolname)
        cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as pr(privilege)
       where has_table_privilege(rr.rolname, 'public.duplicate_reviews', pr.privilege)
    ) x;
  if bad is not null then
    raise exception '0087 fail-closed: untrusted write privilege on duplicate_reviews — %', bad;
  end if;
end
$$;

commit;
