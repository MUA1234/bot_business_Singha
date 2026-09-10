-- ⛔ R1/R2C DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
-- Owner decision R1-D-1: no production migration number until PR-F-001 and PR-F-004 close.
--
-- R2C_DRAFT_017 — advisor relationships and consultant engagements.
--
-- Two structures that genuinely do not exist. Nothing in the schema names an advisor at all, and
-- `service_providers` describes a PROVIDER — it does not describe an ENGAGEMENT with a scope, an
-- expiry and an access boundary, which is what a consultant recommendation has to be bounded by.

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 1. Advisor relationships.
--
-- An advisor supplies guidance and owns NOTHING: no delivery, no authority, no approval. The
-- relationship therefore records what someone may advise ON and what evidences it — never a
-- permission, and never a capability. There is deliberately no `can_approve` column: a field
-- that does not exist cannot be set by mistake.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table if not exists advisor_relationships (
  id             uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  membership_id  uuid not null,

  -- The subject they may advise on: a business domain, matched against the action's domain.
  domain         text not null,
  -- What evidences the experience. A reference, never a copied document or a free-text boast.
  evidence_ref   text,
  evidence_table text,

  status         text not null default 'active'
                   check (status in ('active', 'suspended', 'ended')),
  starts_at      timestamptz not null default now(),
  ends_at        timestamptz,

  created_by     uuid,
  created_at     timestamptz not null default now(),

  unique (company_id, membership_id, domain),
  check (ends_at is null or ends_at > starts_at)
);

create index if not exists advisor_rel_lookup_idx
  on advisor_relationships (company_id, domain, status);

do $$
begin
  if to_regclass('public.memberships') is null then
    raise notice 'R2C_DRAFT_017: memberships absent — advisor membership FK SKIPPED';
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
     where conrelid = 'public.advisor_relationships'::regclass
       and conname = 'advisor_rel_member_company_fk'
  ) then
    alter table public.advisor_relationships
      add constraint advisor_rel_member_company_fk
      foreign key (membership_id, company_id)
      references public.memberships (id, company_id)
      on delete cascade;
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 2. Consultant engagements.
--
-- THE ACCESS BOUNDARY IS UNREPRESENTABLE, NOT MERELY DEFAULTED. `internal_access` exists as a
-- column so that any future reader can SEE the answer rather than having to infer it from an
-- absence — and it carries a CHECK that forbids `true`. Setting it is not a permission decision
-- someone can make carelessly; it is a schema change that has to be reviewed.
--
-- Granting a consultant access to internal systems is a separate, human, audited act that has
-- nothing to do with this table. A recommendation grants nothing.
-- ─────────────────────────────────────────────────────────────────────────────────────────
create table if not exists consultant_engagements (
  id              uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  provider_id     uuid not null,

  -- Domains the engagement covers. EMPTY means no approved scope, and the resolver refuses it.
  scope_domains   text[] not null default '{}',
  -- Skills the provider is engaged FOR. Matched against what the work requires.
  scope_skills    text[] not null default '{}',

  status          text not null default 'proposed'
                    check (status in ('proposed', 'approved', 'suspended', 'ended')),

  starts_at       timestamptz not null default now(),
  ends_at         timestamptz,

  -- NEVER true. See the header.
  internal_access boolean not null default false,

  approved_by     uuid,
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),

  check (ends_at is null or ends_at > starts_at),
  constraint consultant_engagements_no_internal_access check (internal_access = false),
  -- An APPROVED engagement must say who approved it and when. An approval nobody signed is not
  -- an approval, and this is the field a recommendation relies on.
  constraint consultant_engagements_approval_shape check (
    status <> 'approved' or (approved_by is not null and approved_at is not null)
  )
);

create index if not exists consultant_engagements_lookup_idx
  on consultant_engagements (company_id, status);

-- The provider must belong to the SAME company. A consultant approved by one company is not
-- thereby approved by another, and the composite FK makes the cross-company case impossible.
do $$
begin
  if to_regclass('public.service_providers') is null then
    raise notice 'R2C_DRAFT_017: service_providers absent — engagement provider FK SKIPPED';
    return;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.service_providers'::regclass
       and conname = 'service_providers_id_company_uq'
  ) then
    alter table public.service_providers
      add constraint service_providers_id_company_uq unique (id, company_id);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.consultant_engagements'::regclass
       and conname = 'consultant_engagements_provider_company_fk'
  ) then
    alter table public.consultant_engagements
      add constraint consultant_engagements_provider_company_fk
      foreign key (provider_id, company_id)
      references public.service_providers (id, company_id)
      on delete cascade;
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- 3. RLS: company-scoped reads through the existing identity function.
-- ─────────────────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  if to_regprocedure('public.has_company_access(uuid)') is null then return; end if;
  foreach t in array array['advisor_relationships', 'consultant_engagements'] loop
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
    raise notice 'R2C draft: companies absent — advisor_relationships company FK SKIPPED (standalone draft database)';
    return;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.advisor_relationships'::regclass and conname = 'advisor_relationships_company_fk'
  ) then
    alter table public.advisor_relationships
      add constraint advisor_relationships_company_fk foreign key (company_id) references public.companies(id) on delete cascade;
  end if;
end
$$;

-- The companies foreign key, added only where the production schema is present. The standalone
-- draft harness applies these units to an EMPTY database, so an inline reference cannot resolve.
do $$
begin
  if to_regclass('public.companies') is null then
    raise notice 'R2C draft: companies absent — consultant_engagements company FK SKIPPED (standalone draft database)';
    return;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.consultant_engagements'::regclass and conname = 'consultant_engagements_company_fk'
  ) then
    alter table public.consultant_engagements
      add constraint consultant_engagements_company_fk foreign key (company_id) references public.companies(id) on delete cascade;
  end if;
end
$$;
