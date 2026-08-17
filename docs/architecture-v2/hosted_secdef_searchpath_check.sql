-- hosted_secdef_searchpath_check.sql
-- READ-ONLY. Inventories the search_path of every application-owned SECURITY DEFINER function and every
-- trigger function in `public` (excluding extension-owned), and flags any that does not carry EXACTLY the
-- canonical parsed path. On the hosted database the 0038–0041 functions were applied on 2026-08-07 with
-- `SET search_path = public` (or none), which permits `pg_temp` relation shadowing (see migration
-- 0066/0067). This query mutates nothing; it is safe to run against the hosted DB at any time. It is the
-- read-only precondition for the owner-approved `hosted_secdef_searchpath_hardening.sql`.
--
-- SAFE definition (strict): the function's `search_path` GUC parses to EXACTLY
--     pg_catalog, extensions, public, pg_temp
-- (elements compared after trimming whitespace and enclosing identifier quotes). This is deliberately
-- STRICTER than "pg_temp last": a pg_temp-last path can still lead with a non-canonical schema
-- (`attacker_schema, pg_catalog, public, pg_temp`) that wins relation resolution if anything can create
-- objects there, and resolution uses the FIRST occurrence of a schema, so `pg_temp, …, pg_temp` is unsafe
-- despite ending in pg_temp. Exact canonical equality subsumes the missing-path, `$user`,
-- duplicated-pg_temp and foreign-schema cases at once.

with fn as (
  select p.oid,
         p.oid::regprocedure          as signature,
         p.proowner::regrole::text    as owner,
         p.prosecdef                  as security_definer,
         (p.prorettype = 'pg_catalog.trigger'::regtype) as is_trigger,
         (select c from unnest(coalesce(p.proconfig,'{}'::text[])) c where c like 'search_path=%') as search_path
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (p.prosecdef or p.prorettype = 'pg_catalog.trigger'::regtype)
    and not exists (select 1 from pg_depend d
                     where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
),
parsed as (
  select fn.*,
         case when fn.search_path is null then null
              else (select array_agg(regexp_replace(btrim(x), '^"([^"]*)"$', '\1'))
                      from unnest(string_to_array(substr(fn.search_path, 13), ',')) x) end as elems
  from fn
)
select signature, owner, security_definer, is_trigger,
       coalesce(search_path, '(none)') as search_path,
       (elems is null
        or elems is distinct from array['pg_catalog','extensions','public','pg_temp']) as unsafe
from parsed
order by unsafe desc, signature;

-- Focused count of UNSAFE application SECURITY DEFINER / trigger functions (the remediation target set):
with fn as (
  select (select c from unnest(coalesce(p.proconfig,'{}'::text[])) c where c like 'search_path=%') as sp
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and (p.prosecdef or p.prorettype='pg_catalog.trigger'::regtype)
    and not exists (select 1 from pg_depend d where d.classid='pg_catalog.pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
),
parsed as (
  select sp,
         case when sp is null then null
              else (select array_agg(regexp_replace(btrim(x), '^"([^"]*)"$', '\1'))
                      from unnest(string_to_array(substr(sp, 13), ',')) x) end as elems
  from fn
)
select count(*) filter (where elems is null
                           or elems is distinct from array['pg_catalog','extensions','public','pg_temp']) as unsafe_count,
       count(*) as total
from parsed;
