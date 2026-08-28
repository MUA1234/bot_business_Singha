-- 0109_bounded_user_text.sql
-- F-004 — bound user-controlled text at the database boundary.
--
-- WHY. A campaign scenario posted a customer record with a 2,000,000-character name
-- through the ordinary data API, as an authenticated non-admin, and it was stored in
-- full. Of the 448 text columns in `public`, none carried a length limit, and the 28
-- `length()` CHECK constraints in this cluster all belong to GoTrue's own `auth` schema.
-- Application-level validation cannot close this: a user holds a legitimate JWT and can
-- address PostgREST directly, so the bound has to live where the write lands.
--
-- SCOPE. This bounds the EXTERNALLY WRITABLE surface only — the 280 unbounded text
-- columns on the 104 tables that carry an INSERT/UPDATE policy AND an `authenticated`
-- grant. Service-only and system tables are deliberately left alone: they are not
-- reachable by a user, and constraining them would risk breaking trusted writers
-- (inbound payload capture, audit evidence) for no security gain.
--
-- LIMITS. Chosen per column PURPOSE, not one blanket number, and every one of them is
-- far above anything legitimate. Measured on a fully seeded database, the longest value
-- in any of these 280 columns was 91 characters; the tightest limit here is 32.
--
-- NO TRUNCATION. These are CHECK constraints. An oversized write is REFUSED — it is
-- never silently trimmed, because trimming an identifier or an amount-bearing reference
-- would corrupt a legitimate record rather than protect it. Existing rows are validated
-- as the constraint is added, so if any real data did exceed a limit this migration
-- fails loudly instead of quietly rewriting history.
--
-- IDEMPOTENT. Re-running adds nothing and drops nothing.

do $$
declare
  r record;
  lim int;
  cname text;
begin
  for r in
    select col.table_name::text as tbl, col.column_name::text as col
      from information_schema.columns col
     where col.table_schema = 'public'
       and col.data_type in ('text', 'character varying')
       and col.character_maximum_length is null
       and col.table_name in (
         select cl.relname
           from pg_policy p
           join pg_class cl on cl.oid = p.polrelid
           join pg_namespace ns on ns.oid = cl.relnamespace
          where ns.nspname = 'public'
            and p.polcmd::text in ('a', 'w', '*')
            and has_table_privilege('authenticated', cl.oid, 'INSERT'))
     order by col.table_name, col.column_name
  loop
    -- Classify by purpose. Order matters: the most specific pattern wins.
    lim := case
      -- Contact details have well-known real-world ceilings.
      when r.col = 'email' or r.col like '%_email'                     then 320
      when r.col = 'phone' or r.col like '%_phone' or r.col = 'msisdn' then 32
      -- Locations and links: a URL is legitimately long.
      when r.col like '%url%' or r.col like '%_path' or r.col = 'endpoint' or r.col = 'domain' then 2048
      -- Enum-like discriminators. These are compared, never read as prose.
      when r.col in ('status','kind','type','direction','channel','source','unit',
                     'department','party_type','target_type','role_key','currency',
                     'tax_code','gl_account_code','severity','priority','state',
                     'frequency','method','outcome','decision','verdict','mode')
           or r.col like '%_status' or r.col like '%_type' or r.col like '%_kind'
           or r.col like '%_state'                                     then 64
      -- Identifiers, references and hashes.
      when r.col in ('code','sku','reference','correlation_id','content_hash',
                     'schema_ref','target_id','external_id','idempotency_key',
                     'licence_number','p256dh','auth')
           or r.col like '%_code' or r.col like '%_number' or r.col like '%_ref'
           or r.col like '%_hash' or r.col like '%_key'                 then 256
      -- Human-facing short labels.
      when r.col in ('name','title','label','counterparty','location','username',
                     'full_name','job_title','subject','display_label','legal_name')
           or r.col like '%_name' or r.col like '%_title' or r.col like '%_label' then 256
      -- Free prose. Generous, because these are genuinely written by people.
      when r.col in ('description','note','notes','reason','evidence','mitigation',
                     'purpose','body','message','comment','summary','context','text',
                     'instructions','justification','details','response')
           or r.col like '%_reason' or r.col like '%_note%' or r.col like '%_description'
           or r.col like '%_message' or r.col like '%_body'             then 8000
      -- Anything unclassified: still bounded, still far above any real value.
      else 1000
    end;

    cname := left(format('%s_%s_len_chk', r.tbl, r.col), 63);

    if not exists (
      select 1 from pg_constraint c
       join pg_class cl on cl.oid = c.conrelid
       join pg_namespace ns on ns.oid = cl.relnamespace
      where ns.nspname = 'public' and cl.relname = r.tbl and c.conname = cname
    ) then
      -- NULL-safe: an absent value is not an oversized one.
      execute format(
        'alter table public.%I add constraint %I check (%I is null or char_length(%I) <= %s)',
        r.tbl, cname, r.col, r.col, lim);
    end if;
  end loop;
end $$;

-- Fail closed: every externally-writable text column must now be bounded. If a future
-- migration adds one and does not bound it, THIS assertion fires on the next run rather
-- than leaving a silent hole.
do $$
declare unbounded text;
begin
  select string_agg(col.table_name || '.' || col.column_name, ', ')
    into unbounded
    from information_schema.columns col
   where col.table_schema = 'public'
     and col.data_type in ('text', 'character varying')
     and col.character_maximum_length is null
     and col.table_name in (
       select cl.relname from pg_policy p
         join pg_class cl on cl.oid = p.polrelid
         join pg_namespace ns on ns.oid = cl.relnamespace
        where ns.nspname = 'public' and p.polcmd::text in ('a', 'w', '*')
          and has_table_privilege('authenticated', cl.oid, 'INSERT'))
     and not exists (
       select 1 from pg_constraint c
         join pg_class cl2 on cl2.oid = c.conrelid
         join pg_namespace ns2 on ns2.oid = cl2.relnamespace
        where ns2.nspname = 'public' and cl2.relname = col.table_name
          and c.conname = left(format('%s_%s_len_chk', col.table_name, col.column_name), 63));

  if unbounded is not null then
    raise exception 'F-004: externally-writable text columns left unbounded: %', unbounded;
  end if;
end $$;
