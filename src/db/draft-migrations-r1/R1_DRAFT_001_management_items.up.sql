-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
-- See src/db/draft-migrations-r1/README.md. Owner decision R1-D-1.
--
-- R1_DRAFT_001 — management_items: one row per management-loop instance.
--
-- The item carries every field the owner requires to be retained: originating company and
-- department, source record, detected issue, priority and confidence, proposed next action,
-- recommended resource, authority requirement, accountable owner, deadline and monitoring
-- state, escalation path, and final outcome. Evidence, transitions, decisions and feedback
-- live in their own tables (units 002-004, 006) because each is append-only history.

create table if not exists management_items (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null,
  department               text not null
    check (department in ('finance', 'workforce', 'operations', 'crm', 'system')),
  kind                     text not null,

  -- The source record this item is about.
  subject_table            text not null,
  subject_id               text not null,

  -- Deduplication identity: company + kind + subject + occurrence window (AIM-002).
  identity_key             text not null,

  -- Lifecycle. 16 states — the 15 specified in the R1 architecture plus `needs_routing`,
  -- added by owner decision R1-D-3 so unrouted work is never dumped on an administrator.
  state                    text not null default 'observed'
    check (state in (
      'observed', 'understood', 'prioritised', 'recommended',
      'awaiting_approval', 'approved', 'rejected',
      'needs_routing', 'assigned', 'monitoring', 'escalated',
      'verifying', 'verified', 'reopened', 'dismissed', 'expired'
    )),

  priority                 text check (priority in ('critical', 'high', 'normal', 'low')),
  confidence               numeric(5, 4) check (confidence >= 0 and confidence <= 1),

  -- Authority (FOUND-004). Resolved by the existing authority engine, never by a model.
  required_authority       text,
  requires_approval        boolean not null default false,

  -- Proposal. `proposed_action` must be a REGISTERED catalogue action id (KRN-003) —
  -- the kernel can never propose free text.
  proposed_action          text,
  recommended_resource_type text
    check (recommended_resource_type is null
           or recommended_resource_type in ('staff', 'bot', 'external')),
  recommended_resource_id  text,

  -- Accountability. R1-D-3: when no suitable authorised assignee can be recommended the
  -- item goes to `needs_routing` with a recorded reason, into the relevant authorised
  -- department queue — NEVER silently to the owner or an administrator.
  accountable_owner_id     uuid,
  routing_department       text,
  routing_reason           text,
  routing_requested_at     timestamptz,
  routing_notified_at      timestamptz,  -- set once; suppresses repeat notification

  -- Deadlines. R1-D-4 keeps these strictly separate and forbids inventing either.
  --   business_deadline  — the real-world deadline. NULL unless it came from source
  --                        evidence or company policy; `business_deadline_source` says which.
  --   review_by          — when management should look again. NULL when no review policy is
  --                        configured, and the surface must then say "review timing not
  --                        configured" rather than fabricating a time.
  business_deadline        timestamptz,
  business_deadline_source text
    check (business_deadline_source is null
           or business_deadline_source in ('evidence', 'policy')),
  review_by                timestamptz,
  review_policy_id         text,

  monitoring_state         text
    check (monitoring_state is null
           or monitoring_state in ('on_track', 'due_soon', 'overdue', 'stalled', 'unknown')),
  escalation_path          jsonb not null default '[]'::jsonb,

  outcome                  text
    check (outcome is null
           or outcome in ('resolved', 'not_resolved', 'rejected', 'dismissed', 'expired')),
  outcome_reason           text,
  outcome_at               timestamptz,

  -- R1-D-2: LINK ONLY. R1 does not write management_cases and does not alter its
  -- service-only atomic RPC.
  management_case_id       uuid,

  -- Interpretation provenance (R1-D-6: deterministic fixture adapter in R1).
  interpretation_source    text
    check (interpretation_source is null
           or interpretation_source in ('none', 'fixture', 'model')),
  interpretation_status    text
    check (interpretation_status is null
           or interpretation_status in ('ok', 'malformed', 'timeout', 'low_confidence', 'disagreement', 'unavailable')),
  interpretation_note      text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- One item per condition occurrence, per company (AIM-002 deduplication).
  constraint management_items_company_identity_uq unique (company_id, identity_key),

  -- A business deadline may not exist without stating where it came from, and a source may
  -- not be claimed without a deadline. This is the R1-D-4 "never invent a deadline" rule
  -- enforced by the database rather than by convention.
  constraint management_items_deadline_provenance_ck
    check ((business_deadline is null) = (business_deadline_source is null)),

  -- A review time may not exist without the policy that produced it.
  constraint management_items_review_provenance_ck
    check ((review_by is null) or (review_policy_id is not null)),

  -- Terminal states must record an outcome; non-terminal states must not claim one.
  constraint management_items_outcome_ck
    check (
      (state in ('verified', 'rejected', 'dismissed', 'expired') and outcome is not null)
      or (state not in ('verified', 'rejected', 'dismissed', 'expired') and outcome is null)
    )
);

create index if not exists management_items_company_state_idx
  on management_items (company_id, state);
create index if not exists management_items_company_dept_idx
  on management_items (company_id, department, state);
create index if not exists management_items_review_idx
  on management_items (company_id, review_by) where review_by is not null;
create index if not exists management_items_subject_idx
  on management_items (company_id, subject_table, subject_id);

-- `updated_at` maintenance.
create or replace function r1_draft_touch_updated_at() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists management_items_touch on management_items;
create trigger management_items_touch
  before update on management_items
  for each row execute function r1_draft_touch_updated_at();

-- Base-schema-aware wiring: applied ONLY when the full application schema is present, so
-- the same file works standalone on a disposable database and on top of the real schema.
do $$
begin
  if to_regclass('public.companies') is not null then
    begin
      alter table management_items
        add constraint management_items_company_fk
        foreign key (company_id) references companies(id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;

  if to_regclass('public.management_cases') is not null then
    begin
      alter table management_items
        add constraint management_items_case_fk
        foreign key (management_case_id) references management_cases(id) on delete set null;
    exception when duplicate_object then null;
    end;
  end if;

  -- Company-scoped read isolation, matching the existing pattern. Only when the helper
  -- exists; the reconciled numbered migration must additionally add the capability-gated
  -- write matrix and composite (company_id, id) FKs used elsewhere in this repository.
  if to_regproc('public.has_company_access(uuid)') is not null then
    execute 'alter table management_items enable row level security';
    begin
      execute 'create policy management_items_read on management_items
                 for select using (has_company_access(company_id))';
    exception when duplicate_object then null;
    end;
  end if;
end
$$;
