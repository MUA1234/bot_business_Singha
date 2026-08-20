-- 0089_duplicate_review_sibling_and_budget.sql
-- OF-016 correction loop 2 of 2 (FINAL). Independent review 2 findings J-02 and J-03.
--
-- J-02 (P1) — THE PACKAGE RE-CREATED ITS OWN BLOCKER, ONE LAYER UP.
--
-- The detector writes ONE review per match, so a payment that resembles TWO earlier ones — the same
-- supplier paid the same amount in two prior months — raises two open reviews in a single pass.
-- Every test in this package seeded exactly one review per event, so nothing caught it.
--
-- When the reviewer CONFIRMS one, the financial event moves to `duplicate`, which is terminal. The
-- sibling review can then be resolved in NEITHER direction, forever:
--
--     confirm sibling → ERROR: the financial event is in state duplicate — only an event paused in
--                              awaiting_information can be resolved here
--     dismiss sibling → ERROR: (identical)
--     service_role UPDATE → refused (0087)      service_role DELETE → refused (0087)
--
-- Reproduced on a disposable local PostgreSQL 16. The queue then shows "1 awaiting a decision"
-- permanently; pressing either button returns the state error, which the server action reports as
-- "Somebody moved this event while you were deciding. Reload to see where it is now." — advice that
-- can never help. The health tile stays red. Nothing in the product, and no SQL reachable by an api
-- role, can clear it. That is precisely the "no way out" OF-016 exists to close.
--
-- The DISMISS path does not have this problem and is deliberately left alone: the event returns to
-- `draft`, the pipeline re-scores it against the surviving counterpart and pauses it again, and the
-- reviewer decides that pair on its merits. A dismissal of one pair says nothing about another, and
-- pretending otherwise would be the silent-merge this whole line of work exists to prevent.
--
-- Fix: when a decision TERMINALISES the event, the event's other open reviews are closed in the same
-- transaction with their OWN resolution — `superseded_by_decision` — naming the review that
-- terminalised it, each with its own audit row. It does not claim the human decided each pair. It
-- records that the question stopped being answerable, and why.
--
-- J-03 (P2) — a released payment survived exactly one transient failure.
--
-- 0088 cleared the dead-letter stamp but preserved `attempts`, and `fail_source_event` dead-letters
-- at `attempts >= max_attempts`. A release of an exhausted event therefore got ONE attempt: a single
-- provider 503 killed it permanently, landing in the H-01 end state (financial event `draft`, zero
-- approvals, unapprovable) and invisible — no approval request, review already `resolved`, and the
-- health "Dead letters" tile counts `dead_letter_events`, which the sweeper does not write.
--
-- A deliberate human release restores the retry budget. `attempts` resets to 0 and the PRIOR value
-- goes into the audit payload, so the history is preserved where it can be read rather than left in
-- a counter that silently kills the release. A half-revival is worse than none.
--
-- Forward-only. One CHECK widened, one function replaced.

begin;

set local search_path = pg_catalog, extensions, public, pg_temp;

-- ── J-02: the third resolution, and it is not a human verdict ────────────────────────────────
alter table public.duplicate_reviews drop constraint if exists duplicate_reviews_resolution_ck;
alter table public.duplicate_reviews
  add constraint duplicate_reviews_resolution_ck check (
    (state = 'open'
      and resolution is null and resolved_by is null and resolved_at is null
      and resolution_note is null)
    or
    (state = 'resolved'
      and resolution in ('confirmed_duplicate', 'dismissed_distinct', 'superseded_by_decision')
      and resolved_by is not null and resolved_at is not null
      and resolution_note is not null and btrim(resolution_note) <> '')
  );

comment on constraint duplicate_reviews_resolution_ck on public.duplicate_reviews is
  'Three outcomes. Two are human verdicts on THIS pair. `superseded_by_decision` is not a verdict at '
  'all: it records that the event was terminalised by a decision on a DIFFERENT pair, so this '
  'question stopped being answerable. It names the deciding review and carries the same actor, '
  'because that person''s decision is what closed it.';

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
  v_sib      record;
  v_prior_attempts int;
