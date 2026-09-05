-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_025 — fair scheduling state for outcome verification (R2F-F-009).
--
-- ── Why this is not the existing cursor table ────────────────────────────────────────────
--
-- `management_source_cursors` records a position and a generation per SOURCE. Fair verification
-- needs three facts per ITEM: how many attempts it has had, when it may next be tried, and what
-- happened each time. That table has nowhere to put any of them, and overloading a mechanism whose
-- meaning is already load-bearing for pagination would make both harder to reason about.
--
-- Everything else is reused unchanged: the per-company cycle lock, the lifecycle boundary
-- `r1_draft_transition_item()`, and `management_item_transitions` as the append-only history.
--
-- ── What fairness means here ─────────────────────────────────────────────────────────────
--
-- An item that cannot be verified — a source that keeps failing, a record that cannot be
-- interpreted — must not sit at the front of the queue consuming every cycle's budget while items
-- behind it are never attempted. So attempts carry a NEXT-ATTEMPT time with bounded exponential
-- backoff, and selection is ordered by that time. A failing item steps back; it does not block.
--
-- Nor is it forgotten: `attempts` and `last_outcome` stay visible, and there is no cap that
-- silently drops the remainder — the cycle reports how many remain.

create table if not exists management_verification_schedule (
  company_id      uuid not null,
  item_id         uuid not null references management_items(id) on delete cascade,

  -- How many times verification has been attempted. Never reset by an attempt that concluded
  -- nothing: an item that keeps coming back `unavailable` must keep stepping back.
  attempts        integer not null default 0,

  -- The earliest moment this item may be attempted again. Selection orders by this, so an item
  -- in backoff cannot hold the front of the queue.
  next_attempt_at timestamptz not null default now(),

  -- The last conclusion, kept so retry state is VISIBLE rather than inferred from silence.
  last_outcome    text,
  last_detail     text,
  last_attempt_at timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  primary key (company_id, item_id),

  constraint verification_schedule_attempts_ck check (attempts >= 0),
  -- A row that claims an outcome must say when it was reached.
  constraint verification_schedule_shape_ck check (
    (last_outcome is null and last_attempt_at is null)
    or (last_outcome is not null and last_attempt_at is not null)
  )
);

create index if not exists management_verification_schedule_due
  on management_verification_schedule (company_id, next_attempt_at);

drop trigger if exists management_verification_schedule_touch on management_verification_schedule;
create trigger management_verification_schedule_touch
  before update on management_verification_schedule
  for each row execute function r1_draft_touch_updated_at();

-- ── Append-only attempt evidence ─────────────────────────────────────────────────────────
--
-- The schedule row is the CURRENT state and is updated in place. This is the history, and it is
-- never rewritten: "we tried four times and got `unavailable` each time" is exactly the fact a
-- person needs when asking why an item has not closed, and a table that can be edited cannot
-- answer it.
create table if not exists management_verification_attempts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  item_id       uuid not null references management_items(id) on delete cascade,
  attempt_no    integer not null,
  outcome       text not null,
  -- Non-sensitive. No record contents, no task title, no customer name.
  detail        text,
  -- Which observation this conclusion was drawn from, so a result can be traced to a sweep.
  observed_at   timestamptz not null,
  generation    text,
  -- 'system' for a scheduled cycle attempt; a user id when a person asked for it.
  actor_id      uuid,
  actor_type    text not null default 'system' check (actor_type in ('user', 'system')),
  created_at    timestamptz not null default now()
);

create index if not exists management_verification_attempts_item
  on management_verification_attempts (company_id, item_id, created_at desc);

create or replace function r1_draft_verification_attempts_append_only()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
begin
  -- DELETE is refused by RAISING, never by returning NULL. A BEFORE trigger returning NULL skips
  -- the operation silently, which is the defect R2D-F-006 was: every delete discarded with no
  -- error, no warning and no changed row count.
  raise exception 'management_verification_attempts is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$fn$;

drop trigger if exists management_verification_attempts_guard on management_verification_attempts;
create trigger management_verification_attempts_guard
  before update or delete on management_verification_attempts
  for each row execute function r1_draft_verification_attempts_append_only();

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.has_capability(uuid, text)') is null then
    raise notice 'R1_DRAFT_025: base identity functions absent — policies SKIPPED';
    return;
  end if;

  execute 'revoke all on table public.management_verification_schedule from public, anon';
  execute 'revoke all on table public.management_verification_attempts from public, anon';
  execute 'alter table public.management_verification_schedule enable row level security';
  execute 'alter table public.management_verification_attempts enable row level security';

  -- Read follows the ITEM. Someone who may not see the item may not see how often the system
  -- tried to verify it either — the attempt history would otherwise disclose that the item exists.
  begin
    execute 'create policy management_verification_schedule_sel
               on public.management_verification_schedule
               for select to authenticated using (public.r1_draft_may_see_item(item_id))';
  exception when duplicate_object then null; end;
  begin
    execute 'create policy management_verification_attempts_sel
               on public.management_verification_attempts
               for select to authenticated using (public.r1_draft_may_see_item(item_id))';
  exception when duplicate_object then null; end;

  -- No write policy on either. Scheduling is the cycle's business, and a session that could write
  -- here could park an item in permanent backoff or fabricate an attempt history.
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.management_verification_schedule to authenticated';
    execute 'grant select on public.management_verification_attempts to authenticated';
  end if;
end $$;
