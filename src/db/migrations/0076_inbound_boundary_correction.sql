-- 0076 — inbound boundary correction (correction loop 1 for AIM-002 / AIM-003 / FOUND-003).
--
-- PART ONE: one provider message, one canonical event, at most one dispatch.
-- PART TWO: the database defects an independent adversarial review confirmed in 0072, 0074 and
--           0075 — each reproduced on live PostgreSQL before being accepted. They are in one
--           migration because they are one correction of one boundary, and none of 0069–0075 has
--           been applied outside disposable databases.
--
-- THE DEFECT. A single inbound WhatsApp message produced TWO `source_events` rows:
--   * the webhook's persist-first step wrote `idempotency_key = 'in_' || sha256(channel:id)`;
--   * `ingestSourceEvent`, reached later through the dispatcher for a staff finance capture,
--     computed its own `'evt_' || sha256(source:id)` and inserted a SECOND row.
-- Two rows for one message, and the consequences were not cosmetic: `claim_source_events` claims any
-- row in a fresh state, so EVERY inbound message — customer orders included — became claimable work
-- for the inbound sweeper, and the unprocessed-events health signal counted receipts that were never
-- meant to be processed. The health signal was therefore not truthful.
--
-- WHY THE ONE-LINE FIX IS WRONG. Aligning the two keys makes `ingestSourceEvent` find the row
-- already present, report `duplicate`, and NOT ENQUEUE — silently ending finance capture. The
-- divergent keys were masking a missing concept, not causing the problem. The missing concept is an
-- explicit DISPATCH lifecycle, separate from the consumer lifecycle that 0069 added.
--
-- WHAT THIS MIGRATION ADDS
--
--   1. A canonical event identity, derived from TRUSTED PROVIDER FACTS ONLY:
--        'ev1:' || channel || ':' || receiving account || ':' || provider message id || ':' || purpose
--      The receiving account (WhatsApp `metadata.phone_number_id`) is known at receipt time and maps
--      to exactly one company (migration 0074), so the identity is company-scoped WITHOUT depending
--      on a company that has not been resolved yet. Message TEXT is never part of the identity: two
--      people sending the same words are two events.
--      No provider message id ⇒ NO identity. Such a receipt is never merged with anything and is
--      routed to manual review instead — merging unrelated identical messages is worse than a queue
--      item a person looks at.
--
--   2. An explicit dispatch lifecycle on the receipt:
--        pending → dispatching (leased) → dispatched | manual_review | failed → dead_letter
--      plus `superseded` for reconciled legacy rows. `dispatched` carries WHAT it turned into
--      (`dispatch_outcome`) and a link to the durable downstream record it produced.
--
--   3. Consumer claimability is now EXPLICIT. `claim_source_events` only claims a receipt that was
--      dispatched as a finance capture (or a legacy row backfilled to preserve today's behaviour),
--      and never a superseded one. This is the actual fix for the sweeper claiming everything.
--
-- CRASH SEMANTICS. The downstream effect is created FIRST and the dispatched marker written after,
-- so a crash can never leave a marker without an effect. It can leave an effect without a marker —
-- and that is safe because every downstream is independently idempotent (task identity 0071, the
-- review queue's per-message unique index 0075, `wa_messages` dedupe on the provider id, and the
-- receipt's own identity here). The retry re-runs, finds the existing record, and finishes the
-- marker. "At most one business dispatch" is enforced by the LEASE: two concurrent deliveries of the
-- same message both find one receipt, and only one of them can move it pending → dispatching.
--
-- Forward-only, idempotent DDL. No feature flag (a correctness boundary, not a capability).

begin;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (1) Columns
-- ─────────────────────────────────────────────────────────────────────────────────────────────
alter table public.source_events
  add column if not exists provider_account_id       text,
  add column if not exists event_identity            text,
  add column if not exists event_purpose             text not null default 'inbound_message',
  add column if not exists dispatch_state            text not null default 'pending',
  add column if not exists dispatch_outcome          text,
  add column if not exists dispatch_owner            text,
  add column if not exists dispatch_attempts         integer not null default 0,
  add column if not exists dispatch_lease_expires_at timestamptz,
  add column if not exists dispatched_at             timestamptz,
  add column if not exists downstream_kind           text,
  add column if not exists downstream_id             uuid,
  add column if not exists superseded_by             uuid references public.source_events(id);

comment on column public.source_events.provider_account_id is
  'OUR account that received the message (WhatsApp metadata.phone_number_id). Trusted: the provider sets it and a sender cannot influence it. Scopes the canonical identity and resolves the company (migration 0074).';
comment on column public.source_events.event_identity is
  'Canonical identity of the provider event. NULL when the provider gave no message id — such a receipt is never deduplicated against anything.';
comment on column public.source_events.dispatch_state is
  'Progress of the DECISION about this message, separate from the consumer processing lifecycle that 0069 governs.';
comment on column public.source_events.superseded_by is
  'Set when this row was proven to be a redundant receipt for another row (see the 0076 reconciliation). A superseded row is never claimed and never counted as outstanding work.';

alter table public.source_events drop constraint if exists source_events_dispatch_state_check;
alter table public.source_events add constraint source_events_dispatch_state_check
  check (dispatch_state = any (array[
    'pending',       -- durably received, not yet decided
    'dispatching',   -- leased by exactly one dispatcher
    'dispatched',    -- decided; the downstream effect exists
    'manual_review', -- cannot be decided automatically; a person has it
    'failed',        -- retryable dispatch failure, waiting for backoff
    'dead_letter',   -- dispatch attempts exhausted
    'superseded'     -- reconciled against a canonical row (see superseded_by)
  ]));

-- A superseded row must SAY what superseded it, and a row may not supersede itself.
alter table public.source_events drop constraint if exists source_events_supersede_complete;
alter table public.source_events add constraint source_events_supersede_complete
  check (
    (dispatch_state <> 'superseded' and superseded_by is null)
    or (dispatch_state = 'superseded' and superseded_by is not null)
  );
alter table public.source_events drop constraint if exists source_events_no_self_supersede;
alter table public.source_events add constraint source_events_no_self_supersede
  check (superseded_by is null or superseded_by <> id);

-- THE identity constraint: one canonical event per provider message. Partial, so the identity-less
-- receipts (no provider message id) do not collide with each other — they are individually visible
-- rather than silently merged.
create unique index if not exists source_events_event_identity_uq
  on public.source_events (event_identity)
  where event_identity is not null;

create index if not exists source_events_dispatch_eligible_idx
  on public.source_events (dispatch_state, next_attempt_at)
  where dispatch_state in ('pending', 'failed', 'dispatching');

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (2) Canonical identity
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.canonical_event_identity(
  p_channel text,
  p_provider_account_id text,
  p_provider_message_id text,
  p_purpose text default 'inbound_message'
)
returns text
language sql
immutable
set search_path = pg_catalog, extensions, public, pg_temp
as $$
  -- NULL when the provider gave us nothing stable to identify the event by. A null identity is not
  -- deduplicated: refusing to guess beats merging two people's messages because they typed the same
  -- words. `ev1:` is a version marker so a future identity rule cannot silently collide with this one.
  select case
    when nullif(btrim(coalesce(p_channel, '')), '') is null then null
    when nullif(btrim(coalesce(p_provider_message_id, '')), '') is null then null
    else 'ev1:' || lower(btrim(p_channel))
      || ':' || coalesce(public.normalize_channel_account(p_provider_account_id), '-')
      || ':' || btrim(p_provider_message_id)
      || ':' || lower(btrim(coalesce(nullif(btrim(p_purpose), ''), 'inbound_message')))
  end;
$$;

revoke all on function public.canonical_event_identity(text, text, text, text) from public, anon, authenticated;
grant execute on function public.canonical_event_identity(text, text, text, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (3) Backfill + reconciliation of the existing in_/evt_ pairs
--
-- These migrations are unreleased, but disposable and developer databases hold the duplicate rows,
-- so the forward path must handle them. NOTHING IS DELETED. Where equivalence is provable the
-- redundant receipt is marked `superseded` with an auditable link; where it is not provable the row
-- is left visible in `manual_review` for a person.
-- ─────────────────────────────────────────────────────────────────────────────────────────────

-- 3a. Recover the receiving account from what the webhook stored, where it is there.
update public.source_events s
   set provider_account_id = s.raw_payload->>'receivedBy'
 where s.provider_account_id is null
   and s.raw_payload ? 'receivedBy'
   and nullif(btrim(s.raw_payload->>'receivedBy'), '') is not null;

-- 3b. Preserve TODAY'S consumer behaviour for every pre-existing row, so this migration changes no
--     row's claimability except the ones it proves are redundant.
--       'evt_%' — written by ingestSourceEvent, i.e. an actual capture. Stays claimable.
--       'in_%'  — a webhook receipt. The webhook decided it inline at the time; it was never
--                 consumer work, and treating it as such is the defect being fixed.
update public.source_events
   set dispatch_state = 'dispatched',
       dispatch_outcome = case when idempotency_key like 'evt\_%' then 'staff_finance' else 'legacy_receipt' end,
       dispatched_at = coalesce(dispatched_at, received_at)
 where dispatch_state = 'pending'
   and (idempotency_key like 'evt\_%' or idempotency_key like 'in\_%');

-- Any other pre-existing shape is not classified by the rule above. Make it VISIBLE rather than
-- guessing: a person decides, and until then it is not claimed as consumer work.
update public.source_events
   set dispatch_state = 'manual_review',
       dispatch_outcome = 'unclassified_legacy_receipt'
 where dispatch_state = 'pending'
   and idempotency_key not like 'evt\_%'
   and idempotency_key not like 'in\_%';

-- 3c. Reconcile provable pairs. Equivalence requires the SAME source and provider message id, one
--     'in_' receipt and one 'evt_' capture, and content hashes that do not contradict each other.
--     The capture survives: downstream records (financial events, documents, reviews) reference it.
with pairs as (
  select
    r.id  as receipt_id,
    c.id  as capture_id
  from public.source_events r
  join public.source_events c
    on c.source = r.source
   and c.provider_message_id = r.provider_message_id
   and c.id <> r.id
  where r.provider_message_id is not null
    and r.idempotency_key like 'in\_%'
    and c.idempotency_key like 'evt\_%'
    and r.dispatch_state <> 'superseded'
    -- Not contradictory: equal hashes, or one side never recorded one.
    and (r.content_hash is null or c.content_hash is null or r.content_hash = c.content_hash)
    -- Exactly one candidate on each side, or we cannot prove which pairs with which.
    and (select count(*) from public.source_events x
          where x.source = r.source and x.provider_message_id = r.provider_message_id
            and x.idempotency_key like 'in\_%') = 1
    and (select count(*) from public.source_events x
          where x.source = r.source and x.provider_message_id = r.provider_message_id
            and x.idempotency_key like 'evt\_%') = 1
),
-- A receipt that something downstream already points at is NOT safely redundant.
referenced as (
  select p.receipt_id from pairs p
   where exists (select 1 from public.conversation_references t where t.source_event_id = p.receipt_id)
      or exists (select 1 from public.dead_letter_events t where t.source_event_id = p.receipt_id)
      or exists (select 1 from public.documents t where t.source_event_id = p.receipt_id)
      or exists (select 1 from public.financial_events t where t.source_event_id = p.receipt_id)
      or exists (select 1 from public.inbound_reviews t where t.source_event_id = p.receipt_id)
)
update public.source_events s
   set dispatch_state = 'superseded',
       superseded_by = p.capture_id,
       dispatch_outcome = 'superseded_duplicate_receipt',
       status = case when s.status in ('received', 'pending') then 'duplicate' else s.status end
  from pairs p
 where s.id = p.receipt_id
   and p.receipt_id not in (select receipt_id from referenced);

-- A pair whose receipt IS referenced downstream cannot be proven redundant. Leave it visible.
update public.source_events s
   set dispatch_state = 'manual_review',
       dispatch_outcome = 'duplicate_receipt_with_downstream_references'
 where s.idempotency_key like 'in\_%'
   and s.dispatch_state <> 'superseded'
   and s.provider_message_id is not null
   and exists (
     select 1 from public.source_events c
      where c.source = s.source and c.provider_message_id = s.provider_message_id
        and c.id <> s.id and c.idempotency_key like 'evt\_%'
   )
   and (
     exists (select 1 from public.conversation_references t where t.source_event_id = s.id)
     or exists (select 1 from public.dead_letter_events t where t.source_event_id = s.id)
     or exists (select 1 from public.documents t where t.source_event_id = s.id)
     or exists (select 1 from public.financial_events t where t.source_event_id = s.id)
     or exists (select 1 from public.inbound_reviews t where t.source_event_id = s.id)
   );

-- 3d. Stamp the canonical identity on everything that survives, LOWEST id first so a legacy
--     collision (two rows that would now share an identity) leaves the later row without one
--     rather than failing the migration. A row left without an identity is still processed; it
--     simply does not participate in deduplication, which is the safe direction.
do $$
declare
  r record;
  v_identity text;
begin
  -- A SUPERSEDED row is a tombstone. It must never take the identity the surviving canonical row
  -- needs — an independent review found the older `in_` receipt winning it, leaving the live capture
  -- unidentified and a redelivery resolving to the tombstone. Survivors only, and the receiving
  -- account recovered from the paired receipt so the survivor is not stamped with the unknown-account
  -- placeholder.
  -- Alias `tomb`, not `r`: `r` is the loop's RECORD variable below, and plpgsql resolves the
  -- FROM-clause name to it ("record r is not assigned yet").
  update public.source_events c
     set provider_account_id = tomb.provider_account_id
    from public.source_events tomb
   where tomb.superseded_by = c.id
     and c.provider_account_id is null
     and tomb.provider_account_id is not null;

  for r in
    select id, source, provider_account_id, provider_message_id, event_purpose
      from public.source_events
     where event_identity is null and provider_message_id is not null
       and dispatch_state <> 'superseded'
     order by received_at, id
  loop
    v_identity := public.canonical_event_identity(r.source, r.provider_account_id, r.provider_message_id, r.event_purpose);
    if v_identity is not null
       and not exists (select 1 from public.source_events x where x.event_identity = v_identity) then
      update public.source_events set event_identity = v_identity where id = r.id;
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (4) Receipt — the ONE place an inbound provider message becomes a row
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.record_inbound_receipt(
  p_source text,
  p_provider_account_id text,
  p_provider_message_id text,
  p_raw_payload jsonb,
  p_content_hash text,
  p_correlation_id text,
  p_purpose text default 'inbound_message'
)
returns table (event_id uuid, created boolean, event_identity text, dispatch_state text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_identity   text;
  v_id         uuid;
  v_state      text;
  v_found_id    uuid;
  v_found_state text;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'record_inbound_receipt is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_source), '') = '' then raise exception 'p_source is required'; end if;
  if p_raw_payload is null then raise exception 'p_raw_payload is required — a receipt without the original event is not a receipt'; end if;

  v_identity := public.canonical_event_identity(p_source, p_provider_account_id, p_provider_message_id, p_purpose);

  -- No trustworthy provider message id ⇒ no identity, and the receipt goes to a person. It is never
  -- merged with another message, and it is never silently dropped.
  v_state := case when v_identity is null then 'manual_review' else 'pending' end;

  if v_identity is not null then
    -- SEPARATE variables on purpose. `select … into` sets EVERY target to NULL when no row matches,
    -- so reusing v_state here nulled the value computed above and the insert then violated the
    -- NOT NULL constraint. Caught by the first run of the integration suite.
    select s.id, s.dispatch_state into v_found_id, v_found_state
      from public.source_events s where s.event_identity = v_identity;
    if v_found_id is not null then
      return query select v_found_id, false, v_identity, v_found_state;
      return;
    end if;
  end if;

  begin
    insert into public.source_events (
      source, provider_message_id, provider_account_id, company_id, raw_payload, content_hash,
      idempotency_key, correlation_id, status, event_identity, event_purpose, dispatch_state,
      dispatch_outcome
    ) values (
      p_source, nullif(btrim(p_provider_message_id), ''), public.normalize_channel_account(p_provider_account_id), null,
      p_raw_payload, p_content_hash,
      coalesce(v_identity, 'noid:' || gen_random_uuid()::text), coalesce(nullif(btrim(p_correlation_id), ''), gen_random_uuid()::text),
      'received', v_identity, coalesce(nullif(btrim(p_purpose), ''), 'inbound_message'), v_state,
      case when v_identity is null then 'no_provider_message_id' else null end
    )
    returning id into v_id;
    return query select v_id, true, v_identity, v_state;
  exception when unique_violation then
    -- A concurrent delivery won the race. Return THEIR row: one message, one receipt.
    select s.id, s.dispatch_state into v_found_id, v_found_state
      from public.source_events s where s.event_identity = v_identity;
    if v_found_id is null then
      raise exception 'unique violation on event identity but no surviving row found';
    end if;
    return query select v_found_id, false, v_identity, v_found_state;
  end;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (5) Dispatch lease — "at most one business dispatch"
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.claim_inbound_dispatch(
  p_event uuid,
  p_owner text,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v record;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'claim_inbound_dispatch is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_owner), '') = '' then
    raise exception 'p_owner is required — an unnamed lease cannot be recovered or audited';
  end if;

  select id, dispatch_state, dispatch_lease_expires_at, next_attempt_at
    into v
    from public.source_events where id = p_event for update;
  if not found then raise exception 'source event % not found', p_event; end if;

  -- Already decided, superseded, terminal, or with a person: nothing to dispatch.
  if v.dispatch_state in ('dispatched', 'superseded', 'manual_review', 'dead_letter') then
    return false;
  end if;
  -- Someone else holds a LIVE lease. Only an EXPIRED lease may be taken over, which is how a
  -- crashed dispatcher's work is recovered without two dispatchers ever running at once.
  if v.dispatch_state = 'dispatching'
     and v.dispatch_lease_expires_at is not null
     and v.dispatch_lease_expires_at > now() then
    return false;
  end if;
  -- A failed row waits for its backoff.
  if v.dispatch_state = 'failed' and v.next_attempt_at > now() then
    return false;
  end if;

  update public.source_events
     set dispatch_state = 'dispatching',
         dispatch_owner = p_owner,
         dispatch_attempts = dispatch_attempts + 1,
         dispatch_lease_expires_at = now() + make_interval(secs => greatest(1, p_lease_seconds))
   where id = p_event;
  return true;
end;
$$;

/**
 * Record what the dispatch decided, atomically with making the event available to the consumer
 * pipeline. Called AFTER the downstream effect exists, so a crash cannot leave a marker without one.
 */
create or replace function public.record_inbound_dispatch(
  p_event uuid,
  p_owner text,
  p_outcome text,
  p_company uuid default null,
  p_downstream_kind text default null,
  p_downstream_id uuid default null
)
returns table (dispatch_state text, consumer_ready boolean, already boolean)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v record;
  v_capture boolean;
  v_state text;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'record_inbound_dispatch is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if p_outcome not in ('customer_order', 'staff_finance', 'manual_review', 'recorded', 'clarification') then
    raise exception 'unsupported dispatch outcome %', p_outcome;
  end if;

  -- ALIASED on purpose: `dispatch_state` is also an OUT parameter of this function, and an
  -- unqualified reference is ambiguous ("column reference dispatch_state is ambiguous").
  select s.id, s.dispatch_state, s.dispatch_owner, s.dispatch_outcome, s.company_id
    into v from public.source_events s where s.id = p_event for update;
  if not found then raise exception 'source event % not found', p_event; end if;

  if v.dispatch_state = 'superseded' then
    raise exception 'a superseded receipt cannot be dispatched';
  end if;

  -- IDEMPOTENT REPLAY. A retry that already recorded this outcome succeeds and changes nothing.
  if v.dispatch_state in ('dispatched', 'manual_review') then
    if v.dispatch_outcome is distinct from p_outcome then
      raise exception 'event % is already dispatched as % — refusing to rewrite it as %',
        p_event, v.dispatch_outcome, p_outcome;
    end if;
    -- `already` is what makes an enqueue exactly-once: the caller enqueues only on the transition,
    -- never on a replay, so a redelivery cannot produce a second processing job.
    return query select v.dispatch_state, (v.dispatch_outcome = 'staff_finance'), true;
    return;
  end if;

  if v.dispatch_owner is distinct from p_owner then
    raise exception 'dispatch lease is held by a different worker' using errcode = 'lock_not_available';
  end if;

  v_capture := (p_outcome = 'staff_finance');
  v_state := case when p_outcome = 'manual_review' then 'manual_review' else 'dispatched' end;

  update public.source_events
     set dispatch_state = v_state,
         dispatch_outcome = p_outcome,
         dispatched_at = now(),
         dispatch_owner = null,
         dispatch_lease_expires_at = null,
         downstream_kind = coalesce(p_downstream_kind, downstream_kind),
         downstream_id = coalesce(p_downstream_id, downstream_id),
         -- Company scope is a TRUSTED parameter and is only ever FILLED IN, never changed: an event
         -- does not move between companies.
         company_id = coalesce(company_id, p_company),
         -- Only a finance capture becomes consumer work. This is the fix for the sweeper claiming
         -- every inbound message, and it happens in the SAME transaction as the decision.
         status = case when v_capture then 'pending' else status end,
         next_attempt_at = case when v_capture then now() else next_attempt_at end
   where id = p_event;

  return query select v_state, v_capture, false;
end;
$$;

create or replace function public.fail_inbound_dispatch(
  p_event uuid,
  p_owner text,
  p_error_code text,
  p_error text,
  p_max_attempts integer default 5
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v record;
  v_delay integer;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'fail_inbound_dispatch is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  select id, dispatch_state, dispatch_owner, dispatch_attempts
    into v from public.source_events where id = p_event for update;
  if not found then raise exception 'source event % not found', p_event; end if;
  if v.dispatch_state in ('dispatched', 'manual_review', 'dead_letter', 'superseded') then
    return v.dispatch_state; -- a late failure report never reopens a settled receipt
  end if;
  if v.dispatch_owner is distinct from p_owner then
    raise exception 'dispatch lease is held by a different worker' using errcode = 'lock_not_available';
  end if;

  if coalesce(v.dispatch_attempts, 0) >= greatest(1, p_max_attempts) then
    -- Exhausted. A person gets it rather than it disappearing into a dead-letter nobody reads.
    update public.source_events
       set dispatch_state = 'manual_review',
           dispatch_outcome = 'dispatch_attempts_exhausted',
           dispatch_owner = null,
           dispatch_lease_expires_at = null,
           last_error = left(coalesce(p_error, 'unknown'), 2000),
           last_error_code = left(coalesce(p_error_code, 'unknown'), 100)
     where id = p_event;
    return 'manual_review';
  end if;

  v_delay := public.inbound_backoff_seconds(coalesce(v.dispatch_attempts, 0));
  update public.source_events
     set dispatch_state = 'failed',
         dispatch_owner = null,
         dispatch_lease_expires_at = null,
         next_attempt_at = now() + make_interval(secs => v_delay),
         last_error = left(coalesce(p_error, 'unknown'), 2000),
         last_error_code = left(coalesce(p_error_code, 'unknown'), 100)
   where id = p_event;
  return 'failed';
end;
$$;

-- Batch claim for the durable worker: the same lease rule, applied to whatever is eligible.
create or replace function public.claim_inbound_dispatch_batch(
  p_limit integer,
  p_owner text,
  p_lease_seconds integer default 120
)
returns setof public.source_events
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'claim_inbound_dispatch_batch is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_owner), '') = '' then raise exception 'p_owner is required'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'p_limit must be between 1 and 500 (got %)', p_limit;
  end if;

  return query
  with eligible as (
    select e.id from public.source_events e
     where (
             (e.dispatch_state in ('pending', 'failed') and e.next_attempt_at <= now())
             -- …or a dispatcher died: the lease expired and the receipt is recoverable.
             or (e.dispatch_state = 'dispatching'
                 and e.dispatch_lease_expires_at is not null
                 and e.dispatch_lease_expires_at < now())
           )
     order by e.received_at, e.id
     limit p_limit
     for update skip locked
  )
  update public.source_events s
     set dispatch_state = 'dispatching',
         dispatch_owner = p_owner,
         dispatch_attempts = s.dispatch_attempts + 1,
         dispatch_lease_expires_at = now() + make_interval(secs => greatest(1, p_lease_seconds))
    from eligible el
   where s.id = el.id
  returning s.*;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (6) The consumer sweeper claims ONLY dispatched finance captures, never a superseded row
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.claim_source_events(
  p_limit integer,
  p_owner text,
  p_lease_seconds integer default 120
)
returns setof public.source_events
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'claim_source_events is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_owner), '') = '' then
    raise exception 'p_owner is required — an unnamed lease cannot be recovered or audited';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'p_limit must be between 1 and 500 (got %)', p_limit;
  end if;

  return query
  with eligible as (
    select e.id
      from public.source_events e
     where e.dead_lettered_at is null
       -- 0076: a receipt is consumer work ONLY once it was dispatched as a finance capture. Before
       -- this, every inbound message — customer orders included — was claimable, so the sweeper
       -- would have churned unrelated receipts through retries into dead letters.
       and e.dispatch_state = 'dispatched'
       and e.dispatch_outcome = 'staff_finance'
       and e.superseded_by is null
       and (
         (e.status in ('received', 'pending', 'retry_wait') and e.next_attempt_at <= now())
         or (e.status = 'processing' and e.lease_expires_at is not null and e.lease_expires_at < now())
       )
     order by e.next_attempt_at, e.id
     limit p_limit
     for update skip locked
  )
  update public.source_events s
     set status            = 'processing',
         attempts          = coalesce(s.attempts, 0) + 1,
         lease_owner       = p_owner,
         lease_acquired_at = now(),
         lease_expires_at  = now() + make_interval(secs => greatest(1, p_lease_seconds))
    from eligible el
   where s.id = el.id
  returning s.*;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (7) Health: truthful, company-scoped, and blind to safely superseded rows
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- The OUT columns change (dispatch counters are added), so the old signature must go first.
-- Grants are re-applied explicitly at the end of this migration.
drop function if exists public.source_event_backlog(uuid);
create or replace function public.source_event_backlog(p_company uuid)
returns table (
  pending bigint,
  processing bigint,
  retry_wait bigint,
  expired_lease bigint,
  dead_letter bigint,
  awaiting_dispatch bigint,
  dispatch_manual_review bigint,
  oldest_pending_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'source_event_backlog is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if p_company is null then
    raise exception 'p_company is required — an unscoped backlog count leaks across companies';
  end if;

  return query
  select
    -- Consumer work only: a receipt that was never dispatched as a capture is not consumer backlog.
    count(*) filter (where s.dead_lettered_at is null and s.status in ('received','pending')
                       and s.dispatch_state = 'dispatched' and s.dispatch_outcome = 'staff_finance')::bigint,
    count(*) filter (where s.status = 'processing')::bigint,
    count(*) filter (where s.status = 'retry_wait')::bigint,
    count(*) filter (where s.status = 'processing' and s.lease_expires_at is not null and s.lease_expires_at < now())::bigint,
    count(*) filter (where s.status = 'dead_letter')::bigint,
    count(*) filter (where s.dispatch_state in ('pending','dispatching','failed'))::bigint,
    count(*) filter (where s.dispatch_state = 'manual_review')::bigint,
    min(s.received_at) filter (where s.dead_lettered_at is null and s.status in ('received','pending')
                                 and s.dispatch_state = 'dispatched' and s.dispatch_outcome = 'staff_finance')
  from public.source_events s
  where s.company_id = p_company
    and s.dispatch_state <> 'superseded';   -- a reconciled duplicate is not outstanding work
end;
$$;

/**
 * Cross-company operator counts for /api/health. Counts only — never a row, never a message body —
 * so an operator signal cannot become a cross-tenant data leak.
 */
create or replace function public.inbound_dispatch_health()
returns table (
  awaiting_dispatch bigint,
  dispatching bigint,
  dispatch_failed bigint,
  dispatch_manual_review bigint,
  unattributed bigint,
  superseded bigint
)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'inbound_dispatch_health is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  return query
  select
    count(*) filter (where s.dispatch_state = 'pending')::bigint,
    count(*) filter (where s.dispatch_state = 'dispatching')::bigint,
    count(*) filter (where s.dispatch_state = 'failed')::bigint,
    count(*) filter (where s.dispatch_state = 'manual_review')::bigint,
    -- Genuinely unattributed: received, still undecided, and belonging to no company. A superseded
    -- row is excluded, so reconciliation does not silently inflate the signal.
    count(*) filter (where s.company_id is null and s.dispatch_state in ('pending','dispatching','failed','manual_review'))::bigint,
    count(*) filter (where s.dispatch_state = 'superseded')::bigint
  from public.source_events s;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (8) Privileges — service-only, named roles (a revoke aimed only at PUBLIC is not enough here)
-- ─────────────────────────────────────────────────────────────────────────────────────────────
revoke all on function public.record_inbound_receipt(text,text,text,jsonb,text,text,text) from public, anon, authenticated;
revoke all on function public.claim_inbound_dispatch(uuid,text,integer) from public, anon, authenticated;
revoke all on function public.claim_inbound_dispatch_batch(integer,text,integer) from public, anon, authenticated;
revoke all on function public.record_inbound_dispatch(uuid,text,text,uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.fail_inbound_dispatch(uuid,text,text,text,integer) from public, anon, authenticated;
revoke all on function public.inbound_dispatch_health() from public, anon, authenticated;
revoke all on function public.claim_source_events(integer,text,integer) from public, anon, authenticated;
revoke all on function public.source_event_backlog(uuid) from public, anon, authenticated;

grant execute on function public.record_inbound_receipt(text,text,text,jsonb,text,text,text) to service_role;
grant execute on function public.claim_inbound_dispatch(uuid,text,integer) to service_role;
grant execute on function public.claim_inbound_dispatch_batch(integer,text,integer) to service_role;
grant execute on function public.record_inbound_dispatch(uuid,text,text,uuid,text,uuid) to service_role;
grant execute on function public.fail_inbound_dispatch(uuid,text,text,text,integer) to service_role;
grant execute on function public.inbound_dispatch_health() to service_role;
grant execute on function public.claim_source_events(integer,text,integer) to service_role;
grant execute on function public.source_event_backlog(uuid) to service_role;

do $$
declare bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('record_inbound_receipt','claim_inbound_dispatch','claim_inbound_dispatch_batch',
                       'record_inbound_dispatch','fail_inbound_dispatch','inbound_dispatch_health',
                       'canonical_event_identity','claim_source_events','source_event_backlog')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if bad is not null then
    raise exception '0076 fail-closed: % reachable by anon/authenticated', bad;
  end if;

  -- The reconciliation must not have left a superseded row without its link, or a row pointing at
  -- itself, or a supersede chain (a superseded row must point at a SURVIVING canonical row).
  if exists (select 1 from public.source_events s
              where s.dispatch_state = 'superseded'
                and (s.superseded_by is null or s.superseded_by = s.id)) then
    raise exception '0076 fail-closed: a superseded receipt has no valid canonical link';
  end if;
  if exists (select 1 from public.source_events s
             join public.source_events t on t.id = s.superseded_by
              where s.dispatch_state = 'superseded' and t.dispatch_state = 'superseded') then
    raise exception '0076 fail-closed: a superseded receipt points at another superseded receipt';
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- PART TWO — confirmed review findings in 0072, 0074 and 0075
-- ═════════════════════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (9) 0072: the assignee capability re-check was a CONSTANT FALSE
--
-- `task_assignee_ineligible_reason` called `has_capability(p_assignee, p_capability)`. That
-- function's first parameter is `target_company`, so the assignee's USER id was being passed as a
-- COMPANY id, and the predicate resolved "does auth.uid() hold this capability in a company whose
-- id happens to equal that user id" — always false, and auth.uid() is null in a service worker
-- anyway. Both parameters are uuid/text, so nothing type-checked it.
--
-- REPRODUCED before accepting: an ACTIVE member holding `operations.inbound.review` through
-- `owner_management` returned `lacks_required_capability`, while the same user with no capability
-- required was eligible. Any routing that names a required capability could therefore NEVER reach
-- `assigned` — the state machine's main path was unreachable.
--
-- The correct call is the actor-scoped form migration 0075 introduced for exactly this purpose.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.task_assignee_ineligible_reason(
  p_company uuid,
  p_assignee uuid,
  p_capability text,
  p_submitter uuid default null
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_ok boolean;
begin
  if p_assignee is null then return 'no_assignee_proposed'; end if;

  select exists (
    select 1 from public.memberships m
     where m.user_id = p_assignee and m.company_id = p_company and m.status = 'active'
  ) into v_ok;
  if not v_ok then return 'not_active_member_of_company'; end if;

  select exists (
    select 1 from public.profiles pr
     where pr.id = p_assignee and pr.company_id = p_company and pr.is_active
  ) into v_ok;
  if not v_ok then return 'profile_inactive_or_missing'; end if;

  if coalesce(btrim(p_capability), '') <> '' then
    -- ACTOR-scoped: "does THIS ASSIGNEE hold this capability IN THIS COMPANY". The previous call
    -- asked a different question and always answered no.
    select public.actor_has_capability(p_assignee, p_company, p_capability) into v_ok;
    if not coalesce(v_ok, false) then return 'lacks_required_capability'; end if;
  end if;

  if p_submitter is not null and p_submitter = p_assignee then
    return 'separation_of_duties';
  end if;

  return null;
end;
$$;

revoke all on function public.task_assignee_ineligible_reason(uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.task_assignee_ineligible_reason(uuid,uuid,text,uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (10) 0072: routing history was not append-only against TRUNCATE, and a routing could name an
--      approval record that does not exist.
--
-- The append-only guard is a FOR EACH ROW BEFORE UPDATE OR DELETE trigger, and PostgreSQL never
-- fires row triggers for TRUNCATE — while `grant all … to service_role` includes TRUNCATE. The
-- claim "history may never be rewritten, even by the service role" was therefore false, and the
-- review demonstrated `TRUNCATE` emptying the table.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.task_routing_events_no_truncate()
returns trigger
language plpgsql
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  raise exception 'task_routing_events is append-only (attempted TRUNCATE)'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists task_routing_events_no_truncate_trg on public.task_routing_events;
create trigger task_routing_events_no_truncate_trg
  before truncate on public.task_routing_events
  for each statement execute function public.task_routing_events_no_truncate();

revoke truncate on public.task_routing_events from service_role;
revoke all on function public.task_routing_events_no_truncate() from public, anon, authenticated;

-- An `awaiting_approval` routing must name an approval record that EXISTS, in the same company.
-- Without this the state machine can point at nothing, which is the class of untruth AIM-003 is
-- meant to remove. Composite, so it cannot reference another company's approval.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'task_routing_approval_fk'
      and conrelid = 'public.task_routing'::regclass
  ) then
    -- Any pre-existing dangling reference is cleared first (only disposable databases can hold
    -- one), so adding the constraint cannot fail on legacy data.
    update public.task_routing r
       set approval_request_id = null
     where r.approval_request_id is not null
       and not exists (
         select 1 from public.approval_requests a
          where a.id = r.approval_request_id and a.company_id = r.company_id
       );
    alter table public.task_routing
      add constraint task_routing_approval_fk
      foreign key (company_id, approval_request_id)
      references public.approval_requests (company_id, id);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (11) 0072: an AI or system actor could silently supersede a HUMAN assignment
--
-- `route_task` had no guard on the previous row's `decided_by_source`, so a re-run of an analysis
-- could demote a manager's `assigned` decision back to `needs_routing` and report it as current.
-- A person's decision now stands, and the refused attempt is recorded as history rather than
-- discarded — the caller learns nothing changed instead of being told it did.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.route_task(
  p_company uuid,
  p_task uuid,
  p_desired_state text,
  p_reason_code text,
  p_required_capability text default null,
  p_proposed jsonb default '[]'::jsonb,
  p_assignee uuid default null,
  p_queue text default null,
  p_approval uuid default null,
  p_actor uuid default null,
  p_actor_source text default 'system',
  p_submitter uuid default null
)
returns table (routing_id uuid, routing_state text, reason_code text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_task     record;
  v_prev     record;
  v_state    text := p_desired_state;
  v_reason   text := p_reason_code;
  v_assignee uuid := p_assignee;
  v_bad      text;
  v_id       uuid;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'route_task is a service-only boundary' using errcode = 'insufficient_privilege';
  end if;
  if p_company is null or p_task is null then raise exception 'company and task are required'; end if;

  select t.id, t.company_id, t.status into v_task
    from public.tasks t where t.id = p_task for update;
  if not found then raise exception 'task % not found', p_task; end if;

  if v_task.company_id is distinct from p_company then
    raise exception 'task does not belong to this company' using errcode = 'insufficient_privilege';
  end if;

  if v_task.status in ('completed', 'cancelled') then
    raise exception 'task is % and cannot be routed', v_task.status using errcode = 'invalid_parameter_value';
  end if;

  select * into v_prev from public.task_routing r where r.task_id = p_task and r.is_active for update;

  -- A PERSON'S DECISION STANDS. An automated re-run may not undo an assignment a human made; the
  -- attempt is recorded so the refusal is visible, and the caller is told the state that is
  -- actually current rather than the one it asked for.
  if v_prev.id is not null
     and v_prev.routing_state = 'assigned'
     and v_prev.decided_by_source = 'human'
     and coalesce(p_actor_source, 'system') in ('ai', 'system') then
    insert into public.task_routing_events (
      company_id, task_id, routing_id, from_state, to_state, reason_code, detail, actor_id, actor_source
    ) values (
      p_company, p_task, v_prev.id, v_prev.routing_state, v_prev.routing_state, 'automated_supersede_refused',
      jsonb_build_object('requested_state', p_desired_state, 'requested_reason', p_reason_code),
      p_actor, coalesce(p_actor_source, 'system')
    );
    return query select v_prev.id, v_prev.routing_state, v_prev.reason_code;
    return;
  end if;

  if v_state = 'assigned' then
    v_bad := public.task_assignee_ineligible_reason(p_company, v_assignee, p_required_capability, p_submitter);
    if v_bad is not null then
      v_state    := case when v_bad = 'no_assignee_proposed' then 'needs_routing' else 'no_eligible_assignee' end;
      v_reason   := v_bad;
      v_assignee := null;
    end if;
  end if;

  if v_state = 'awaiting_approval' and p_approval is null then
    v_state  := 'manual_review';
    v_reason := 'approval_required_but_no_approval_record';
  end if;

  -- ORDER MATTERS. `task_routing_one_active_idx` is a partial UNIQUE index on (task_id) WHERE
  -- is_active, so the previous row must be deactivated BEFORE the new one is inserted.
  if v_prev.id is not null then
    update public.task_routing set is_active = false, updated_at = now() where id = v_prev.id;
  end if;

  insert into public.task_routing (
    company_id, task_id, routing_state, reason_code, required_capability, proposed_assignees,
    assignee_id, queue_name, approval_request_id, attempt_count, decided_by, decided_by_source
  ) values (
    p_company, p_task, v_state, v_reason, nullif(btrim(coalesce(p_required_capability, '')), ''),
    coalesce(p_proposed, '[]'::jsonb),
    case when v_state = 'assigned' then v_assignee else null end,
    case when v_state = 'assigned' then null else nullif(btrim(coalesce(p_queue, '')), '') end,
    case when v_state = 'awaiting_approval' then p_approval else null end,
    coalesce(v_prev.attempt_count, 0) + 1,
    p_actor, coalesce(p_actor_source, 'system')
  ) returning id into v_id;

  if v_prev.id is not null then
    update public.task_routing set superseded_by = v_id, updated_at = now() where id = v_prev.id;
  end if;

  insert into public.task_routing_events (company_id, task_id, routing_id, from_state, to_state, reason_code, detail, actor_id, actor_source)
  values (p_company, p_task, v_id, v_prev.routing_state, v_state, v_reason,
          jsonb_build_object('proposed', coalesce(p_proposed, '[]'::jsonb), 'refused_reason', v_bad),
          p_actor, coalesce(p_actor_source, 'system'));

  return query select v_id, v_state, v_reason;
end;
$$;

revoke all on function public.route_task(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.route_task(uuid,uuid,text,text,text,jsonb,uuid,text,uuid,uuid,text,uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (12) 0074: write-uniqueness and read-matching used DIFFERENT keys
--
-- The unique index was on the RAW `provider_account_id` while the resolver compared the NORMALISED
-- value, and nothing normalised on write. Two companies could therefore both register the same
-- account in different letter case, and the resolver would hand every message to whichever one it
-- found — reported as `exact`, with no ambiguity and no fail-closed. Worse in practice: a mapping
-- typed with a trailing space matched nothing AND still disabled the single-tenant bridge, so one
-- invisible character silently ended all inbound intake.
--
-- Both sides now use ONE key: the value is normalised on write, and the unique index is on the
-- normalised column. The resolver also normalises the CHANNEL, which previously let `WhatsApp`
-- bypass the "any mapping is configured" guard.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Normalising can COLLIDE with 0074's unique index precisely when the defect described above is
-- present (two companies registered the same account in different letter case). Detect it first and
-- say so, naming the conflict: an operator resolving a genuine two-company dispute is a decision,
-- not something a migration may silently make by keeping whichever row it happened to update first.
-- Without this guard the migration died on a bare "duplicate key value violates unique constraint",
-- which an independent review reproduced.
do $$
declare v_conflicts text;
begin
  select string_agg(format('%s/%s claimed by %s companies', x.channel, x.norm, x.n), '; ')
    into v_conflicts
    from (
      select lower(btrim(a.channel)) as channel,
             public.normalize_channel_account(a.provider_account_id) as norm,
             count(distinct a.company_id) as n
        from public.channel_accounts a
       where a.is_active
       group by 1, 2
      having count(*) > 1
    ) x;
  if v_conflicts is not null then
    raise exception '0076 fail-closed: the same receiving account is registered more than once once normalised — %. Resolve which company owns each account (deactivate the others) and re-run.', v_conflicts;
  end if;
end $$;

update public.channel_accounts
   set provider_account_id = public.normalize_channel_account(provider_account_id)
 where provider_account_id is distinct from public.normalize_channel_account(provider_account_id);

create or replace function public.channel_accounts_normalize()
returns trigger
language plpgsql
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  new.provider_account_id := public.normalize_channel_account(new.provider_account_id);
  new.channel := lower(btrim(new.channel));
  if new.provider_account_id is null then
    raise exception 'provider_account_id is required and cannot be blank';
  end if;
  return new;
end;
$$;

drop trigger if exists channel_accounts_normalize_trg on public.channel_accounts;
create trigger channel_accounts_normalize_trg
  before insert or update on public.channel_accounts
  for each row execute function public.channel_accounts_normalize();

revoke all on function public.channel_accounts_normalize() from public, anon, authenticated;

create or replace function public.resolve_channel_company(
  p_channel text,
  p_provider_account_id text
)
returns table (company_id uuid, match text)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_norm       text;
  v_channel    text;
  v_count      int;
  v_mappings   int;
  v_companies  int;
  v_company    uuid;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'resolve_channel_company is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  v_norm := public.normalize_channel_account(p_provider_account_id);
  -- The CHANNEL is normalised once and used everywhere below. Comparing the raw value let
  -- `WhatsApp` miss the configured mappings and fall through to the single-tenant bridge.
  v_channel := public.normalize_channel_account(p_channel);
  if v_norm is null or v_channel is null then
    return query select null::uuid, 'empty'::text;
    return;
  end if;

  select count(*) into v_count
    from public.channel_accounts a
   where a.channel = v_channel and a.provider_account_id = v_norm and a.is_active;

  if v_count = 1 then
    return query
      select a.company_id, 'exact'::text
        from public.channel_accounts a
       where a.channel = v_channel and a.provider_account_id = v_norm and a.is_active;
    return;
  elsif v_count > 1 then
    return query select null::uuid, 'ambiguous'::text;
    return;
  end if;

  select count(*) into v_mappings from public.channel_accounts a where a.channel = v_channel and a.is_active;
  if v_mappings = 0 then
    select count(*) into v_companies from public.companies;
    if v_companies = 1 then
      select c.id into v_company from public.companies c;
      return query select v_company, 'single_tenant_fallback'::text;
      return;
    end if;
  end if;

  return query select null::uuid, 'unmapped'::text;
end;
$$;

revoke all on function public.resolve_channel_company(text, text) from public, anon, authenticated;
grant execute on function public.resolve_channel_company(text, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- (13) 0075: `has_capability` now DEPENDS on `actor_has_capability`, which is service-only
--
-- If the two ever end up with different owners, the SECURITY DEFINER wrapper cannot reach the
-- function it delegates to and every capability-gated RLS policy ERRORS instead of returning false.
-- The 0066/0067 migrations assert a shared owner for exactly this class; 0075 did not.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_wrapper oid;
  v_inner   oid;
begin
  select p.oid into v_wrapper from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.oid::regprocedure::text = 'has_capability(uuid,text)';
  select p.oid into v_inner from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.oid::regprocedure::text = 'actor_has_capability(uuid,uuid,text)';
  if v_wrapper is null or v_inner is null then
    raise exception '0076 fail-closed: the capability wrapper or its implementation is missing';
  end if;
  if (select proowner from pg_catalog.pg_proc where oid = v_wrapper)
     is distinct from (select proowner from pg_catalog.pg_proc where oid = v_inner) then
    raise exception '0076 fail-closed: has_capability and actor_has_capability have different owners — the wrapper could not reach the implementation and every capability RLS policy would error';
  end if;
  -- Prove the wrapper actually resolves rather than only that it exists.
  perform public.has_capability(gen_random_uuid(), 'operations.inbound.review');
end $$;

commit;
