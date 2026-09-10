-- ⛔ R1/R2C DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
-- Owner decision R1-D-1: no production migration number until PR-F-001 and PR-F-004 close.
--
-- R2C_DRAFT_016 — verified skills and staff language preference.
--
-- This closes finding F-R2B-2. Until now NO skill in this system was verified:
-- `employee_profiles.skills` is a bare text[] with no verifier, no evidence, no expiry and no
-- status, so work that MANDATES a verified skill could only ever yield needs_routing. That was
-- the correct behaviour on the evidence available; this unit supplies the evidence.
--
-- TWO AXES, DELIBERATELY SEPARATE.
--
--   provenance — HOW DO WE KNOW?      self_declared | manager_entered
--                                     externally_certified | evidence_verified
--   status     — DOES IT STILL HOLD?  active | expired | disputed | revoked
--
-- They are independent questions. An externally certified skill can expire; a self-declared one
-- can be disputed. Collapsing them into a single enum would make "expired" erase how the claim
-- was ever obtained, and the whole point of this table is that the provenance survives.
--
-- ONLY (externally_certified OR evidence_verified) AND status='active' AND not past expiry
-- counts as VERIFIED. Everything else is present-but-unverified and can never satisfy a
-- mandatory requirement.

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 1. Skill records.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table if not exists skill_records (
  id                uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  -- WHOSE skill. A membership, not a user: skills are held within a company.
  membership_id     uuid not null,

  skill_key         text not null,

  provenance        text not null check (provenance in (
                      'self_declared', 'manager_entered', 'externally_certified', 'evidence_verified')),
  status            text not null default 'active' check (status in (
                      'active', 'expired', 'disputed', 'revoked')),

  -- HOW we know. A reference to a real record, never a copied document.
  evidence_ref      text,
  evidence_table    text,
  -- WHO checked it, and WHEN. Both required for a verified provenance (trigger below).
  verified_by       uuid,
  verified_at       timestamptz,
  expires_at        date,

  note              text check (note is null or char_length(note) <= 1000),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- One live record per person per skill. History lives in skill_record_events.
  unique (company_id, membership_id, skill_key)
);

create index if not exists skill_records_lookup_idx
  on skill_records (company_id, membership_id, status);
create index if not exists skill_records_skill_idx
  on skill_records (company_id, skill_key, status);

-- The composite membership FK, the repository's established pattern: a skill record for a
-- membership of ANOTHER company is unrepresentable, not merely refused by application code.
do $$
begin
  if to_regclass('public.memberships') is null then
    raise notice 'R2C_DRAFT_016: memberships absent — skill membership FK SKIPPED (standalone draft database)';
    return;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.memberships'::regclass and conname = 'memberships_id_company_uq'
  ) then
    alter table public.memberships add constraint memberships_id_company_uq unique (id, company_id);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.skill_records'::regclass and conname = 'skill_records_member_company_fk'
  ) then
    alter table public.skill_records
      add constraint skill_records_member_company_fk
      foreign key (membership_id, company_id)
      references public.memberships (id, company_id)
      on delete cascade;
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 2. A VERIFIED provenance requires a verifier and a verification time.
--
--    "Evidence-verified" with nobody recorded as having verified it is a claim wearing a
--    costume, and it is exactly the shape that would let a bare text[] be relabelled as proof.
-- ─────────────────────────────────────────────────────────────────────────────────────────
alter table skill_records drop constraint if exists skill_records_verified_shape_ck;
alter table skill_records add constraint skill_records_verified_shape_ck check (
  provenance in ('self_declared', 'manager_entered')
  or (verified_by is not null and verified_at is not null
      and coalesce(btrim(evidence_ref), '') <> '')
);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 3. No protected characteristic may be recorded as a "skill".
--
--    A skill key is free text, so it is the obvious place to smuggle one — "skill: pregnant",
--    "skill: sinhalese_ethnicity". Refused at the database, where the application guard cannot
--    be bypassed by a caller nobody has written yet.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function r1_draft_skill_no_protected() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_forbidden text[] := array[
    'ethnicity','race','nationality','religion','belief','caste','political','politics',
    'union','health','disability','medical','pregnancy','pregnant','mental_health','sick',
    'gender','sex','sexuality','sexual_orientation','marital','married','family_status',
    'children','dependants','dependents','age','birth','dob','address','postcode',
    'photo','biometric','visa','immigration','criminal','salary','pay','wage'
  ];
  v_key text := lower(replace(replace(coalesce(new.skill_key, ''), '-', '_'), ' ', '_'));
  v_bad text;
