-- SEED_ADMIN.sql
-- Run this AFTER ALL_MIGRATIONS.sql, in the Supabase SQL editor.
-- It grants admin rights to the already-created auth user singha-admin@singha.local.
-- (The auth user exists; this only creates/updates its public.profiles row.)

insert into public.profiles (id, company_id, username, full_name, department, is_admin, is_active)
select u.id,
       '00000000-0000-0000-0000-00000000515a',
       'singha-admin',
       'Singha Admin',
       'admin',
       true,
       true
from auth.users u
where lower(u.email) = 'singha-admin@singha.local'
on conflict (id) do update
  set department = 'admin',
      is_admin   = true,
      is_active  = true,
      username   = excluded.username;

-- Verify:
select id, username, department, is_admin, is_active from public.profiles;