begin
  if v_actor is null then
    raise exception 'a duplicate review is a human decision — no authenticated subject'
      using errcode = 'insufficient_privilege';
  end if;
  -- `superseded_by_decision` is written BY this function, never asked for by a caller.
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

  -- LOCK ORDER (0087, unchanged): source_events → financial_events → duplicate_reviews.
  if v_src is not null then
    select * into v_src_row from public.source_events s where s.id = v_src for update;
  end if;

  select * into v_fe from public.financial_events fe
   where fe.id = v_rev.financial_event_id for update;
  if v_fe.id is null then
    raise exception 'the financial event behind this review no longer exists';
  end if;

  -- ALL of this event's reviews are locked, in one statement, in id order — the sibling closure
  -- below writes to them, and taking them together keeps the order total.
  perform 1 from public.duplicate_reviews r
   where r.financial_event_id = v_rev.financial_event_id
   order by r.id
     for update;
  select * into v_rev from public.duplicate_reviews r where r.id = p_review;

  if not public.actor_has_capability(v_actor, v_company, 'finance.duplicate.resolve') then
    raise exception 'you do not hold finance.duplicate.resolve in this company'
      using errcode = 'insufficient_privilege';
  end if;
  if v_fe.company_id is distinct from v_company then
    raise exception 'company mismatch between the review and its financial event — refusing'
      using errcode = 'insufficient_privilege';
  end if;
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

    -- J-02: this decision made the event terminal, so every OTHER open review on it stopped being
    -- answerable. Close them honestly and audit each one, rather than leaving a queue item no
    -- person and no api role can ever clear.
    for v_sib in
      select r.id, r.matched_event_id, r.score, r.algorithm_version
        from public.duplicate_reviews r
       where r.financial_event_id = v_rev.financial_event_id
         and r.id <> v_rev.id
         and r.state = 'open'
       order by r.id
    loop
      update public.duplicate_reviews
         set state = 'resolved',
             resolution = 'superseded_by_decision',
             resolved_by = v_actor,
             resolved_at = now(),
             resolution_note = left(
               'Superseded: this payment was confirmed a duplicate of another transaction, so this '
               'question is no longer answerable. Deciding review: ' || v_rev.id::text, 500)
       where id = v_sib.id;

      insert into public.audit_events
        (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
      values (
        v_company, 'user', v_actor::text, 'finance.duplicate_review_superseded',
        'duplicate_review', v_sib.id::text,
        jsonb_build_object(
          'superseded_by_review', v_rev.id,
          'financial_event_id',   v_rev.financial_event_id,
          'matched_event_id',     v_sib.matched_event_id,
          'score',                v_sib.score,
          'algorithm_version',    v_sib.algorithm_version,
          -- Said plainly, so nobody later reads this as a person's verdict on this pair.
          'note', 'Not a human verdict on this pair — the event became terminal by a decision on another pair.'
        )
      );
    end loop;

  else  -- dismissed_distinct
    update public.financial_events
       set state = 'draft', updated_at = now()
     where id = v_fe.id;

    -- The sibling reviews are deliberately LEFT OPEN here. A dismissal of one pair says nothing
    -- about another: the event returns to `draft`, the pipeline re-scores it against the surviving
    -- counterparts and pauses it again, and the reviewer decides that pair on its own merits.
    -- Closing them would be the silent merge this whole line of work exists to prevent.

    v_prior_attempts := coalesce(v_src_row.attempts, 0);
    if v_src is not null then
      update public.source_events
         set status = 'pending',
             next_attempt_at = now(),
             lease_owner = null,
             lease_acquired_at = null,
             lease_expires_at = null,
             processed_at = null,
             dead_lettered_at = null,
             dead_letter_reason = null,
             -- J-03: a deliberate human release restores the RETRY BUDGET. Preserving `attempts`
             -- read as "history is not reset deceptively", but `fail_source_event` dead-letters at
             -- attempts >= max_attempts, so a released event that had already spent its budget died
             -- on the first ordinary provider error — with no second release, because a replay
             -- returns the standing decision before re-arming anything. The prior count is carried
             -- into the audit payload below, so the history is kept where it can be read instead of
             -- in a counter that silently kills the release.
             attempts = 0
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
      'cleared_dead_letter', (p_resolution = 'dismissed_distinct'
                              and v_src_row.dead_lettered_at is not null),
      'prior_dead_letter_reason', case
        when p_resolution = 'dismissed_distinct' then v_src_row.dead_letter_reason else null end,
      'prior_attempts', case
        when p_resolution = 'dismissed_distinct' then v_prior_attempts else null end,
      'superseded_sibling_reviews', case when p_resolution = 'confirmed_duplicate' then (
        select coalesce(jsonb_agg(r.id order by r.id), '[]'::jsonb)
          from public.duplicate_reviews r
         where r.financial_event_id = v_rev.financial_event_id
           and r.id <> v_rev.id
           and r.resolution = 'superseded_by_decision'
           and r.resolved_at >= now() - interval '1 second') else null end
    )
  );

  return query select v_rev.id, 'resolved'::text, p_resolution, v_rev.financial_event_id, false;
end
$$;

revoke all on function public.resolve_duplicate_review(uuid, text, text) from public, anon, service_role;
grant execute on function public.resolve_duplicate_review(uuid, text, text) to authenticated;

do $$
begin
  if has_function_privilege('service_role', 'public.resolve_duplicate_review(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.resolve_duplicate_review(uuid,text,text)', 'EXECUTE') then
    raise exception '0089 fail-closed: resolve_duplicate_review must stay executable by `authenticated` only';
  end if;
end
$$;

commit;
