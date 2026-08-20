-- 0088_duplicate_review_boundary_corrections.sql
-- OF-016 correction loop 1 of 2. Independent review findings H-02, H-03, H-06, H-08.
--
-- Migration 0087 got the RESOLUTION boundary right — a decision can only be made by an
-- authenticated human holding the capability, through one RPC, in one transaction, with its audit.
-- It did not finish the EVIDENCE boundary around that decision. Four gaps, all reproduced on a
-- disposable local PostgreSQL 16 before being fixed:
--
--   H-02 (P1)  0087's immutability trigger is `before update or delete`. `service_role` therefore
--              cannot alter a decision but CAN INSERT a fabricated one:
--                  insert into duplicate_reviews (… 'resolved','dismissed_distinct', <a real user>,
--                                                  now(), 'FORGED — no human decided this');
--                  INSERT 0 1        ← and zero audit rows for it
--              It renders on the reviewer's screen as a real decision by a real named person, and a
--              fabricated `dismissed_distinct` row also silently suppresses duplicate detection for
--              that pair through 0087's own exclusion. The commit claimed "a service worker cannot
--              forge a human decision because it cannot call the function". It cannot call the
--              function; it did not need to.
--
--   H-03 (P1)  Two routes destroyed resolved evidence outright:
--                  set role service_role; truncate duplicate_reviews;   → TRUNCATE TABLE, 0 rows left
--                  set role service_role; delete from financial_events where id=…;
--                                                                       → the review cascaded away
--              BEFORE ROW triggers do not fire for TRUNCATE — migration 0066 says so in as many
--              words — and the 0083 FKs are `on delete cascade`. The register claim that "a
--              resolved decision cannot be altered or deleted, including by service_role" was false.
--
--   H-06 (P2)  `duplicate_review_queue` joined both financial events with NO company predicate, and
--              the RPC checked the candidate's company but never the MATCHED event's. A malformed
--              row pointing at another company's event leaked that company's amount, counterparty
--              and purpose to this company's reviewer, and a confirmation persisted the
--              cross-tenant link. Only `service_role` can write such a row today, so it is
--              defence-in-depth rather than an api-reachable leak — but CLAUDE.md makes
--              cross-company leakage a critical class that must be PROVEN impossible, and
--              `financial_events` already carries the `(company_id, id)` key needed to do it.
--
--   H-08 (P2)  The RPC re-armed `source_events` with no status guard, so resolving an event whose
--              source had been DEAD-LETTERED produced `status='pending'` still carrying
--              `dead_lettered_at` and `dead_letter_reason='exhausted'` — a claimable row wearing a
--              terminal stamp, contradicting the invariants `fail_source_event` and
--              `complete_source_event` enforce.
--
-- Forward-only. Additive triggers and constraints, one function replaced, no data rewritten.

begin;

set local search_path = pg_catalog, extensions, public, pg_temp;

-- ── H-02: an INSERT boundary, mirroring what 0066 established for quotations ─────────────────
-- A non-trusted writer may create a review only in the INITIAL state. The trusted writer is
-- identified by the resolution RPC's owner — the same positive-ownership signal the update/delete
-- branch already uses, and deliberately not a role-name denylist, which a bespoke role defeats.
create or replace function public.duplicate_reviews_insert_initial_only()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare v_trusted boolean;
begin
  select p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
    into v_trusted
    from pg_catalog.pg_proc p
   where p.oid = 'public.resolve_duplicate_review(uuid,text,text)'::pg_catalog.regprocedure;
  if coalesce(v_trusted, false) then
    return new;
  end if;

  if new.state is distinct from 'open'
     or new.resolution is not null
     or new.resolved_by is not null
     or new.resolved_at is not null
     or new.resolution_note is not null then
    raise exception 'a duplicate review may only be CREATED as an open suspicion — a decision is '
                    'recorded through resolve_duplicate_review, by the person who made it'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

drop trigger if exists duplicate_reviews_insert_initial on public.duplicate_reviews;
create trigger duplicate_reviews_insert_initial
  before insert on public.duplicate_reviews
  for each row execute function public.duplicate_reviews_insert_initial_only();

-- ── H-03a: TRUNCATE bypasses row triggers, so it needs a STATEMENT trigger ───────────────────
create or replace function public.duplicate_reviews_no_truncate()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  raise exception 'duplicate_reviews is evidence — it is not truncatable'
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists duplicate_reviews_no_truncate on public.duplicate_reviews;
create trigger duplicate_reviews_no_truncate
  before truncate on public.duplicate_reviews
  for each statement execute function public.duplicate_reviews_no_truncate();

