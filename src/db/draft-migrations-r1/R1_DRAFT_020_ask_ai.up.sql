-- ⛔ R1/R2D DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
-- Owner decision R1-D-1: no production migration number until PR-F-001 and PR-F-004 close.
--
-- R2D_DRAFT_020 — minimal persistence for staff Ask-AI operational guidance.
--
-- Authorised by owner decision R2D-D-001 (persistence), R2D-D-002 (provisional 30-day local
-- retention) and R2D-D-003 (a dedicated default-deny review capability).
--
-- WHAT THIS IS FOR. Staff ask the management AI about their own authorised work; the answer is
-- evidence-grounded and accountable, so the thread, the validated answer, its citations and its
-- suggested catalogue actions are kept. It is an operational work record, not a private chat.
--
-- WHAT IT DELIBERATELY CANNOT HOLD. There is no column for a system prompt, hidden reasoning, a
-- provider secret, or a copy of a source record — citations are REFERENCES, so the reader must
-- still pass the ordinary access check on the cited record. A schema that cannot express those
-- things cannot leak them later, which is stronger than a rule saying it must not.
--
-- SENSITIVE QUESTIONS NEVER ARRIVE HERE. Classification happens BEFORE persistence; grievance,
-- harassment, health, disability, whistleblowing, protected HR, disciplinary and privileged legal
-- content are redirected to a human channel and leave only a coded safety event with no content.

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Retention. Provisional and LOCAL — owner decision R2D-D-002, not the production policy.
--
-- Server-side only, clamped 1..90 days, and never unbounded: an expiry that can be null is an
-- indefinite retention wearing a nullable column. The final production duration is an owner,
-- legal and privacy gate recorded in the R2D report.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function r1_draft_ask_ai_retention_days() returns integer
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select greatest(1, least(90,
    coalesce(nullif(current_setting('app.ask_ai_retention_days', true), '')::int, 30)));
$$;

create or replace function r1_draft_ask_ai_expiry() returns timestamptz
language sql stable set search_path = pg_catalog, public, pg_temp as $$
  select now() + make_interval(days => r1_draft_ask_ai_retention_days());
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Threads.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table if not exists ask_ai_threads (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  membership_id  uuid not null,

  -- The language this thread is being conducted in. Constrained to what R2D supports, so an
  -- unrecognised code cannot be stored and later replayed as though it were supported.
  language       text not null default 'en' check (language in ('en', 'si', 'ta')),

  title          text check (title is null or char_length(title) <= 200),
  correlation_id uuid,

  created_at     timestamptz not null default now(),
  last_turn_at   timestamptz not null default now(),
  expires_at     timestamptz not null default r1_draft_ask_ai_expiry(),

  retention_status text not null default 'active'
                     check (retention_status in ('active', 'expired', 'purged')),

  -- A CEILING, not a floor. The guarantee is "never indefinite and never beyond 90 days",
  -- which NOT NULL and this upper bound give. Requiring expires_at > created_at as well
  -- would forbid expiring a thread EARLY — exactly what a purge, a revocation or an
  -- operator shortening retention has to do.
  constraint ask_ai_threads_expiry_bounded
    check (expires_at <= created_at + interval '90 days')
);

create index if not exists ask_ai_threads_lookup_idx
  on ask_ai_threads (company_id, membership_id, last_turn_at desc);
create index if not exists ask_ai_threads_expiry_idx
  on ask_ai_threads (expires_at) where retention_status = 'active';

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Turns. One row per user question or validated assistant answer.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table if not exists ask_ai_turns (
  id             uuid primary key default gen_random_uuid(),
  thread_id      uuid not null references ask_ai_threads(id) on delete cascade,
  company_id     uuid not null,

  role           text not null check (role in ('user', 'assistant')),

  -- Bounded on both sides: an oversized question is a denial-of-service and an oversized answer
  -- is usually a malformed one.
  content        text not null check (char_length(content) between 1 and 8000),
  language       text not null check (language in ('en', 'si', 'ta')),

  -- Assistant-only, and honest about what is NOT known.
  confidence     numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  uncertainties      text[] not null default '{}',
  missing_information text[] not null default '{}',

  -- Codes, never prose, and never the sensitive content itself.
  refusal_code   text check (refusal_code is null or char_length(refusal_code) <= 64),
  escalation_code text check (escalation_code is null or char_length(escalation_code) <= 64),
  stale_evidence boolean not null default false,

  correlation_id uuid,
  created_at     timestamptz not null default now(),

  -- A user turn carries no confidence and no model metadata; an assistant turn is the only one
  -- that may. Keeping that unrepresentable stops a question from ever being displayed as though
  -- the system had asserted it.
  constraint ask_ai_turns_user_has_no_model_fields check (
    role = 'assistant' or (confidence is null and refusal_code is null
                           and escalation_code is null and stale_evidence = false)
  )
);