begin
  foreach v_bad in array v_forbidden loop
    -- Whole-token match, so "payment_processing" is not refused for containing "pay" while
    -- "pay" and "pay_rate" still are.
    if v_key = v_bad
       or v_key like v_bad || '\_%'
       or v_key like '%\_' || v_bad
       or v_key like '%\_' || v_bad || '\_%' then
      raise exception 'refused: "%" names a protected or sensitive personal characteristic, not a skill', new.skill_key
        using errcode = 'insufficient_privilege';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists skill_records_no_protected on skill_records;
create trigger skill_records_no_protected
  before insert or update on skill_records
  for each row execute function r1_draft_skill_no_protected();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 4. Append-only audit history. The live row may change; what happened to it may not.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table if not exists skill_record_events (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  skill_record_id uuid not null references skill_records(id) on delete cascade,
  event           text not null check (event in (
                    'created', 'verified', 'expired', 'disputed', 'revoked', 'reinstated', 'amended')),
  from_status     text,
  to_status       text,
  provenance      text,
  actor_id        uuid,
  reason          text check (reason is null or char_length(reason) <= 1000),
  created_at      timestamptz not null default now()
);

create index if not exists skill_record_events_idx
  on skill_record_events (skill_record_id, created_at);

create or replace function r1_draft_skill_events_append_only() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  raise exception 'skill_record_events is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists skill_record_events_no_update on skill_record_events;
create trigger skill_record_events_no_update
  before update or delete on skill_record_events
  for each row execute function r1_draft_skill_events_append_only();

-- Every change to a live record writes its own history row. Automatic, because a history that
-- depends on the caller remembering to write it is a history with holes in it.
create or replace function r1_draft_skill_record_history() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into public.skill_record_events
      (company_id, skill_record_id, event, from_status, to_status, provenance, actor_id)
    values (new.company_id, new.id, 'created', null, new.status, new.provenance, new.verified_by);
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.skill_record_events
      (company_id, skill_record_id, event, from_status, to_status, provenance, actor_id)
    values (new.company_id, new.id,
            case new.status
              when 'expired' then 'expired'
              when 'disputed' then 'disputed'
              when 'revoked' then 'revoked'
              when 'active' then 'reinstated'
              else 'amended'
            end,
            old.status, new.status, new.provenance, new.verified_by);
  elsif new.provenance is distinct from old.provenance
        or new.expires_at is distinct from old.expires_at
        or new.evidence_ref is distinct from old.evidence_ref then
    insert into public.skill_record_events
      (company_id, skill_record_id, event, from_status, to_status, provenance, actor_id)
    values (new.company_id, new.id, 'amended', old.status, new.status, new.provenance, new.verified_by);
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists skill_records_history on skill_records;
create trigger skill_records_history
  after insert on skill_records
  for each row execute function r1_draft_skill_record_history();

drop trigger if exists skill_records_history_upd on skill_records;
create trigger skill_records_history_upd
  before update on skill_records
  for each row execute function r1_draft_skill_record_history();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 5. THE predicate. One definition, used by the application and available to SQL.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function r1_draft_skill_is_verified(p_record skill_records)
