-- ⛔ R1/R2B DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
-- Owner decision R1-D-1: no production migration number until PR-F-001 and PR-F-004 close.
--
-- R2B_DRAFT_015 — the human feedback and outcome runtime path (owner Decision 3).
--
-- Unit 006 created `management_item_feedback` so the learning signal would not be lost. Nothing
-- ever wrote to it. This unit gives it a door: a service-only RPC that is the ONLY way a row can
-- appear, carrying every rule the owner set.
--
-- WHY THE RULES LIVE HERE AND NOT ONLY IN THE APPLICATION. Feedback is the input to learning, so
-- a forged or careless row does not merely record something false — it changes future
-- recommendations about a person. An application guard protects the caller that was written
-- against it; a database guard protects the ones nobody has written yet.

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 1. The structured events the owner specified.
--
--    The original four values are KEPT. They are what unit 006 documented and what any existing
--    reader expects; removing them to make the list tidier would be a breaking change bought
--    with nothing.
-- ─────────────────────────────────────────────────────────────────────────────────────────
alter table management_item_feedback
  drop constraint if exists management_item_feedback_feedback_type_check;
alter table management_item_feedback
  add constraint management_item_feedback_feedback_type_check check (
    feedback_type in (
      -- unit 006
      'decision_reason', 'assignment_override', 'verification_result', 'detector_precision',
      -- owner Decision 3
      'recommendation_accepted', 'recommendation_rejected', 'different_candidate_selected',
      'outcome_successful', 'outcome_unsuccessful', 'result_disputed',
      'correction_supplied', 'insufficient_evidence'
    )
  );

-- Corrections SUPERSEDE without deleting. The superseded row stays exactly as written: an
-- audit trail that can be rewritten is not an audit trail, and "what we believed at the time"
-- is often the most important thing in it.
alter table management_item_feedback
  add column if not exists supersedes_id uuid references management_item_feedback(id) on delete restrict;

-- The membership the feedback is ABOUT, when it concerns a person. Kept separate from actor_id:
-- who is being judged and who is judging are different questions and must never be merged.
alter table management_item_feedback
  add column if not exists subject_membership_id uuid;

-- A bounded, plain-text comment. Bounded because an unbounded free-text field on a learning
-- input is both a storage risk and a place for someone to paste a protected attribute.
alter table management_item_feedback
  add column if not exists comment text;
alter table management_item_feedback
  drop constraint if exists management_item_feedback_comment_len_ck;
alter table management_item_feedback
  add constraint management_item_feedback_comment_len_ck
  check (comment is null or char_length(comment) <= 2000);

