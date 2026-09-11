-- 0070_identity_backfill_and_event_lifecycle.sql
--
-- DATA REPAIR ONLY — no schema change, no new object, fully idempotent, forward-only.
-- Three defects found on the live system on 2026-09-11, each repaired from evidence already
-- in the database (nothing is invented):
--
--   A. Employees created after migration 0010 exist ONLY as `profiles` rows. 0010 backfilled
--      `users`/`memberships`/`membership_roles` once, at migration time, and the admin panel
--      was never taught to write them, so every later employee is invisible to
--      `has_membership()` / `has_capability()` / `lib/access.ts` — and would be denied
--      outright once RLS_READS/RLS_WRITES become the enforcement path. Five live accounts.
--      (The app-side cause is fixed in `src/lib/identity-provisioning.ts`; this repairs the
--      rows that already exist and makes re-running the repair safe.)
--
--   B. `source_events.status` was never advanced past `received` by ANY code path, so
--      /api/health counted every processed message as "unprocessed" for ever and a genuinely
--      stuck event was indistinguishable from a delivered one. Rows are closed out here ONLY
--      where the database itself proves the message was handled: the matching inbound
--      `wa_messages` row carries a non-NULL `handled_at`. `processed_at` is set to that
--      evidence timestamp, not to now(), and `company_id` is taken from the same row.
--      (The app-side cause is fixed in the webhook + Inngest worker.)
--
--   C. The unattended `ai-monitor` sweep passed the COMPANY id as the actor id, so
--      `management_cases.created_by`, `tasks.created_by` and `audit_events.actor_id` recorded
--      a company uuid as though a company had authored the work. Neither column has an FK, so
--      it was accepted silently. Migration 0049's convention for a non-human actor is a NULL
--      actor id with actor_type 'ai'/'system'. Only rows whose actor id IS a company id are
--      corrected, so a genuine human actor can never be erased. `audit_events` is append-only
--      by trigger, so the audit rows are LEFT AS THEY ARE — corrected going forward, never
--      rewritten (that immutability is the point of the trail).

begin;

-- ── A. Membership identity for every active profile ──────────────────────────────────────

-- A1. `users` mirrors auth.users and is the FK target for memberships.
insert into users (id, full_name, is_active)
select p.id, p.full_name, p.is_active
  from profiles p
 where not exists (select 1 from users u where u.id = p.id);

-- A2. One membership per (company, user). `unique (company_id, user_id)` makes this a no-op
--     on re-run and cannot disturb an existing membership's status.
insert into memberships (company_id, user_id, status)
select p.company_id, p.id, case when p.is_active then 'active' else 'suspended' end
  from profiles p
 where not exists (
   select 1 from memberships m where m.company_id = p.company_id and m.user_id = p.id
 );

-- A3. Roles — identical mapping to 0010's backfill and to `rolesForEmployee()` in
--     `src/lib/identity-provisioning.ts`: everyone submits; an admin also administers.
insert into membership_roles (membership_id, company_id, role_key)
select m.id, m.company_id, 'staff_submitter'
  from memberships m
 on conflict do nothing;

insert into membership_roles (membership_id, company_id, role_key)
select m.id, m.company_id, 'system_administrator'
  from memberships m
  join profiles p on p.id = m.user_id and p.company_id = m.company_id
 where p.is_admin
 on conflict do nothing;

-- A4. A deactivated profile must not keep an active membership — otherwise the suspension
--     does not reach the model that will enforce access. Deliberately ONE-WAY: this repair
--     suspends, it never re-activates. Restoring access is a privilege grant and belongs to an
--     administrator acting through the audited admin panel, not to a data-repair migration.
update memberships m
   set status = 'suspended'
  from profiles p
 where p.id = m.user_id
   and p.company_id = m.company_id
   and p.is_active = false
   and m.status = 'active';

-- ── B. Close out source events the database proves were handled ──────────────────────────

with handled as (
  select se.id                   as source_event_id,
         max(wm.handled_at)      as handled_at,
         max(wm.company_id::text)::uuid as company_id
    from source_events se
    join wa_messages wm
      on wm.wa_message_id = se.provider_message_id
     and wm.direction = 'inbound'
     and wm.handled_at is not null
   where se.source = 'whatsapp'
     and se.status in ('received', 'processing')
   group by se.id
)
update source_events se
   set status       = 'processed',
       processed_at = h.handled_at,
       company_id   = coalesce(se.company_id, h.company_id)
  from handled h
 where h.source_event_id = se.id;

-- ── C. Un-author the rows an unattended sweep attributed to a COMPANY ────────────────────
-- Only rows whose `created_by` is itself a companies.id are touched: that value can only have
-- come from the defect, so a genuine human actor is untouchable by this statement.

update management_cases mc
   set created_by = null
 where mc.created_by is not null
   and exists (select 1 from companies c where c.id = mc.created_by);

update tasks t
   set created_by = null
 where t.created_by is not null
   and exists (select 1 from companies c where c.id = t.created_by);

commit;