returns boolean
language sql immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select p_record.provenance in ('externally_certified', 'evidence_verified')
     and p_record.status = 'active'
     and (p_record.expires_at is null or p_record.expires_at >= current_date);
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 6. Staff language preference (owner: English, Sinhala, Tamil).
--
--    Language may gate a task that GENUINELY requires it and may not influence ranking
--    anywhere else. That rule lives in `gateLanguage` and is unchanged — this only supplies
--    the data it has been asking for since R2B.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table if not exists membership_languages (
  company_id    uuid not null,
  membership_id uuid not null,
  language      text not null check (language in ('en', 'si', 'ta')),
  proficiency   text not null default 'working'
                  check (proficiency in ('basic', 'working', 'fluent', 'native')),
  provenance    text not null default 'self_declared'
                  check (provenance in ('self_declared', 'manager_entered', 'evidence_verified')),
  -- Preference for RECEIVING communication. Distinct from being able to work in a language.
  is_preferred  boolean not null default false,
  created_at    timestamptz not null default now(),
  primary key (company_id, membership_id, language)
);

do $$
begin
  if to_regclass('public.memberships') is null then
    raise notice 'R2C_DRAFT_016: memberships absent — language membership FK SKIPPED';
    return;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.membership_languages'::regclass
       and conname = 'membership_languages_member_company_fk'
  ) then
    alter table public.membership_languages
      add constraint membership_languages_member_company_fk
      foreign key (membership_id, company_id)
      references public.memberships (id, company_id)
      on delete cascade;
  end if;
end
$$;

-- At most one PREFERRED language per person: a preference that is not singular is not a
-- preference, and the communication path would have to guess.
create unique index if not exists membership_languages_one_preferred
  on membership_languages (company_id, membership_id) where is_preferred;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 7. RLS: company-scoped reads through the existing identity function.
-- ─────────────────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  if to_regprocedure('public.has_company_access(uuid)') is null then return; end if;
  foreach t in array array['skill_records', 'skill_record_events', 'membership_languages'] loop
    execute format('alter table %I enable row level security', t);
    begin
      execute format(
        'create policy %I on %I for select using (has_company_access(company_id))', t || '_read', t);
    exception when duplicate_object then null;
    end;
  end loop;
end
$$;

-- The companies foreign key, added only where the production schema is present. The standalone
-- draft harness applies these units to an EMPTY database, so an inline reference cannot resolve.
do $$
begin
  if to_regclass('public.companies') is null then
    raise notice 'R2C draft: companies absent — skill_records company FK SKIPPED (standalone draft database)';
    return;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.skill_records'::regclass and conname = 'skill_records_company_fk'
  ) then
    alter table public.skill_records
      add constraint skill_records_company_fk foreign key (company_id) references public.companies(id) on delete cascade;
  end if;
end
$$;

-- The companies foreign key, added only where the production schema is present. The standalone
-- draft harness applies these units to an EMPTY database, so an inline reference cannot resolve.
do $$
begin
  if to_regclass('public.companies') is null then
    raise notice 'R2C draft: companies absent — skill_record_events company FK SKIPPED (standalone draft database)';
    return;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.skill_record_events'::regclass and conname = 'skill_record_events_company_fk'
  ) then
    alter table public.skill_record_events
      add constraint skill_record_events_company_fk foreign key (company_id) references public.companies(id) on delete cascade;
  end if;
end
$$;

-- The companies foreign key, added only where the production schema is present. The standalone
-- draft harness applies these units to an EMPTY database, so an inline reference cannot resolve.
do $$
begin
  if to_regclass('public.companies') is null then
    raise notice 'R2C draft: companies absent — membership_languages company FK SKIPPED (standalone draft database)';
    return;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.membership_languages'::regclass and conname = 'membership_languages_company_fk'
  ) then
    alter table public.membership_languages
      add constraint membership_languages_company_fk foreign key (company_id) references public.companies(id) on delete cascade;
  end if;
end
$$;