-- ── H-03b: a resolved review must not be cascaded away with its financial event ──────────────
-- The 0083 FKs stay `on delete cascade`, which is right for an OPEN suspicion: deleting a draft
-- event should take its unresolved candidacy with it. What must not vanish is a decision a person
-- made. Guarding the PARENT delete keeps that distinction, and keeps authorised pre-decision
-- cleanup working.
create or replace function public.financial_events_protect_resolved_reviews()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare v_trusted boolean; v_n int;
begin
  select p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
    into v_trusted
    from pg_catalog.pg_proc p
   where p.oid = 'public.resolve_duplicate_review(uuid,text,text)'::pg_catalog.regprocedure;
  if coalesce(v_trusted, false) then
    return old;
  end if;

  select count(*) into v_n from public.duplicate_reviews r
   where (r.financial_event_id = old.id or r.matched_event_id = old.id)
     and r.state = 'resolved';
  if v_n > 0 then
    raise exception 'financial event % carries % resolved duplicate review(s) — deleting it would '
                    'erase a decision a person made. Reverse or supersede the event instead.', old.id, v_n
      using errcode = 'insufficient_privilege';
  end if;
  return old;
end
$$;

drop trigger if exists financial_events_protect_resolved_reviews on public.financial_events;
create trigger financial_events_protect_resolved_reviews
  before delete on public.financial_events
  for each row execute function public.financial_events_protect_resolved_reviews();

-- ── H-06: company agreement enforced by the SCHEMA, not only by a predicate ──────────────────
-- `financial_events` already carries `UNIQUE (company_id, id)` (WP11/0060), which exists precisely
-- so references like these can be composite. With these in place a review whose events belong to a
-- different company cannot be written at all, so the queue cannot leak one.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.duplicate_reviews'::regclass
                    and conname = 'duplicate_reviews_candidate_company_fk') then
    alter table public.duplicate_reviews
      add constraint duplicate_reviews_candidate_company_fk
      foreign key (financial_event_id, company_id)
      references public.financial_events (id, company_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.duplicate_reviews'::regclass
                    and conname = 'duplicate_reviews_matched_company_fk') then
    alter table public.duplicate_reviews
      add constraint duplicate_reviews_matched_company_fk
      foreign key (matched_event_id, company_id)
      references public.financial_events (id, company_id) on delete cascade;
  end if;
end
$$;

-- …and the queue joins on the company too, so a row that somehow disagreed still could not render.
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
  -- BOTH sides joined on the company as well as the id. Belt and braces with the composite FKs
  -- above: cross-company data cannot be reached through this function even if a row disagreed.
  join public.financial_events c on c.id = r.financial_event_id and c.company_id = r.company_id
  join public.financial_events m on m.id = r.matched_event_id  and m.company_id = r.company_id
  left join public.users u on u.id = r.resolved_by
  where r.company_id = p_company
    and public.actor_has_capability(auth.uid(), p_company, 'finance.duplicate.resolve')
  order by (r.state = 'open') desc, r.created_at desc;
$$;

revoke all on function public.duplicate_review_queue(uuid) from public, anon;
grant execute on function public.duplicate_review_queue(uuid) to authenticated;

-- ── H-02/H-06/H-08 in the RPC: matched-company check, and a terminal source event ────────────
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
  v_matched  public.financial_events%rowtype;
  v_src      uuid;
  v_src_row  public.source_events%rowtype;
  v_reason   text := left(btrim(coalesce(p_reason, '')), 500);
  v_drafts   int;
  v_approvals int;
