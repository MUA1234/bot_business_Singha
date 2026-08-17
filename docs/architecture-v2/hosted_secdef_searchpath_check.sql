-- hosted_secdef_searchpath_check.sql
-- READ-ONLY. Inventories the search_path of every application-owned SECURITY DEFINER function and every
-- trigger function in `public` (excluding extension-owned), and flags any with an UNSAFE path — i.e. a
-- path that does not pin `pg_temp` LAST, or that lists `$user`, or that is absent entirely. On the hosted
-- database the 0038–0041 functions were applied on 2026-08-07 with `SET search_path = public` (or none),
-- which permits `pg_temp` relation shadowing (see migration 0066/0067). This query mutates nothing; it is
-- safe to run against the hosted DB at any time. It is the read-only precondition for the owner-approved
-- `hosted_secdef_searchpath_hardening.sql`.
--
-- SAFE definition: the function has a `search_path` GUC set, its LAST element is `pg_temp`, and it does
-- not contain `$user`. (Postgres searches pg_temp for RELATION names before pg_catalog/public unless
-- pg_temp is listed later, so pg_temp must be present AND last.)

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
)
select signature, owner, security_definer, is_trigger,
       coalesce(search_path, '(none)') as search_path,
       case
         when search_path is null then true
         when position('$user' in search_path) > 0 then true
         when btrim(split_part(search_path, ',', array_length(string_to_array(replace(search_path,'search_path=',''), ','), 1))) <> 'pg_temp' then true
         else false
       end as unsafe
from fn
order by unsafe desc, signature;

-- Focused count of UNSAFE application SECURITY DEFINER / trigger functions (the remediation target set):
select count(*) filter (where unsafe) as unsafe_count, count(*) as total
from (
  select case
           when (select c from unnest(coalesce(p.proconfig,'{}'::text[])) c where c like 'search_path=%') is null then true
           when position('$user' in coalesce((select c from unnest(coalesce(p.proconfig,'{}'::text[])) c where c like 'search_path=%'),'')) > 0 then true
           when btrim(split_part((select c from unnest(coalesce(p.proconfig,'{}'::text[])) c where c like 'search_path=%'), ',',
                     array_length(string_to_array((select c from unnest(coalesce(p.proconfig,'{}'::text[])) c where c like 'search_path=%'), ','),1))) <> 'pg_temp' then true
           else false
         end as unsafe
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and (p.prosecdef or p.prorettype='pg_catalog.trigger'::regtype)
    and not exists (select 1 from pg_depend d where d.classid='pg_catalog.pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
) s;
