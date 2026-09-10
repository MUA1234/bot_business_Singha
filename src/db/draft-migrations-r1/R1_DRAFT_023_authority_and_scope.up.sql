-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_023 — owner and specialist authority, and authority-scoped queue visibility.
--
-- Two things, both narrow, both under the owner's decision of 2026-09-05.
--
-- ── 1. R2-F-017: the two authority levels the database could not establish ────────────────
--
-- The decision RPC has been refusing `owner_approval` and `specialist_approval` because nothing
-- in the database could establish either for a user. `authority_ceiling` and `within_authority`
-- are AMOUNT-based; no capability distinguished an owner or a specialist from an ordinary
-- approver. Refusing was correct — inventing a rule would have been worse — but it left two real
-- authority levels permanently unusable.
--
-- The owner's decision resolves it with a dedicated capability for owner approval and an
-- EXHAUSTIVE domain map for specialist approval. Where a domain has no registered specialist
-- capability the decision stays unavailable and says which domain, rather than falling back to
-- something adjacent.
--
-- ── 2. R2F-F-003: every member could read every item, and all its evidence ────────────────
--
-- Draft 007 gives all six R1 tables one SELECT policy: `has_company_access(company_id)`, which
-- requires an active membership and nothing else. So an ordinary member of staff could read every
-- management item in the company and — the part that matters — every EVIDENCE row attached to
-- them, including the `legal` and `workforce` domains the owner names as sensitive.
--
-- Company isolation was never the problem: `has_company_access` is company-scoped and the
-- cross-company tests pass. What was missing is scope WITHIN a company.
--
-- This is enforced in RLS rather than in the panel, so it holds for a direct API call, a guessed
-- item id and a hand-written query, not only for the screen.

-- ── 1. Capability registration, in the existing `domain.object.verb` convention ───────────
insert into public.permissions (key, label) values
  ('management.decision.approve_owner',
   'Management: approve a decision that requires OWNER authority'),
  ('management.queue.view_company',
   'Management: see the whole company''s management queue, across departments')
on conflict do nothing;

-- Granted to the repository's OWNER classification only. A `project_manager` does not hold either,
-- and holding `approve` does not confer them.
insert into public.role_permissions (role_key, permission_key) values
  ('owner_management', 'management.decision.approve_owner'),
  ('owner_management', 'management.queue.view_company')
on conflict do nothing;

-- The system administrator holds every permission, as migration 0038 establishes. Re-run so the
-- two new ones are included rather than silently omitted.
insert into public.role_permissions (role_key, permission_key)
select 'system_administrator', p.key from public.permissions p
on conflict do nothing;

-- ── 2. Specialist authority: an EXHAUSTIVE domain map ────────────────────────────────────
--
-- Returns the registered capability that constitutes specialist authority for a department, or
-- NULL when that domain has none. NULL is the honest answer for ten of the twelve domains, and the
-- caller reports it as such instead of substituting something adjacent.
--
-- `finance` is deliberately NULL. The candidates — `finance.journal.post`, `finance.reconcile` —
-- are accounting authority, and the owner's authorisation explicitly does not widen financial or
-- accounting controls. A finance item needing specialist approval is refused with a reason.
--
-- An owner does NOT automatically satisfy these. The map is consulted, not the role. Where
-- `owner_management` does pass one, it is because migration 0038 explicitly grants it
-- `legal.matter.manage` and `hr.staff.manage` — an existing written authority rule, not an
-- inference from ownership.
create or replace function public.r1_draft_specialist_capability(p_department text)
returns text
language sql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select case p_department
    when 'legal'       then 'legal.matter.manage'
    when 'workforce'   then 'hr.staff.manage'
    -- No registered specialist capability. Listed explicitly rather than left to a default, so
    -- adding a domain forces a decision about it.
    when 'finance'     then null
    when 'operations'  then null
    when 'crm'         then null
    when 'system'      then null
    when 'governance'  then null
    when 'objectives'  then null
    when 'marketing'   then null
    when 'procurement' then null
    when 'assets'      then null
    when 'providers'   then null
    -- An unknown department is not a domain this system knows, so it has no specialist.
    else null
  end;
$$;

-- ── 3. Departments a MANAGER may see, by capability they already hold ────────────────────
--
-- Exhaustive, and deliberately narrow. `procurement` maps to `procurement.po.approve` rather than
-- `procurement.request.create` because ordinary staff hold the latter — using it would have made
-- the manager tier meaningless for that domain.
--
-- The sensitive domains (`legal`, `workforce`) are NOT here: they are gated by their specialist
-- capability alone, in the predicate below, so a company-wide viewer without the domain capability
-- does not see them.
create or replace function public.r1_draft_department_capability(p_department text)
returns text
language sql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select case p_department
    when 'operations'  then 'operations.task.manage'
    when 'procurement' then 'procurement.po.approve'
    when 'finance'     then 'finance.reconcile'
    else null
  end;
$$;

