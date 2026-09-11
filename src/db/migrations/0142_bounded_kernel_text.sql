-- 0142_bounded_kernel_text.sql
-- F-004, part two — bound the management kernel's user-writable text.
--
-- WHY THIS EXISTS AT ALL. Migration 0110 bounded the 280 externally-writable text columns that
-- existed when it was written. The management kernel was quarantined outside the numbered chain at
-- the time, so 0110 never saw it. Promoting the chain (0111–0140) therefore reintroduced exactly
-- the class 0110 closed: 41 unbounded `authenticated`-writable text columns, 25 of them on
-- `management_items`. The hard-scenario gate `f004-bounded-text` caught it the moment the promoted
-- chain was applied, which is what that gate is for.
--
-- NO TRUNCATION. CHECK constraints. An oversized write is REFUSED. Trimming a state, an action id
-- or an identity key would corrupt a legitimate record rather than protect it, and a silently
-- shortened `identity_key` would break deduplication — the same row would be observed twice.
--
-- EXISTING ROWS ARE VALIDATED as each constraint is added. On a database where these tables were
-- just created by 0111–0140 there are none; on any other, this migration fails loudly rather than
-- quietly rewriting history.
--
-- IDEMPOTENT. Re-running adds nothing and drops nothing.
--
-- ── How each limit was chosen ───────────────────────────────────────────────────────────────
--
-- Two sources, and the tighter one wins where both honestly fit:
--
--   * the categories migration 0110 already established (enum-like 64, identifiers/labels 256,
--     URLs 2048, prose 8000);
--   * the owner-approved maximums of 2026-09-11 (codes/states/machine ids 128, names 255,
--     URLs 2048, human prose 4000, long AI guidance 16000, JSON 65536 bytes).
--
-- Where 0110's classifier would have matched a column, its category is used — that is the
-- established convention and these columns would have had it had they existed. Where the owner's
-- newer table is tighter, the owner's number wins, because a "maximum" that is exceeded is not a
-- maximum. Neither source is ever weakened.
--
-- ONE DELIBERATE EXCEPTION, and it is the interesting one:
--
--   `management_items.identity_key` takes 0110's identifier category (256), NOT the owner's
--   machine-identifier 128. It is not one identifier — `identityKeyFor()` joins four with `|`:
--   `companyId|observationSource|subjectId|window`, which is about 105 characters today for a
--   36-character company id, a 36-character subject id and a 10-character day window. 128 leaves
--   roughly twenty characters of headroom on a value assembled from parts that can grow, and the
--   failure mode is not a rejected write — it is a REJECTED OBSERVATION, so a detector would go
--   silent for whichever source has the longest name. "The smallest category that honestly fits"
--   is 256 here; 128 fits today and would not honestly keep fitting.

do $$
declare
  r record;
  cname text;
  -- column → limit, stated explicitly rather than derived by pattern.
  --
  -- 0110 used a classifier because it faced 280 columns across 104 tables and a pattern was the
  -- only tractable way. There are 41 here on 7 tables, all of them the kernel's own, so each one
  -- is written down and can be read and argued with. A pattern that silently mis-classifies a
  -- column gives it a wrong bound with no evidence of the decision.
  limits constant text[][] := array[
    -- ── management_items ────────────────────────────────────────────────────────────────
    -- enum-like discriminators (0110 category: 64)
    ['management_items','state','64'],
    ['management_items','kind','64'],
    ['management_items','department','64'],
    ['management_items','priority','64'],
    ['management_items','outcome','64'],
    ['management_items','monitoring_state','64'],
    ['management_items','interpretation_status','64'],
    ['management_items','recommended_resource_type','64'],
    ['management_items','business_deadline_source','64'],
    -- codes, action ids and machine identifiers (owner category: 128)
    ['management_items','evidence_quality','128'],
    ['management_items','interpretation_source','128'],
    ['management_items','proposed_action','128'],
    ['management_items','proposed_action_id','128'],
    ['management_items','required_authority','128'],
    ['management_items','routing_department','128'],
    ['management_items','recommended_resource_id','128'],
    ['management_items','review_policy_id','128'],
    ['management_items','subject_id','128'],
    ['management_items','subject_table','128'],
    -- the composite dedupe key — see the note above (0110 identifier category: 256)
    ['management_items','identity_key','256'],
    -- human explanations (owner category: 4000)
    ['management_items','routing_reason','4000'],
    ['management_items','snooze_reason','4000'],
    ['management_items','outcome_reason','4000'],
    ['management_items','interpretation_note','4000'],
    ['management_items','evidence_request_reason','4000'],

    -- ── management_item_evidence ───────────────────────────────────────────────────────
    ['management_item_evidence','source_table','128'],
    ['management_item_evidence','source_id','128'],
    ['management_item_evidence','origin','128'],

    -- ── management_item_transitions ────────────────────────────────────────────────────
    ['management_item_transitions','from_state','64'],
    ['management_item_transitions','to_state','64'],
    ['management_item_transitions','actor_type','64'],
    ['management_item_transitions','reason','4000'],

    -- ── management_item_feedback ───────────────────────────────────────────────────────
    ['management_item_feedback','feedback_type','64'],
    ['management_item_feedback','actor_type','64'],
    ['management_item_feedback','reason','4000'],
    ['management_item_feedback','comment','4000'],

    -- ── observation_sources ────────────────────────────────────────────────────────────
    ['observation_sources','department','64'],
    ['observation_sources','kind','64'],
    -- Stored error text. Bounded as prose, and see the note below about secrets.
    ['observation_sources','last_failure_reason','4000'],

    -- ── enablement notes ───────────────────────────────────────────────────────────────
    ['management_kernel_enablement','note','4000'],
    ['management_execution_enablement','note','4000']
  ];
  i int;
  tbl text; col text; lim text;
