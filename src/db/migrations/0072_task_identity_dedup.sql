-- 0071 — durable, server-generated task identity and deduplication (AIM-002).
--
-- WHY: the management-case idempotency key hashes the WHOLE conversation transcript, so every new
-- inbound message produces a new case, the model re-detects the same follow-up, and the same task is
-- inserted again. CLAUDE.md's invariant is "a duplicate event must never create a duplicate task".
--
-- TWO SEPARATE CONCERNS, deliberately not conflated:
--
--   1. EXACT IDENTITY (enforced). A server-computed, company-scoped fingerprint over deterministic
--      business facts — source type, source id, normalised purpose, target entity and occurrence
--      window. A unique index makes a second insert with the same identity impossible, so a replay
--      or a concurrent worker cannot create a second logical task. The model NEVER supplies this:
--      the fingerprint is computed in the database from columns, so a model-chosen "dedupe key"
--      cannot widen or narrow it.
--
--   2. SEMANTIC SIMILARITY (suggested only). Similar text about DIFFERENT customers, assets,
--      projects or dates is DIFFERENT WORK. Similarity is recorded as a suggestion for a human and
--      never merges anything automatically.
--
-- Recurring work is legitimately repeated: the occurrence window is part of the identity, so the
-- same purpose in a new window is a NEW task, not a duplicate.

begin;

-- ── Identity columns ───────────────────────────────────────────────────────────────────────────
alter table public.tasks
  add column if not exists source_type       text,      -- 'wa_message' | 'management_case' | 'manual' | …
  add column if not exists source_id         text,      -- provider/message/case id, as text
  add column if not exists task_purpose      text,      -- normalised purpose, e.g. 'order_replacement'
  add column if not exists target_entity     text,      -- normalised target, e.g. 'customer:<uuid>'
  add column if not exists occurrence_window text,      -- e.g. '2026-08-17' or '2026-W34'; null = one-off
  add column if not exists identity_hash     text;      -- server-computed; see task_identity_hash

comment on column public.tasks.identity_hash is
  'Server-computed deduplication identity. NEVER supplied by a caller or a model — a trigger recomputes it on every write.';

-- ── Deterministic identity function ────────────────────────────────────────────────────────────
-- Normalisation is part of the identity: case, surrounding whitespace and internal runs of
-- whitespace must not create a "different" task.
create or replace function public.normalize_identity_part(p_raw text)
returns text
language sql
immutable
set search_path = pg_catalog, extensions, public, pg_temp
as $$
  select nullif(regexp_replace(lower(btrim(coalesce(p_raw, ''))), '\s+', ' ', 'g'), '');
$$;

create or replace function public.task_identity_hash(
  p_company uuid,
  p_source_type text,
  p_source_id text,
  p_purpose text,
  p_target text,
  p_window text
)
returns text
language sql
immutable
set search_path = pg_catalog, extensions, public, pg_temp
as $$
  -- NULL when there is not enough deterministic business identity to claim two rows are the same
  -- work. A null identity is NOT deduplicated — refusing to guess is safer than merging distinct work.
  select case
    when p_company is null then null
    when public.normalize_identity_part(p_source_type) is null then null
    when public.normalize_identity_part(p_purpose) is null then null
    else encode(
      extensions.digest(
        p_company::text || '|' ||
        public.normalize_identity_part(p_source_type) || '|' ||
        coalesce(public.normalize_identity_part(p_source_id), '') || '|' ||
        public.normalize_identity_part(p_purpose) || '|' ||
        coalesce(public.normalize_identity_part(p_target), '') || '|' ||
        coalesce(public.normalize_identity_part(p_window), ''),
        'sha256'
      ),
      'hex')
  end;
$$;

-- ── Server-side enforcement: the caller cannot set or forge identity_hash ──────────────────────
-- SECURITY DEFINER on purpose, and this is the narrowest correct place for it.
--
-- The hash uses `extensions.digest`, and `authenticated` has no USAGE on the `extensions` schema.
-- A plain trigger runs as the INVOKING user, so ordinary capability-gated task creation failed with
-- "permission denied for schema extensions" (caught by capability-rls.test.ts before this shipped).
--
-- Making the TRIGGER the definer boundary — rather than granting `authenticated` schema-wide access
-- to extensions, or opening the helpers — keeps the privilege to exactly one function that reads no
-- table, writes no table, and only computes a value on the row already being written. It is also
-- where the security property lives: the hash is recomputed here, so a caller can never forge it.
create or replace function public.tasks_set_identity_hash()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  -- Recomputed on EVERY insert and update. Whatever the caller supplied is discarded.
  new.identity_hash := public.task_identity_hash(
    new.company_id, new.source_type, new.source_id, new.task_purpose, new.target_entity, new.occurrence_window
  );
  return new;
end;
$$;

drop trigger if exists tasks_identity_hash_trg on public.tasks;
create trigger tasks_identity_hash_trg
  before insert or update on public.tasks
  for each row execute function public.tasks_set_identity_hash();

-- Backfill existing rows through the same function (no identity for legacy rows → NULL → not deduped).
update public.tasks set identity_hash = public.task_identity_hash(
  company_id, source_type, source_id, task_purpose, target_entity, occurrence_window
) where identity_hash is null;

-- ── The uniqueness that makes duplication impossible ──────────────────────────────────────────
-- Partial: only rows that HAVE an identity participate. Company-scoped by construction (company_id
-- is inside the hash AND in the index), so the same provider id in two companies is two tasks.
-- Cancelled work is excluded so a cancelled task does not block re-raising the same work.
create unique index if not exists tasks_identity_unique_idx
  on public.tasks (company_id, identity_hash)
  where identity_hash is not null and status <> 'cancelled';