-- ── 4. The visibility predicate ──────────────────────────────────────────────────────────
--
-- One place, used by every policy below, so the item and its evidence can never disagree about
-- who may see them.
--
-- Order matters:
--   1. no active membership in the item's company  → nothing (also covers cross-company)
--   2. sensitive domain                            → the domain capability, and nothing else
--   3. company-wide viewer                         → visible
--   4. department the viewer manages               → visible
--   5. the viewer's own accountable work           → visible
--   6. otherwise                                   → not visible
--
-- Step 2 comes BEFORE step 3 deliberately: a company-wide viewer is not thereby entitled to
-- grievance or compliance evidence. The owner's requirement is that sensitive material is
-- separately gated, which means separately from the general permission too.
create or replace function public.r1_draft_may_see_management_item(
  p_company    uuid,
  p_department text,
  p_owner      uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_actor uuid := auth.uid();
  v_spec  text;
  v_dept  text;
begin
  if v_actor is null or p_company is null then
    return false;
  end if;

  -- 1. Active membership in THIS company. Revoked, ended or foreign ⇒ nothing.
  if not exists (
    select 1 from public.memberships m
     where m.user_id = v_actor and m.company_id = p_company and m.status = 'active'
  ) then
    return false;
  end if;

  -- 2. Sensitive domains: the domain capability, and no substitute.
  v_spec := public.r1_draft_specialist_capability(p_department);
  if p_department in ('legal', 'workforce') then
    return coalesce(public.has_capability(p_company, v_spec), false);
  end if;

  -- 3. Cross-domain visibility, explicitly granted.
  if public.has_capability(p_company, 'management.queue.view_company') then
    return true;
  end if;

  -- 4. A department this person manages.
  v_dept := public.r1_draft_department_capability(p_department);
  if v_dept is not null and public.has_capability(p_company, v_dept) then
    return true;
  end if;

  -- 5. Their own accountable work. `accountable_owner_id` is a MEMBERSHIP id.
  if p_owner is not null and exists (
    select 1 from public.memberships m
     where m.id = p_owner and m.user_id = v_actor
       and m.company_id = p_company and m.status = 'active'
  ) then
    return true;
  end if;

  return false;
end;
$fn$;

/** The same question, asked about an item id — for the child tables. */
create or replace function public.r1_draft_may_see_item(p_item uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(
    (select public.r1_draft_may_see_management_item(i.company_id, i.department,
                                                    i.accountable_owner_id)
       from public.management_items i
      where i.id = p_item),
    false);
$$;

-- ── 5. Replace the company-wide SELECT policies with scoped ones ─────────────────────────
do $$
begin
  if to_regprocedure('public.has_capability(uuid, text)') is null then
    raise notice 'R1_DRAFT_023: base identity functions absent — policies SKIPPED';
    return;
  end if;

  -- The item itself.
  execute 'drop policy if exists management_items_sel on public.management_items';
  execute 'create policy management_items_sel on public.management_items
             for select to authenticated
             using (public.r1_draft_may_see_management_item(company_id, department,
                                                            accountable_owner_id))';

  -- Its evidence, transitions, decisions and feedback follow the item exactly. Scoping the item
  -- but not its evidence would hide the headline and publish the contents.
  execute 'drop policy if exists management_item_evidence_sel on public.management_item_evidence';
  execute 'create policy management_item_evidence_sel on public.management_item_evidence
             for select to authenticated using (public.r1_draft_may_see_item(item_id))';

  execute 'drop policy if exists management_item_transitions_sel on public.management_item_transitions';
  execute 'create policy management_item_transitions_sel on public.management_item_transitions
             for select to authenticated using (public.r1_draft_may_see_item(item_id))';

  execute 'drop policy if exists management_item_decisions_sel on public.management_item_decisions';
  execute 'create policy management_item_decisions_sel on public.management_item_decisions
             for select to authenticated using (public.r1_draft_may_see_item(item_id))';

  execute 'drop policy if exists management_item_feedback_sel on public.management_item_feedback';
  execute 'create policy management_item_feedback_sel on public.management_item_feedback
             for select to authenticated using (public.r1_draft_may_see_item(item_id))';

  -- `observation_sources` is deliberately untouched: it carries no business content, and every
  -- member needs it to know whether a department was observed at all. Hiding it would turn a
  -- failed detector into a silent all-clear, which is the defect the queue exists to avoid.
end $$;

-- ── 6. Privileges ────────────────────────────────────────────────────────────────────────
do $$
begin
  for i in 1..1 loop
    execute 'revoke all on function public.r1_draft_may_see_management_item(uuid, text, uuid) from public';
    execute 'revoke all on function public.r1_draft_may_see_item(uuid) from public';
    execute 'revoke all on function public.r1_draft_specialist_capability(text) from public';
    execute 'revoke all on function public.r1_draft_department_capability(text) from public';
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'grant execute on function public.r1_draft_may_see_management_item(uuid, text, uuid) to authenticated';
      execute 'grant execute on function public.r1_draft_may_see_item(uuid) to authenticated';
      execute 'grant execute on function public.r1_draft_specialist_capability(text) to authenticated';
      execute 'grant execute on function public.r1_draft_department_capability(text) to authenticated';
    end if;
  end loop;
end $$;
