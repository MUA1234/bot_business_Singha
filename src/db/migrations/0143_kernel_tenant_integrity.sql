-- 0143_kernel_tenant_integrity.sql
-- F-009, for the promoted chain — make cross-company references impossible at the DATABASE.
--
-- WHY. A single-column foreign key says "this id exists". It does not say "this id belongs to the
-- same company as the row pointing at it". With `management_item_evidence.item_id -> items(id)`,
-- a writer who can insert evidence can attach company B's item id to a company A evidence row and
-- the database will accept it: both rows exist, the FK is satisfied, and the tenant boundary was
-- never consulted. RLS does not close this — RLS decides which rows a caller may see and write,
-- not whether the values inside an accepted row are consistent with each other. Nor does
-- TypeScript: a caller holding a legitimate JWT can address PostgREST directly.
--
-- The composite pattern closes it structurally:
--
--     foreign key (company_id, item_id) references management_items (company_id, id)
--
-- Now the child's OWN company_id participates in the lookup. A cross-company reference finds no
-- parent row and the write is refused by PostgreSQL, whatever the caller is and whatever path it
-- came in on.
--
-- SCOPE. The eighteen tenant-scoped foreign keys introduced by the promoted chain (0111–0140).
-- The 102 pre-existing gaps on the released chain are the recorded finding F-009 and are NOT
-- touched here: changing them is a separate piece of work on tables carrying production data, and
-- bundling it into this migration would make one reviewable change into two unreviewable ones.
-- `0142`'s self-verification asserts zero gaps among the promoted tables and that the pre-existing
-- count has not grown.
--
-- DELETE BEHAVIOUR IS PRESERVED EXACTLY. Each replacement carries the same action the original
-- had — CASCADE where it cascaded, RESTRICT where it restricted, SET NULL where it nulled. A
-- migration that tightened referential integrity while quietly changing what a delete does would
-- be two changes wearing one name.
--
-- IDEMPOTENT. Re-running adds nothing and drops nothing.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 1. The parents need a UNIQUE (company_id, id) for a composite FK to reference
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Trivially satisfied — `id` is already the primary key, so `(company_id, id)` cannot collide.
-- The constraint exists to give the foreign key something to point at, and it costs one index.

do $$
declare
  t text;
  cname text;
begin
  foreach t in array array[
    'management_items', 'management_cases', 'management_directives',
    'management_item_feedback', 'ask_ai_threads', 'ask_ai_turns', 'tasks'
  ]
  loop
    if to_regclass('public.' || quote_ident(t)) is null then
      raise exception '0143: expected table public.% to exist', t;
    end if;
    cname := left(format('%s_company_id_uq', t), 63);
    if not exists (
      select 1 from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_namespace ns on ns.oid = cl.relnamespace
       where ns.nspname = 'public' and cl.relname = t and c.conname = cname
    ) then
      execute format('alter table public.%I add constraint %I unique (company_id, id)', t, cname);
    end if;
  end loop;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 2. Replace each single-column FK with its composite equivalent
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  r record;
  specs constant text[][] := array[
    -- child, column, parent, old constraint name, on-delete action
    ['management_item_evidence','item_id','management_items','management_item_evidence_item_fk','restrict'],
    ['management_item_decisions','item_id','management_items','management_item_decisions_item_fk','restrict'],
    ['management_item_transitions','item_id','management_items','management_item_transitions_item_fk','restrict'],
    ['management_item_feedback','item_id','management_items','management_item_feedback_item_fk','restrict'],
    ['management_item_feedback','supersedes_id','management_item_feedback','management_item_feedback_supersedes_id_fkey','restrict'],
    ['management_item_recommendations','item_id','management_items','management_item_recommendations_item_id_fkey','cascade'],
    ['management_item_assignments','item_id','management_items','management_item_assignments_item_id_fkey','cascade'],
    ['management_item_assignments','task_id','tasks','management_item_assignments_task_id_fkey','cascade'],
    ['management_completion_claims','item_id','management_items','management_completion_claims_item_id_fkey','cascade'],
    ['management_completion_claims','task_id','tasks','management_completion_claims_task_id_fkey','cascade'],
    ['management_verification_schedule','item_id','management_items','management_verification_schedule_item_id_fkey','cascade'],
    ['management_verification_attempts','item_id','management_items','management_verification_attempts_item_id_fkey','cascade'],
    ['management_directive_conflicts','directive_a_id','management_directives','management_directive_conflicts_directive_a_id_fkey','cascade'],
    ['management_directive_conflicts','directive_b_id','management_directives','management_directive_conflicts_directive_b_id_fkey','cascade'],
    ['ask_ai_turns','thread_id','ask_ai_threads','ask_ai_turns_thread_id_fkey','cascade'],
    ['ask_ai_citations','turn_id','ask_ai_turns','ask_ai_citations_turn_id_fkey','cascade'],
    ['ask_ai_suggested_actions','turn_id','ask_ai_turns','ask_ai_suggested_actions_turn_id_fkey','cascade'],
    -- SET NULL, and the column list matters — see below.
    ['management_items','management_case_id','management_cases','management_items_case_fk','set null']
  ];
  i int;
  child text; col text; parent text; oldname text; action text;
  newname text; act_sql text;