begin
  for i in 1 .. array_length(limits, 1) loop
    tbl := limits[i][1];
    col := limits[i][2];
    lim := limits[i][3];

    -- A column that has gone away is not a silent pass: say so and stop.
    if to_regclass('public.' || quote_ident(tbl)) is null then
      raise exception '0142: table public.% does not exist', tbl;
    end if;
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = tbl and column_name = col
    ) then
      raise exception '0142: column %.% does not exist', tbl, col;
    end if;

    cname := left(format('%s_%s_len_chk', tbl, col), 63);

    -- NEVER weaken an existing bound. If one is already there, leave it: 0110's convention is one
    -- constraint per column under this name, and replacing it could only loosen it.
    if not exists (
      select 1 from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_namespace ns on ns.oid = cl.relnamespace
       where ns.nspname = 'public' and cl.relname = tbl and c.conname = cname
    ) then
      -- NULL-safe: an absent value is not an oversized one.
      execute format(
        'alter table public.%I add constraint %I check (%I is null or char_length(%I) <= %s)',
        tbl, cname, col, col, lim);
    end if;
  end loop;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Stored error text must not be able to carry a secret
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- `observation_sources.last_failure_reason` is the one column here that holds text a machine
-- wrote about a failure, and failure text is where credentials leak: a driver that prints a
-- connection string, a client that echoes an Authorization header. R2F-F-006 already narrowed who
-- can READ it. This narrows what can be WRITTEN.
--
-- A CHECK, not a trigger that scrubs. Scrubbing would store a redacted lie and let the caller
-- believe it recorded the reason; refusing makes whoever wrote the message fix the message.

do $$
begin
  if not exists (
    select 1 from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
     where ns.nspname = 'public' and cl.relname = 'observation_sources'
       and c.conname = 'observation_sources_failure_no_secret_chk'
  ) then
    execute $sql$
      alter table public.observation_sources
        add constraint observation_sources_failure_no_secret_chk
        check (
          last_failure_reason is null
          or (
            -- A connection string with credentials in it.
            last_failure_reason !~* '(postgres|postgresql|mysql|mongodb)://[^/[:space:]]*:[^@[:space:]]+@'
            -- A labelled credential. The optional quote before the separator matters: the first
            -- version required `label:` and a JSON body says `"authorization": "Bearer …"`, so
            -- the most likely shape in a real error message was the one it missed.
            and last_failure_reason !~* '(bearer|apikey|api[_-]?key|authorization|password|passwd|secret|token|service[_-]?role)["'']?[[:space:]]*[:=][[:space:]]*["'']?[^[:space:]"'']{8,}'
            -- And the scheme on its own, which needs no label at all.
            and last_failure_reason !~* '\mbearer[[:space:]]+[A-Za-z0-9._-]{8,}'
            -- The shapes the providers this system talks to actually use.
            and last_failure_reason !~ 'sk-[A-Za-z0-9_-]{16,}'
            and last_failure_reason !~ 'sbp_[A-Za-z0-9]{16,}'
            -- A JWT: three base64url segments. Both anon and service-role keys are JWTs.
            and last_failure_reason !~ 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.'
          )
        )
    $sql$;
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Self-verification — fail closed
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- The audit this migration exists to satisfy, run against the result. If a column was added to one
-- of these tables between the list above being written and this migration running, it is caught
-- here rather than by a gate later.

do $$
declare v_left text;
begin
  select string_agg(col.table_name || '.' || col.column_name, ', ' order by 1)
    into v_left
    from information_schema.columns col
   where col.table_schema = 'public'
     and col.data_type in ('text', 'character varying')
     and col.character_maximum_length is null
     and col.table_name in (
       select cl.relname from pg_policy p
         join pg_class cl on cl.oid = p.polrelid
         join pg_namespace ns on ns.oid = cl.relnamespace
        where ns.nspname = 'public' and p.polcmd::text in ('a','w','*')
          and has_table_privilege('authenticated', cl.oid, 'INSERT'))
     and not exists (
       select 1 from pg_constraint c
         join pg_class cl2 on cl2.oid = c.conrelid
         join pg_namespace ns2 on ns2.oid = cl2.relnamespace
        where ns2.nspname = 'public' and cl2.relname = col.table_name
          and c.conname = left(col.table_name || '_' || col.column_name || '_len_chk', 63));

  if v_left is not null then
    raise exception '0142 ABORT: unbounded authenticated-writable text remains: %', v_left;
  end if;
end $$;
