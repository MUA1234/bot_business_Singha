-- 0146_skill_events_tenant_integrity.sql
-- The one tenant-integrity gap 0143's own pattern could not see.
--
-- ── How it was missed ───────────────────────────────────────────────────────────────────────
--
-- 0143 closed the promoted chain's single-column tenant foreign keys and then asserted, fail-
-- closed, that none remained. Its scope predicate was:
--
--     child ~ '^(management_|observation_|ask_ai_)'
--
-- `skill_records` and `skill_record_events` are part of the same promoted chain and match none of
-- those prefixes. So the gap was outside the question 0143 asked, and 0143's assertion passed
-- truthfully — about a population that did not include this table.
--
-- That is the second time in this integration that a gate was correct and its POPULATION was
-- wrong (the first: four global tables with no `company_id`, migration 0145). A self-verifying
-- migration proves what it looked at, never what it did not.
--
-- ── The gap ─────────────────────────────────────────────────────────────────────────────────
--
--     skill_record_events.skill_record_id → skill_records(id)      ON DELETE CASCADE
--
-- Both rows carry `company_id`, and nothing made them agree. A writer able to insert an event
-- could attach company B's skill-record id to a company A event row: both rows exist, the FK is
-- satisfied, and the tenant boundary was never consulted. A skill record is what the kernel routes
-- work by — "who is verified to do this" — so a forged event history is a forged competency claim.
--
-- Exploitability today is low and that is not the reason to leave it. Both tables are
-- `service_only` in `security/rls-classification.json`: RLS is on, there is no write policy, and
-- 0144 withdrew the write grants, so no client can insert an event at all. The gap is reachable
-- only through the service path. Owner decision: every tenant-owned relationship enforces tenant
-- integrity at the DATABASE, not at whichever layer currently happens to stand in front of it.
--
-- ── The fix ─────────────────────────────────────────────────────────────────────────────────
--
--     foreign key (company_id, skill_record_id) references skill_records (company_id, id)
--
-- The child's OWN company_id joins the lookup, so a cross-company reference finds no parent row
-- and PostgreSQL refuses the write — whatever the caller is and whatever path it came in on.
--
-- DELETE BEHAVIOUR IS PRESERVED EXACTLY: the original cascades, so the replacement cascades.
-- Tightening referential integrity while quietly changing what a delete does would be two changes
-- wearing one name.
--
-- Idempotent. Forward-only. No data change.

-- The parent needs a UNIQUE (company_id, id) for a composite FK to reference. Trivially satisfied
-- — `id` is already the primary key, so the pair cannot collide. It costs one index.
do $$
begin
  if to_regclass('public.skill_records') is null or to_regclass('public.skill_record_events') is null then
    raise notice '0146: skill tables absent — skipped';
    return;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.skill_records'::regclass and contype = 'u'
       and conkey = (select array_agg(attnum order by attnum) from pg_attribute
                      where attrelid = 'public.skill_records'::regclass and attname in ('company_id', 'id'))
  ) then
    execute 'alter table public.skill_records add constraint skill_records_company_id_uniq unique (company_id, id)';
  end if;

  -- Replace, in one statement pair, so there is no window without referential integrity.
  if exists (select 1 from pg_constraint where conname = 'skill_record_events_skill_record_id_fkey'
              and conrelid = 'public.skill_record_events'::regclass) then
    execute 'alter table public.skill_record_events drop constraint skill_record_events_skill_record_id_fkey';
  end if;

  if not exists (select 1 from pg_constraint where conname = 'skill_record_events_company_skill_fkey'
                  and conrelid = 'public.skill_record_events'::regclass) then
    execute 'alter table public.skill_record_events
               add constraint skill_record_events_company_skill_fkey
               foreign key (company_id, skill_record_id)
               references public.skill_records (company_id, id) on delete cascade';
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Self-verification — over the WHOLE promoted chain, not this one table
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Deliberately wider than the fix. Asserting only that `skill_record_events` is closed would
-- repeat 0143's mistake at a smaller scale. This asks the question of every table the promoted
-- chain created, by listing them rather than by matching a name prefix — a prefix is what let this
-- one hide.
do $$
declare
  v_gaps text;
  promoted text[] := array[
    'advisor_relationships', 'ask_ai_citations', 'ask_ai_safety_events', 'ask_ai_suggested_actions',
    'ask_ai_threads', 'ask_ai_turns', 'consultant_engagements', 'management_completion_claims',
    'management_cycle_leases', 'management_cycle_runs', 'management_execution_attempts',
    'management_execution_enablement', 'management_item_assignments', 'management_item_decisions',
    'management_item_evidence', 'management_item_feedback', 'management_item_recommendations',
    'management_item_transitions', 'management_items', 'management_kernel_enablement',
    'management_task_idempotency', 'management_verification_attempts',
    'management_verification_schedule', 'membership_languages', 'observation_source_cursors',
    'observation_sources', 'skill_record_events', 'skill_records'
  ];
begin
  create temporary table _t0146 on commit drop as
  with fks as (
    select c.conname, t.relname as child, rt.relname as parent,
           array_agg(a.attname order by k.ord) as cols
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_class rt on rt.oid = c.confrelid
      join lateral unnest(c.conkey) with ordinality k(att, ord) on true
      join pg_attribute a on a.attrelid = t.oid and a.attnum = k.att
     where c.contype = 'f' and t.relnamespace = 'public'::regnamespace
     group by 1, 2, 3),
  single as (select * from fks where array_length(cols, 1) = 1 and cols[1] <> 'company_id'),
  composite as (select child, parent, cols from fks where 'company_id' = any(cols) and array_length(cols, 1) > 1)
  select s.child, s.cols[1] as col, s.parent
    from single s
   where s.child = any(promoted)
     and exists (select 1 from information_schema.columns ic
                  where ic.table_schema = 'public' and ic.table_name = s.child and ic.column_name = 'company_id')
     and exists (select 1 from information_schema.columns ip
                  where ip.table_schema = 'public' and ip.table_name = s.parent and ip.column_name = 'company_id')
     and not exists (select 1 from composite cp
                      where cp.child = s.child and cp.parent = s.parent and s.cols[1] = any(cp.cols));

  select string_agg(child || '.' || col || ' -> ' || parent, ', ' order by child, col)
    into v_gaps from _t0146;

  if v_gaps is not null then
    raise exception '0146 ABORT: tenant-integrity gaps remain on the promoted chain: %', v_gaps;
  end if;

  raise notice '0146: zero tenant-integrity gaps across all % promoted tables', array_length(promoted, 1);
end $$;