create index if not exists mif_subject_idx
  on management_item_feedback (company_id, subject_membership_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 2. A correction may only supersede a row for the SAME item, and only once.
--
--    Without the uniqueness, "correcting" a row twice would produce two live corrections and the
--    fold would have to guess which one counts.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create unique index if not exists mif_supersedes_uq
  on management_item_feedback (supersedes_id) where supersedes_id is not null;

create or replace function r1_draft_feedback_correction_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_prev record;
begin
  if new.supersedes_id is null then return new; end if;

  select id, company_id, item_id into v_prev
    from public.management_item_feedback where id = new.supersedes_id;

  if not found then
    raise exception 'cannot supersede feedback % — it does not exist', new.supersedes_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_prev.company_id is distinct from new.company_id then
    raise exception 'a correction may not cross a company boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if v_prev.item_id is distinct from new.item_id then
    raise exception 'a correction must concern the SAME management item'
      using errcode = 'check_violation';
  end if;
  if new.id = new.supersedes_id then
    raise exception 'feedback cannot supersede itself' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists mif_correction_guard on management_item_feedback;
create trigger mif_correction_guard
  before insert on management_item_feedback
  for each row execute function r1_draft_feedback_correction_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 3. The ONLY door: a service-only RPC.
--
--    Direct INSERT is refused for the API roles, exactly as for management_items, so the rules
--    below cannot be walked around by writing to the table.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.r1_draft_record_feedback(
  p_company        uuid,
  p_item           uuid,
  p_actor          uuid,          -- the membership of the authenticated human
  p_feedback_type  text,
  p_subject        uuid default null,
  p_proposed       jsonb default null,
  p_actual         jsonb default null,
  p_reason         text  default null,
  p_comment        text  default null,
  p_supersedes     uuid  default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_item     record;
  v_actor_ok boolean;
  v_today    int;
  v_id       uuid;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'r1_draft_record_feedback is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  -- ── The item, and the COMPANY BOUNDARY. Feedback for another company must fail, and it
  --    fails on the item's own company rather than on anything the caller asserted.
  select id, company_id, state, accountable_owner_id into v_item
    from public.management_items where id = p_item;
  if not found then
    raise exception 'management item % does not exist', p_item using errcode = 'foreign_key_violation';
  end if;
  if v_item.company_id is distinct from p_company then
    raise exception 'feedback refused: item % belongs to another company', p_item
      using errcode = 'insufficient_privilege';
  end if;

  -- ── The ACTOR must be an active member of THIS company holding a task capability. There is
  --    no anonymous feedback and no cross-company feedback.
  if p_actor is null then
    raise exception 'feedback requires an identified human actor' using errcode = 'insufficient_privilege';
  end if;
  v_actor_ok := public.r1_draft_membership_can_own(p_company, p_actor);
  if not v_actor_ok then
    raise exception 'actor % is not an active authorised member of company %', p_actor, p_company
      using errcode = 'insufficient_privilege';
  end if;

  -- ── A VERIFIED OUTCOME REQUIRES THE LIFECYCLE EVIDENCE.
  --    "It went well" is only a verified outcome if the item actually reached `verified`.
  --    Otherwise it is an opinion, and opinions must not feed the learning fold as outcomes.
  if p_feedback_type = 'outcome_successful' then
    if not exists (
      select 1 from public.management_item_transitions t
       where t.item_id = p_item and t.to_state = 'verified'
    ) then
      raise exception
        'outcome_successful requires the item to have reached `verified`; item % is in state %',
        p_item, v_item.state
        using errcode = 'check_violation';
    end if;
    -- REOPENED WORK IS NOT SUCCESSFUL COMPLETION. If the item was sent back after its last
    -- verification, a success claim is refused until it is verified again.
    if exists (
      select 1
        from public.management_item_transitions r
       where r.item_id = p_item and r.to_state = 'reopened'
         and r.created_at > (
           select max(v.created_at) from public.management_item_transitions v
            where v.item_id = p_item and v.to_state = 'verified')
    ) then
      raise exception 'item % was reopened after its last verification and is not a successful outcome', p_item
        using errcode = 'check_violation';
    end if;
  end if;

  -- ── ONE MANAGER CANNOT FABRICATE HUNDREDS OF INDEPENDENT OUTCOMES.
  --    The learning fold already collapses a burst to one per decider per day; this refuses the
  --    burst at the source so the raw history is not filled with rows that will never count.
  select count(*) into v_today
    from public.management_item_feedback f
   where f.company_id = p_company
     and f.actor_id = p_actor
     and f.feedback_type = p_feedback_type
     and f.created_at >= date_trunc('day', now());
  if v_today >= 50 then
    raise exception
      'feedback refused: % has already recorded % "%" entries today', p_actor, v_today, p_feedback_type
      using errcode = 'check_violation';
  end if;
  -- And never twice for the SAME item, actor and type unless it is an explicit correction.
  if p_supersedes is null and exists (
    select 1 from public.management_item_feedback f
     where f.item_id = p_item and f.actor_id = p_actor and f.feedback_type = p_feedback_type
  ) then
    raise exception
      'feedback of type "%" already exists for item % from this actor; supply supersedes_id to correct it',
      p_feedback_type, p_item
      using errcode = 'unique_violation';
  end if;

  insert into public.management_item_feedback (
    company_id, item_id, feedback_type, proposed, actual, reason,
    actor_id, actor_type, subject_membership_id, comment, supersedes_id
  ) values (
    p_company, p_item, p_feedback_type, p_proposed, p_actual, p_reason,
    -- actor_type is FIXED to 'user'. A model-generated claim is not feedback, and there is no
    -- parameter through which a caller could label one as human.
    p_actor, 'user', p_subject, left(coalesce(p_comment, ''), 2000), p_supersedes
  ) returning id into v_id;

  return jsonb_build_object('ok', true, 'feedback_id', v_id);
end;
$$;

do $$
declare
  sig text := 'public.r1_draft_record_feedback(uuid,uuid,uuid,text,uuid,jsonb,jsonb,text,text,uuid)';
begin
  execute format('revoke all on function %s from public', sig);
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute format('revoke all on function %s from anon', sig);
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute format('revoke all on function %s from authenticated', sig);
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute format('grant execute on function %s to service_role', sig);
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 4. The RPC is only a boundary if it is the only door.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function r1_draft_guard_feedback_insert() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    raise exception 'feedback may only be recorded through r1_draft_record_feedback()'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists mif_guard_insert on management_item_feedback;
create trigger mif_guard_insert
  before insert on management_item_feedback
  for each row execute function r1_draft_guard_feedback_insert();