-- ── Similarity SUGGESTIONS — never an automatic merge ─────────────────────────────────────────
create table if not exists public.task_duplicate_suggestions (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  task_id        uuid not null references public.tasks(id) on delete cascade,
  similar_task_id uuid not null references public.tasks(id) on delete cascade,
  similarity     numeric(4,3) not null check (similarity >= 0 and similarity <= 1),
  reason         text,
  -- A human decides. Until then this is a suggestion and nothing has been merged.
  resolution     text not null default 'open' check (resolution in ('open','duplicate','distinct')),
  resolved_by    uuid,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now(),
  check (task_id <> similar_task_id)
);

create unique index if not exists task_duplicate_suggestions_pair_idx
  on public.task_duplicate_suggestions (company_id, least(task_id, similar_task_id), greatest(task_id, similar_task_id));

alter table public.task_duplicate_suggestions enable row level security;
drop policy if exists task_duplicate_suggestions_read on public.task_duplicate_suggestions;
create policy task_duplicate_suggestions_read on public.task_duplicate_suggestions
  for select using (public.has_company_access(company_id));

revoke insert, update, delete, truncate on public.task_duplicate_suggestions from anon, authenticated;
grant select on public.task_duplicate_suggestions to authenticated;
grant all on public.task_duplicate_suggestions to service_role;

-- ── Atomic create-or-return ───────────────────────────────────────────────────────────────────
-- Concurrent workers: the unique index serialises them. The loser takes the conflict path and
-- returns the EXISTING task, so neither creates a duplicate and neither fails.
create or replace function public.create_task_deduplicated(
  p_company uuid,
  p_title text,
  p_source_type text,
  p_source_id text,
  p_purpose text,
  p_target text,
  p_window text,
  p_management_case uuid default null,
  p_requires_evidence boolean default false,
  p_created_by uuid default null
)
returns table (task_id uuid, created boolean)
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_hash text;
  v_id   uuid;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'create_task_deduplicated is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if p_company is null then raise exception 'p_company is required'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'p_title is required'; end if;
  -- Bound every identity part: an oversized or adversarial identifier must not become a key.
  if length(coalesce(p_source_id, '')) > 512 or length(coalesce(p_purpose, '')) > 256
     or length(coalesce(p_target, '')) > 256 or length(coalesce(p_window, '')) > 64 then
    raise exception 'identity component exceeds its maximum length';
  end if;

  v_hash := public.task_identity_hash(p_company, p_source_type, p_source_id, p_purpose, p_target, p_window);

  -- With an identity, look first: a replay returns the original rather than racing the index.
  if v_hash is not null then
    select t.id into v_id from public.tasks t
     where t.company_id = p_company and t.identity_hash = v_hash and t.status <> 'cancelled'
     limit 1;
    if v_id is not null then
      return query select v_id, false;
      return;
    end if;
  end if;

  begin
    insert into public.tasks (company_id, title, status, priority, requires_evidence,
                              source_type, source_id, task_purpose, target_entity, occurrence_window,
                              management_case_id, created_by)
    values (p_company, p_title, 'captured', 3, coalesce(p_requires_evidence, false),
            p_source_type, p_source_id, p_purpose, p_target, p_window,
            p_management_case, p_created_by)
    returning id into v_id;
    return query select v_id, true;
  exception when unique_violation then
    -- A concurrent worker won. Return THEIR task: no duplicate, no error, no silent loss.
    select t.id into v_id from public.tasks t
     where t.company_id = p_company and t.identity_hash = v_hash and t.status <> 'cancelled'
     limit 1;
    if v_id is null then
      raise exception 'unique violation on task identity but no surviving row found';
    end if;
    return query select v_id, false;
  end;
end;
$$;

-- The RPC is a service boundary and stays locked.
revoke all on function public.create_task_deduplicated(uuid,text,text,text,text,text,text,uuid,boolean,uuid) from public, anon, authenticated;
grant execute on function public.create_task_deduplicated(uuid,text,text,text,text,text,text,uuid,boolean,uuid) to service_role;

-- The helpers stay service-only: the trigger above is SECURITY DEFINER, so it reaches them in the
-- definer's context and no untrusted role needs them.
revoke all on function public.task_identity_hash(uuid,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.normalize_identity_part(text) from public, anon, authenticated;
grant execute on function public.task_identity_hash(uuid,text,text,text,text,text) to service_role;
grant execute on function public.normalize_identity_part(text) to service_role;

-- A trigger function is created with EXECUTE granted to PUBLIC by default. PostgreSQL checks that
-- privilege when the TRIGGER IS CREATED, not when it fires, so revoking it afterwards leaves the
-- trigger working while removing a direct call path for untrusted roles. (Verified by the
-- capability-gated insert in tests/integration/capability-rls.test.ts, which exercises the trigger
-- as `authenticated` after this revoke.)
revoke all on function public.tasks_set_identity_hash() from public, anon, authenticated;
grant execute on function public.tasks_set_identity_hash() to service_role;

do $$
declare bad text;
begin
  select string_agg(x.priv, ', ') into bad from (
    select 'task_duplicate_suggestions:' || r.rolname || ':' || pr.privilege as priv
      from (values ('anon'),('authenticated')) as r(rolname)
      cross join (values ('INSERT'),('UPDATE'),('DELETE')) as pr(privilege)
     where has_table_privilege(r.rolname, 'public.task_duplicate_suggestions', pr.privilege)
  ) x;
  if bad is not null then raise exception '0071 fail-closed: untrusted write privilege remains — %', bad; end if;

  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_task_deduplicated','task_identity_hash','normalize_identity_part')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if bad is not null then raise exception '0071 fail-closed: % reachable by anon/authenticated', bad; end if;
end $$;

commit;