begin
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

  select * into v_rev from public.duplicate_reviews r where r.id = p_review;
  if v_rev.id is null then
    raise exception 'duplicate review not found';
  end if;
  v_company := v_rev.company_id;

  select fe.source_event_id into v_src
    from public.financial_events fe where fe.id = v_rev.financial_event_id;

  -- LOCK ORDER (unchanged, documented in 0087): source_events → financial_events → duplicate_reviews.
  if v_src is not null then
    select * into v_src_row from public.source_events s where s.id = v_src for update;
  end if;

  select * into v_fe from public.financial_events fe
   where fe.id = v_rev.financial_event_id for update;
  if v_fe.id is null then
    raise exception 'the financial event behind this review no longer exists';
  end if;

  select * into v_rev from public.duplicate_reviews r where r.id = p_review for update;

  if not public.actor_has_capability(v_actor, v_company, 'finance.duplicate.resolve') then
    raise exception 'you do not hold finance.duplicate.resolve in this company'
      using errcode = 'insufficient_privilege';
  end if;
  if v_fe.company_id is distinct from v_company then
    raise exception 'company mismatch between the review and its financial event — refusing'
      using errcode = 'insufficient_privilege';
  end if;
  -- H-06: the MATCHED event must belong to the same company too. 0087 checked only the candidate,
  -- so a malformed row could have persisted a cross-tenant `duplicate_of_event_id` link.
  select * into v_matched from public.financial_events fe where fe.id = v_rev.matched_event_id;
  if v_matched.id is null or v_matched.company_id is distinct from v_company then
    raise exception 'the matched event is missing or belongs to another company — refusing'
      using errcode = 'insufficient_privilege';
  end if;

  if v_rev.state = 'resolved' then
    return query select v_rev.id, v_rev.state, v_rev.resolution, v_rev.financial_event_id, true;
    return;
  end if;

  if v_fe.state <> 'awaiting_information' then
    raise exception 'the financial event is in state % — only an event paused in '
                    'awaiting_information can be resolved here', v_fe.state
      using errcode = 'invalid_parameter_value';
  end if;

  if p_resolution = 'confirmed_duplicate' then
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

    if v_src is not null then
      update public.source_events
         set status = 'completed',
             processed_at = coalesce(processed_at, now()),
             lease_owner = null,
             lease_expires_at = null
       where id = v_src;
    end if;

  else  -- dismissed_distinct
    update public.financial_events
       set state = 'draft', updated_at = now()
     where id = v_fe.id;

    -- H-08: a DEAD-LETTERED source event is terminal. Re-arming it without clearing the stamp left
    -- a claimable row still carrying `dead_lettered_at` and a dead-letter reason — a state
    -- `fail_source_event` and `complete_source_event` both refuse to produce. Releasing the payment
    -- is a deliberate human act, so the dead-letter IS cleared, and the audit payload below records
    -- that it happened rather than letting it disappear quietly.
    if v_src is not null then
      update public.source_events
         set status = 'pending',
             next_attempt_at = now(),
             lease_owner = null,
             lease_acquired_at = null,
             lease_expires_at = null,
             processed_at = null,
             dead_lettered_at = null,
             dead_letter_reason = null
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
      'evidence_missing',   to_jsonb(v_rev.evidence_missing),
      -- Named explicitly: a released payment whose source event had been dead-lettered is worth
      -- seeing in the trail, not inferring from an absent flag.
      'cleared_dead_letter', (p_resolution = 'dismissed_distinct'
                              and v_src_row.dead_lettered_at is not null),
      'prior_dead_letter_reason', case
        when p_resolution = 'dismissed_distinct' then v_src_row.dead_letter_reason else null end
    )
  );

  return query select v_rev.id, 'resolved'::text, p_resolution, v_rev.financial_event_id, false;
end
$$;

revoke all on function public.resolve_duplicate_review(uuid, text, text) from public, anon, service_role;
grant execute on function public.resolve_duplicate_review(uuid, text, text) to authenticated;

-- ── Fail closed: prove the boundaries exist, in this transaction ─────────────────────────────
do $$
declare n int;
begin
  select count(*) into n from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
   where c.relname = 'duplicate_reviews' and not t.tgisinternal
     and t.tgname in ('duplicate_reviews_immutable', 'duplicate_reviews_insert_initial',
                      'duplicate_reviews_no_truncate');
  if n <> 3 then
    raise exception '0088 fail-closed: expected 3 boundary triggers on duplicate_reviews, found %', n;
  end if;

  if not exists (select 1 from pg_catalog.pg_trigger t
                   join pg_catalog.pg_class c on c.oid = t.tgrelid
                  where c.relname = 'financial_events' and not t.tgisinternal
                    and t.tgname = 'financial_events_protect_resolved_reviews') then
    raise exception '0088 fail-closed: a resolved decision is still cascade-deletable';
  end if;

  select count(*) into n from pg_catalog.pg_constraint
   where conrelid = 'public.duplicate_reviews'::regclass
     and conname in ('duplicate_reviews_candidate_company_fk', 'duplicate_reviews_matched_company_fk');
  if n <> 2 then
    raise exception '0088 fail-closed: composite company FKs missing (found %)', n;
  end if;

  if has_function_privilege('service_role', 'public.resolve_duplicate_review(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.resolve_duplicate_review(uuid,text,text)', 'EXECUTE') then
    raise exception '0088 fail-closed: resolve_duplicate_review must stay executable by `authenticated` only';
  end if;
end
$$;

commit;
