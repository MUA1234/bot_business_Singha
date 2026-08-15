-- 0048_wp10_sensitive_write_rls.sql
-- Correction brief 0048 — WP10: remove broad company-member writes on commercially
-- sensitive tables. An ordinary company member must NEVER gain write access merely by
-- belonging to the company (system invariant #2). Sensitive tables move to
-- operation-specific capabilities; WhatsApp history and worker-generated notifications
-- become service-only (a member cannot forge or alter them).
--
-- BEHAVIOUR CHANGE: none at runtime. RLS_WRITES is OFF in every environment, so
-- application writes use the service-role client, which BYPASSES RLS. These policies take
-- effect only at the future, owner-gated RLS_WRITES cutover. This migration changes no
-- data and no application code path.
--
-- Forward-only; safe to run once. Cross-company writes remain impossible because
-- has_capability(company_id, cap) is company-scoped and requires an ACTIVE membership.

-- 1) New least-privilege domain capabilities.
insert into permissions (key, label) values
  ('sales.catalog.manage',             'Manage product catalog and prices'),
  ('sales.quotation.manage',           'Manage quotations and quotation lines'),
  ('sales.order.manage',               'Manage sales orders'),
  ('sales.pipeline.manage',            'Manage leads and opportunities'),
  ('marketing.campaign.manage',        'Manage marketing campaigns and audiences'),
  ('governance.approval_policy.manage','Manage approval policies'),
  ('documents.manage',                 'Manage documents'),
  ('admin.organisation.manage',        'Manage organisation structure (divisions, branches, departments, sites, projects, cost centres)'),
  ('operations.objective.manage',      'Manage operational objectives')
on conflict (key) do nothing;

-- 2) Role -> capability map (least privilege; documented per role).
--    * system_administrator: ALL new capabilities (brief §WP10.4).
--    * owner_management: senior business management — holds the business-management set.
--    * EVERY other role — project_manager, accountant, finance_reviewer, payment_*,
--      auditor_readonly, staff_submitter — receives NONE of these. An ordinary staff
--      member therefore cannot change a price, an issued quotation, an approval policy,
--      org structure, or WhatsApp history.
--    * project_manager is intentionally NOT granted documents.manage /
--      operations.objective.manage: those capabilities are company-wide as defined here,
--      so granting them to a project manager would misrepresent company-wide authority as
--      project-scoped. Real project-scoped authorisation does not yet exist; until it does
--      this stays deny-by-default (a later WP can add scoped capabilities + a scope-aware
--      check and grant them to project_manager then).
insert into role_permissions (role_key, permission_key) values
  ('system_administrator','sales.catalog.manage'),
  ('system_administrator','sales.quotation.manage'),
  ('system_administrator','sales.order.manage'),
  ('system_administrator','sales.pipeline.manage'),
  ('system_administrator','marketing.campaign.manage'),
  ('system_administrator','governance.approval_policy.manage'),
  ('system_administrator','documents.manage'),
  ('system_administrator','admin.organisation.manage'),
  ('system_administrator','operations.objective.manage'),
  ('owner_management','sales.catalog.manage'),
  ('owner_management','sales.quotation.manage'),
  ('owner_management','sales.order.manage'),
  ('owner_management','sales.pipeline.manage'),
  ('owner_management','marketing.campaign.manage'),
  ('owner_management','governance.approval_policy.manage'),
  ('owner_management','documents.manage'),
  ('owner_management','admin.organisation.manage'),
  ('owner_management','operations.objective.manage')
on conflict (role_key, permission_key) do nothing;

-- 3) Capability-gate the sensitive tables: drop the generic company-member write
--    policies (0034) and create operation-specific has_capability() write policies.
do $$
declare
  pairs text[][] := array[
    ['product_catalog','sales.catalog.manage'],
    ['quotations','sales.quotation.manage'],
    ['quotation_items','sales.quotation.manage'],
    ['price_confirmations','sales.quotation.manage'],
    ['orders','sales.order.manage'],
    ['leads','sales.pipeline.manage'],
    ['opportunities','sales.pipeline.manage'],
    ['campaigns','marketing.campaign.manage'],
    ['audiences','marketing.campaign.manage'],
    ['approval_policies','governance.approval_policy.manage'],
    ['documents','documents.manage'],
    ['divisions','admin.organisation.manage'],
    ['branches','admin.organisation.manage'],
    ['departments','admin.organisation.manage'],
    ['sites','admin.organisation.manage'],
    ['projects','admin.organisation.manage'],
    ['cost_centres','admin.organisation.manage'],
    ['objectives','operations.objective.manage']
  ];
  t text; cap text;
begin
  for i in 1 .. array_length(pairs,1) loop
    t := pairs[i][1]; cap := pairs[i][2];
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_w_ins', t);
    execute format('drop policy if exists %I on %I', t||'_w_upd', t);
    execute format('drop policy if exists %I on %I', t||'_w_del', t);
    execute format('drop policy if exists %I on %I', t||'_cap_ins', t);
    execute format('drop policy if exists %I on %I', t||'_cap_upd', t);
    execute format('drop policy if exists %I on %I', t||'_cap_del', t);
    execute format($f$create policy %I on %I for insert with check (public.has_capability(company_id, %L))$f$, t||'_cap_ins', t, cap);
    execute format($f$create policy %I on %I for update using (public.has_capability(company_id, %L)) with check (public.has_capability(company_id, %L))$f$, t||'_cap_upd', t, cap, cap);
    execute format($f$create policy %I on %I for delete using (public.has_capability(company_id, %L))$f$, t||'_cap_del', t, cap);
  end loop;
end $$;

-- 4) WhatsApp history and worker-generated notifications become SERVICE-ONLY: no
--    authenticated write path at all (the webhook/AI workers write them via the
--    service-role client). Drop member write policies and REVOKE the DML grants from
--    authenticated; the read policy and SELECT grant are left untouched.
do $$
declare
  svc text[] := array['wa_conversations','wa_messages','notifications'];
  t text;
begin
  foreach t in array svc loop
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_w_ins', t);
    execute format('drop policy if exists %I on %I', t||'_w_upd', t);
    execute format('drop policy if exists %I on %I', t||'_w_del', t);
    execute format('revoke insert, update, delete on %I from authenticated', t);
  end loop;
end $$;