begin
  for i in 1 .. array_length(specs, 1) loop
    child := specs[i][1]; col := specs[i][2]; parent := specs[i][3];
    oldname := specs[i][4]; action := specs[i][5];
    newname := left(format('%s_%s_company_fk', child, col), 63);

    if not exists (
      select 1 from information_schema.columns
       where table_schema='public' and table_name=child and column_name=col
    ) then
      raise exception '0143: column %.% does not exist', child, col;
    end if;

    -- Already done? Then this is a rerun.
    if exists (
      select 1 from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_namespace ns on ns.oid = cl.relnamespace
       where ns.nspname='public' and cl.relname=child and c.conname=newname
    ) then
      continue;
    end if;

    -- ON DELETE SET NULL on a COMPOSITE key needs the column list.
    --
    -- Without it PostgreSQL would try to null every referencing column, including `company_id`,
    -- which is NOT NULL — so the delete would fail at runtime with a constraint violation that
    -- looks like a bug in whatever issued it. `SET NULL (management_case_id)` nulls only the
    -- reference. PostgreSQL 15+; this repository is on 16.
    act_sql := case action
      when 'set null' then format('on delete set null (%I)', col)
      else 'on delete ' || action
    end;

    execute format('alter table public.%I drop constraint if exists %I', child, oldname);
    execute format(
      'alter table public.%I add constraint %I foreign key (company_id, %I) '
      'references public.%I (company_id, id) %s',
      child, newname, col, parent, act_sql);
  end loop;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 3. Self-verification — fail closed
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_gaps text;
  v_promoted int;
  v_total int;
begin
  create temporary table _t_gaps on commit drop as
  with fks as (
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
           (select array_agg(a.attname::text order by k.ord)
              from unnest(c.conkey) with ordinality k(att, ord)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att) as cols
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
     where c.contype = 'f' and n.nspname = 'public'),
  single as (select * from fks where array_length(cols,1) = 1 and cols[1] <> 'company_id'),
  composite as (select child, parent, cols from fks where 'company_id' = any(cols) and array_length(cols,1) > 1)
  select s.child, s.cols[1] as col, s.parent
    from single s
   where exists (select 1 from information_schema.columns ic
                  where ic.table_schema='public' and ic.table_name=s.child and ic.column_name='company_id')
     and exists (select 1 from information_schema.columns ip
                  where ip.table_schema='public' and ip.table_name=s.parent and ip.column_name='company_id')
     and not exists (select 1 from composite cp
                      where cp.child=s.child and cp.parent=s.parent and s.cols[1] = any(cp.cols));

  select count(*) into v_total from _t_gaps;
  select count(*) into v_promoted from _t_gaps
   where child ~ '^(management_|observation_|ask_ai_)';

  select string_agg(child || '.' || col || ' -> ' || parent, ', ' order by child, col)
    into v_gaps from _t_gaps where child ~ '^(management_|observation_|ask_ai_)';

  if v_promoted > 0 then
    raise exception '0143 ABORT: tenant-integrity gaps remain on promoted tables: %', v_gaps;
  end if;

  -- The pre-existing released-chain gaps (F-009) are expected and unchanged. If this number has
  -- GROWN, something added a gap while this migration claimed to be closing them.
  if v_total > 102 then
    raise exception '0143 ABORT: the pre-existing F-009 gap count grew to % (expected at most 102)', v_total;
  end if;

  raise notice '0143: zero tenant-integrity gaps on promoted tables; % pre-existing F-009 gaps unchanged', v_total;
end $$;
