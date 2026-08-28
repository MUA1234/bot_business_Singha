-- ROLLBACK REHEARSAL for 0109_bounded_user_text.sql.
--
-- The runner has no down-migrations, so reversing 0109 means dropping the constraints it
-- added and removing its ledger row. It touches NO data: 0109 only ever added CHECK
-- constraints, so undoing it cannot lose a value. Rehearsed on a disposable database.
do $$
declare r record;
begin
  for r in
    select cl.relname::text as tbl, c.conname::text as name
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
     where n.nspname = 'public' and c.contype = 'c' and c.conname like '%\_len\_chk'
  loop
    execute format('alter table public.%I drop constraint %I', r.tbl, r.name);
  end loop;
end $$;
delete from schema_migrations where version = '0109';