create index if not exists ask_ai_turns_thread_idx on ask_ai_turns (thread_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Citations — REFERENCES ONLY.
--
-- No copy of the cited row is stored. A reader must still pass the ordinary access check on the
-- referenced record, so a saved answer can never become a route around access that was later
-- revoked.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table if not exists ask_ai_citations (
  id           uuid primary key default gen_random_uuid(),
  turn_id      uuid not null references ask_ai_turns(id) on delete cascade,
  company_id   uuid not null,

  source_table text not null check (char_length(source_table) between 1 and 64),
  source_id    text not null check (char_length(source_id) between 1 and 64),

  -- What the citation is FOR — a short label, not the record's content.
  claim_label  text check (claim_label is null or char_length(claim_label) <= 200),

  created_at   timestamptz not null default now(),
  unique (turn_id, source_table, source_id)
);

create index if not exists ask_ai_citations_turn_idx on ask_ai_citations (turn_id);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Suggested actions — proposals from the catalogue, never executions.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table if not exists ask_ai_suggested_actions (
  id          uuid primary key default gen_random_uuid(),
  turn_id     uuid not null references ask_ai_turns(id) on delete cascade,
  company_id  uuid not null,

  -- An id from ACTION_CATALOGUE. The application refuses an unknown one; the column refuses an
  -- empty or oversized one.
  action_id   text not null check (char_length(action_id) between 1 and 100),

  -- There is no 'executed' state, and no column that could hold one. Ask-AI proposes; execution
  -- belongs to the approval path, which is a different phase and a different boundary.
  status      text not null default 'suggested' check (status = 'suggested'),

  requires_approval boolean not null default true,
  rationale   text check (rationale is null or char_length(rationale) <= 500),
  created_at  timestamptz not null default now(),
  unique (turn_id, action_id)
);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Sensitive-topic safety events — CODED, contentless.
--
-- The point of this table is what it omits. A grievance or health disclosure must not be sitting
-- in an operational history a manager may review, so the question itself is never written down;
-- only the fact that a redirection happened, so the behaviour remains auditable.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table if not exists ask_ai_safety_events (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  membership_id uuid not null,

  category      text not null check (category in (
                  'grievance', 'harassment', 'health', 'disability', 'whistleblowing',
                  'protected_hr', 'disciplinary', 'legal_privilege')),
  redirected_to text not null check (char_length(redirected_to) <= 100),

  correlation_id uuid,
  created_at    timestamptz not null default now()
  -- Deliberately NO content column, and none may be added: see the guard trigger below.
);

create index if not exists ask_ai_safety_events_idx
  on ask_ai_safety_events (company_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Company FKs, where the parent tables exist.
-- ─────────────────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  if to_regclass('public.companies') is null then
    raise notice 'R2D_DRAFT_020: companies absent — company FKs SKIPPED';
    return;
  end if;
  foreach t in array array['ask_ai_threads','ask_ai_turns','ask_ai_citations',
                           'ask_ai_suggested_actions','ask_ai_safety_events'] loop
    if not exists (select 1 from pg_constraint
                    where conrelid = ('public.'||t)::regclass and conname = t||'_company_fk') then
      execute format('alter table public.%I add constraint %I foreign key (company_id)
                      references public.companies(id) on delete cascade', t, t||'_company_fk');
    end if;
  end loop;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- RLS. Company scope, own-thread visibility, and a DEFAULT-DENY review capability.
--
-- Owner decision R2D-D-003: reviewing another member's guidance requires a specific capability.
-- Manager status is not sufficient and is not consulted — `has_capability` is the existing
-- delegation-aware engine, so this adds no second authority system and broadens nothing else.
-- ─────────────────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  if to_regprocedure('public.has_company_access(uuid)') is null
     or to_regprocedure('public.has_capability(uuid, text)') is null then
    raise notice 'R2D_DRAFT_020: access helpers absent — RLS SKIPPED (standalone draft database)';
    return;
  end if;

  foreach t in array array['ask_ai_threads','ask_ai_turns','ask_ai_citations',
                           'ask_ai_suggested_actions','ask_ai_safety_events'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;

  -- A member sees their OWN threads. A reviewer with the capability sees others' in the same
  -- company. Everyone else sees nothing, and expired content is invisible to both.
  begin
    execute $p$create policy ask_ai_threads_read on ask_ai_threads for select using (
      has_company_access(company_id)
      and retention_status = 'active'
      and expires_at > now()
      and (
        membership_id in (select m.id from memberships m where m.user_id = auth.uid())
        or has_capability(company_id, 'management.ask_ai.review')
      )
    )$p$;
  exception when duplicate_object then null; end;

  -- Turns reach the thread directly.
  begin
    execute $p$create policy ask_ai_turns_read on ask_ai_turns for select using (
      exists (select 1 from ask_ai_threads th
               where th.id = ask_ai_turns.thread_id and has_company_access(th.company_id)
                 and th.retention_status = 'active' and th.expires_at > now()
                 and (th.membership_id in (select m.id from memberships m where m.user_id = auth.uid())
                      or has_capability(th.company_id, 'management.ask_ai.review')))
    )$p$;
  exception when duplicate_object then null; end;

  -- Citations and suggested actions hang off a TURN, so they reach the thread through it.
  foreach t in array array['ask_ai_citations','ask_ai_suggested_actions'] loop
    begin
      execute format($p$create policy %I on %I for select using (
        exists (select 1 from ask_ai_turns tu
                  join ask_ai_threads th on th.id = tu.thread_id
                 where tu.id = %I.turn_id and has_company_access(th.company_id)
                   and th.retention_status = 'active' and th.expires_at > now()
                   and (th.membership_id in (select m.id from memberships m where m.user_id = auth.uid())
                        or has_capability(th.company_id, 'management.ask_ai.review')))
      )$p$, t||'_read', t, t);
    exception when duplicate_object then null; end;
  end loop;

  -- Safety events are NOT part of ordinary manager review. A redirected grievance must not
  -- become visible merely because someone may review operational guidance.
  begin
    execute $p$create policy ask_ai_safety_own_read on ask_ai_safety_events for select using (
      has_company_access(company_id)
      and membership_id in (select m.id from memberships m where m.user_id = auth.uid())
    )$p$;
  exception when duplicate_object then null; end;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Writes are server-side only. There is no INSERT/UPDATE policy at all: an API caller cannot
-- write its own Ask-AI history, which is what stops a client from fabricating an answer, a
-- citation or a suggested action and replaying it as though the system had produced it.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function r1_draft_guard_ask_ai_write() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'Ask-AI history is written by the server, not by an API caller'
      using errcode = 'insufficient_privilege';
  end if;
  -- NEW does not exist for a DELETE, so returning it returns NULL — and NULL from a BEFORE
  -- row trigger SKIPS the operation. An earlier version did exactly that and silently
  -- cancelled every delete on these tables, including the retention purge: no error, no
  -- warning, rows simply stayed. The correct row must be returned for each operation.
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['ask_ai_threads','ask_ai_turns','ask_ai_citations',
                           'ask_ai_suggested_actions','ask_ai_safety_events'] loop
    execute format('drop trigger if exists %I on %I', t||'_guard_write', t);
    execute format('create trigger %I before insert or update or delete on %I
                    for each row execute function r1_draft_guard_ask_ai_write()',
                   t||'_guard_write', t);
  end loop;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Deterministic local expiry. Marks, then clears content — no indefinite retention path.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function r1_draft_ask_ai_purge_expired() returns integer
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_turns integer;
begin
  -- 1. Anything past its expiry is marked, whatever state it was in. Restricting this to
  --    'active' left a thread already marked by an earlier pass holding its content for
  --    ever, because the content deletion below keys off the mark.
  update ask_ai_threads set retention_status = 'expired'
   where retention_status <> 'purged' and expires_at <= now();

  -- 2. The CONTENT goes immediately. Written as a subquery rather than DELETE ... USING so
  --    there is no aliasing subtlety between the target and the joined relation — this is
  --    the step that must not silently affect zero rows.
  delete from public.ask_ai_turns
   where thread_id in (select id from public.ask_ai_threads
                        where retention_status = 'expired');
  get diagnostics v_turns = row_count;

  -- 3. The shell lingers a day for audit continuity, then goes too. Citations and suggested
  --    actions cascade from the turns; nothing is left pointing at content that is gone.
  delete from public.ask_ai_threads
   where retention_status = 'expired' and expires_at <= now() - interval '1 day';

  -- The number of TURNS removed: the thing a caller needs to verify, and the thing a row
  -- count of marked threads was silently not telling anyone.
  return v_turns;
end;
$$;

revoke all on function r1_draft_ask_ai_purge_expired() from public;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- The review capability, registered the way every other capability is.
--
-- Owner decision R2D-D-003. It is a row in the EXISTING `permissions` catalogue, resolved by the
-- existing `has_capability` engine through `role_permissions` — not a second authority system,
-- and not a role-name check.
--
-- DEFAULT DENY: the permission exists, and no role is granted it here. A company grants it to a
-- specific role deliberately, which is what makes "authorised manager" mean something narrower
-- than "manager". It confers nothing beyond reading operational guidance — no financial, HR,
-- legal, messaging or execution authority — and it never exposes a redirected sensitive question.
-- ─────────────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.permissions') is null then
    raise notice 'R2D_DRAFT_020: permissions catalogue absent — capability registration SKIPPED';
    return;
  end if;
  insert into permissions (key, label)
  values ('management.ask_ai.review', 'Management: review staff Ask-AI operational guidance')
  on conflict (key) do nothing;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- READ grants for the authenticated role.
--
-- Without these an authenticated caller is refused by table privilege before RLS is ever
-- consulted — which looks like isolation working, and is not: it would equally refuse the
-- person's OWN guidance. SELECT only. There is deliberately no INSERT, UPDATE or DELETE grant,
-- because Ask-AI history is written by the server and never by an API caller.
-- ─────────────────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise notice 'R2D_DRAFT_020: role authenticated absent — grants SKIPPED';
    return;
  end if;
  foreach t in array array['ask_ai_threads','ask_ai_turns','ask_ai_citations',
                           'ask_ai_suggested_actions','ask_ai_safety_events'] loop
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end
$$;
