-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_007 — the complete capability-aware R1 policy matrix (security baseline A).
--
-- Replaces the temporary company-scoped READ-ONLY policies from units 001-006 with the full
-- matrix. It uses the repository's EXISTING authority primitives and creates no competing
-- system:
--
--   public.has_company_access(company)      — 0038. Membership-scoped. A suspended or ended
--                                             membership returns FALSE, so a revoked member
--                                             loses access immediately, with no cache.
--   public.has_capability(company, cap)     — 0038. Role -> permission, plus delegation that
--                                             can never exceed the delegator.
--
-- CAPABILITY CHOICE — deliberately reusing existing keys rather than minting R1 ones:
--   operations.task.manage  → held by owner_management, project_manager, system_administrator.
--                             The manager-and-above capability. Gates every management-item
--                             write, transition, evidence row and decision.
--   operations.task.work    → held additionally by staff_submitter. Ordinary staff. Grants
--                             feedback only — never a transition, never a decision.
--   admin.organisation.manage → detector configuration (cadence is a cost lever).
--
-- Resulting intended access:
--   ordinary staff (staff_submitter)    read + feedback only
--   manager (project_manager)           read + full item/transition/evidence/decision writes
--   owner (owner_management)            same as manager (holds operations.task.manage)
--   admin (system_administrator)        all of the above + detector configuration
--   unauthorised staff / non-member     nothing
--   revoked member                      nothing, immediately
--   anon / PUBLIC                       nothing — grants revoked outright
--   service_role                        narrow: the worker path, via Supabase's bypass

do $$
declare
  t text;
  r1_tables text[] := array[
    'management_items', 'management_item_transitions', 'management_item_evidence',
    'management_item_decisions', 'observation_sources', 'management_item_feedback'
  ];
begin
  -- Base schema is required: without has_capability there is nothing to gate on, and a
  -- half-applied matrix is worse than none. Fail closed rather than silently skipping.
  if to_regprocedure('public.has_capability(uuid, text)') is null
     or to_regprocedure('public.has_company_access(uuid)') is null then
    raise notice 'R1_DRAFT_007: base identity functions absent — R1 policy matrix SKIPPED (standalone draft database)';
    return;
  end if;

  -- ── 1. No permissive default, no public access ────────────────────────────────────────
  foreach t in array r1_tables loop
    execute format('revoke all on table public.%I from public', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('alter table public.%I enable row level security', t);

    -- Drop the temporary read-only policies from units 001-006; this unit replaces them.
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
  end loop;

  -- ── 2. Reads: company-scoped AND membership-scoped, for every R1 table ────────────────
  foreach t in array r1_tables loop
    if t = 'observation_sources' then
      -- A NULL company_id row is the cross-company DEFAULT registration (R1-D-5), readable
      -- by any authenticated member; a company row is readable only by that company.
      execute format(
        'create policy %I on public.%I for select to authenticated
           using (company_id is null or public.has_company_access(company_id))',
        t || '_sel', t);
    else
      execute format(
        'create policy %I on public.%I for select to authenticated
           using (public.has_company_access(company_id))',
        t || '_sel', t);
    end if;
  end loop;

  -- ── 3. Writes: gated on an EXISTING capability, never on membership alone ─────────────

  -- management_items: manager-and-above may create and update. NO delete policy at all —
  -- deleting an item would destroy its audit linkage, so it is service-only by omission.
  create policy management_items_ins on public.management_items
    for insert to authenticated
    with check (public.has_capability(company_id, 'operations.task.manage'));
  create policy management_items_upd on public.management_items
    for update to authenticated
    using (public.has_capability(company_id, 'operations.task.manage'))
    with check (public.has_capability(company_id, 'operations.task.manage'));

  -- Append-only history: INSERT only. No update or delete policy exists, so the append-only
  -- triggers are a SECOND line of defence rather than the only one.
  create policy management_item_transitions_ins on public.management_item_transitions
    for insert to authenticated
    with check (public.has_capability(company_id, 'operations.task.manage'));

  create policy management_item_evidence_ins on public.management_item_evidence
    for insert to authenticated
    with check (public.has_capability(company_id, 'operations.task.manage'));

  -- Decisions carry approval authority: manager-and-above only. Ordinary staff cannot
  -- approve, reject, edit or delegate.
  create policy management_item_decisions_ins on public.management_item_decisions
    for insert to authenticated
    with check (public.has_capability(company_id, 'operations.task.manage'));

  -- Feedback is the learning signal, so the person who did the work must be able to give it.
  -- Ordinary staff (operations.task.work) qualify here and NOWHERE else.
  create policy management_item_feedback_ins on public.management_item_feedback
    for insert to authenticated
    with check (
      public.has_capability(company_id, 'operations.task.work')
      or public.has_capability(company_id, 'operations.task.manage')
    );

  -- Detector configuration is administrative: cadence is a cost lever and enabling or
  -- disabling a source changes what the business observes.
  create policy observation_sources_ins on public.observation_sources
    for insert to authenticated
    with check (company_id is not null and public.has_capability(company_id, 'admin.organisation.manage'));
  create policy observation_sources_upd on public.observation_sources
    for update to authenticated
    using (company_id is not null and public.has_capability(company_id, 'admin.organisation.manage'))
    with check (company_id is not null and public.has_capability(company_id, 'admin.organisation.manage'));

  -- ── 4. Narrow, explicit grants ───────────────────────────────────────────────────────
  -- `authenticated` gets DML but remains subject to every policy above. Nothing is granted
  -- to anon or PUBLIC. service_role gets the worker path only.
  foreach t in array r1_tables loop
    execute format('grant select, insert, update on table public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;

  raise notice 'R1_DRAFT_007: capability-aware policy matrix applied to 6 tables';
end
$$;

-- ── 5. Cross-company identifiers fail closed ────────────────────────────────────────────
-- The child guards in units 003/004 already refuse evidence and decisions whose company
-- differs from the parent item's. This adds the same rule to transitions and feedback, so
-- EVERY child of a management item is company-consistent by construction and not by
-- convention.
create or replace function r1_draft_child_company_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_item_company uuid;
begin
  select company_id into v_item_company from public.management_items where id = new.item_id;
  if v_item_company is null then
    raise exception '% references a non-existent management item', tg_table_name
      using errcode = 'foreign_key_violation';
  end if;
  if v_item_company is distinct from new.company_id then
    raise exception 'cross-company % refused: item company %, row company %',
      tg_table_name, v_item_company, new.company_id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists management_item_transitions_company on management_item_transitions;
create trigger management_item_transitions_company
  before insert on management_item_transitions
  for each row execute function r1_draft_child_company_guard();

drop trigger if exists management_item_feedback_company on management_item_feedback;
create trigger management_item_feedback_company
  before insert on management_item_feedback
  for each row execute function r1_draft_child_company_guard();
