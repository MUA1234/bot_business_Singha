-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- R1_DRAFT_029 — the PostgREST execution transport (R2F-F-019).
--
-- ── Why this is a DRAFT unit and not a released migration ────────────────────────────────
--
-- Every table this transport touches — management_items, management_item_evidence,
-- management_item_decisions, management_item_recommendations, management_execution_attempts,
-- management_execution_enablement — is created by the QUARANTINED draft chain, not by the
-- released sequence. The hosted probe of 2026-09-11 confirmed none of them exists on
-- production. A released migration referencing them would fail on the one database it exists
-- to serve. The transport belongs in the same quarantine as the schema it addresses, and
-- promoting the chain to production numbers stays the separate decision it already was
-- (owner decision R1-D-1).
--
-- ── What was missing, and why a generic SQL executor was not the answer ──────────────────
--
-- `executeManagementAction` reaches its ledger and its four loaders through `SqlExec` — a raw
-- SQL executor. The request path speaks PostgREST, which cannot run arbitrary SQL, so
-- `makeCycleDeps` supplied no transport at all: the orchestrator recorded an "execution
-- transport unavailable" hold and marked the cycle partial. The loop's one authorised effect
-- was unreachable from the deployed graph.
--
-- The obvious fix — expose something that runs SQL text — would be a remote code execution
-- primitive wearing a function signature. NOTHING here accepts SQL text. Each function takes
-- explicitly typed arguments and issues fixed statements.
--
-- ── The identity rule that shapes every signature below ─────────────────────────────────
--
-- No function takes a company, membership, actor, authority level or entitlement FROM THE
-- CALLER as something to be trusted. A company id is an argument because a query needs a
-- subject, but every function RE-READS the row's own company_id and compares, so a caller who
-- passes company A's id and item B's id gets nothing rather than B's data attributed to A.
-- Authority is never an argument at all: it is derived inside the transaction from stored
-- decisions and stored role grants.
--
-- ── Grants ──────────────────────────────────────────────────────────────────────────────
--
-- SECURITY DEFINER, `search_path` pinned to the repository's canonical value with pg_temp
-- LAST, EXECUTE revoked from PUBLIC/anon/authenticated and granted only to service_role, and
-- every function additionally gates on `caller_jwt_role() = 'service_role'` so a role change
-- alone is not enough. Both, because either one alone has been insufficient before.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 0. Shared: the evidence digest
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- A COUNT cannot serve. Three overdue invoices replaced by three unrelated ones is still
-- three, and the whole point of the freshness check is to notice exactly that substitution.
-- The digest is over the ordered (source_table, source_id) pairs.

create or replace function public.r1_exec_evidence_digest(p_company uuid, p_item uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
  select coalesce(
           md5(string_agg(source_table || ':' || source_id, '|'
                          order by source_table, source_id)),
           'empty')
    from public.management_item_evidence
   where company_id = p_company and item_id = p_item;
$$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 1. Loader — company execution enablement
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- The SEPARATE switch. Deliberately not a join with `management_kernel_enablement`: a company
-- may be observed without being acted upon, and one query returning both would make it easy to
-- read the wrong one. Absent row ⇒ false, never "unknown, assume yes".

create or replace function public.r1_exec_company_enabled(p_company uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare v_on boolean;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'r1_exec_company_enabled is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  select enabled into v_on
    from public.management_execution_enablement
   where company_id = p_company;
  return coalesce(v_on, false);
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 2. Loader — the item snapshot, with its plan
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- `proposed_action_id` (draft 009), NOT `proposed_action` (draft 001). Both columns exist; only
-- this one is ever written. Reading the wrong one made every real item look actionless and
-- refuse `stale_state`, while a test seeding the same wrong column passed (R2E-F-010).
--
-- ── Why the parameter digest is NOT computed here ───────────────────────────────────────
--
-- `loadPlan` in service.ts re-derives it with `canonicalHash` — sha256 over a canonical JSON
-- rendering with JSON.stringify's exact escaping, number formatting and key ordering. A SQL
-- reimplementation of that would be a second definition of the same value, and the two would
-- agree only for as long as nobody touched either. The first version of this file tried it and
-- the two disagreed immediately (md5 against sha256), which the parity suite caught as every
-- real item refusing `parameters_stale`.
--
-- So this returns the raw `planned_parameters` and the stored column, and the TRANSPORT calls
-- the SAME `digestOfPlannedParameters` the SQL loader calls. One definition, two callers.
--
-- The stored column is still never the trust anchor: the transport applies the same rule
-- `loadPlan` applies — a column that disagrees with the parameters it describes yields
-- `plan-inconsistent`, which matches nothing and authorises nothing.

create or replace function public.r1_exec_load_item(p_company uuid, p_item uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_item   record;
  v_plan   record;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'r1_exec_load_item is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  select i.id, i.company_id, i.state, i.proposed_action_id,
         (select count(*)::int from public.management_item_evidence e where e.item_id = i.id) as evidence_count
    into v_item
    from public.management_items i
   where i.company_id = p_company and i.id = p_item;

  if not found then return null; end if;
  -- Re-read, never assumed from the filter.
  if v_item.company_id is distinct from p_company then return null; end if;

  select r.id, r.condition_evidence_digest, r.action_id, r.planned_parameters,
         r.parameter_digest, r.policy_version
    into v_plan
    from public.management_item_recommendations r
   where r.company_id = p_company and r.item_id = p_item
     and r.condition_evidence_digest is not null
   order by r.created_at desc
   limit 1;

  return jsonb_build_object(
    'companyId',         v_item.company_id,
    'state',             v_item.state,
    'actionId',          coalesce(v_item.proposed_action_id, ''),
    'evidenceCount',     v_item.evidence_count,
    'evidenceGeneration', public.r1_exec_evidence_digest(p_company, p_item),
    'plan', case when v_plan.id is null then null else jsonb_build_object(
      'conditionEvidenceDigest', v_plan.condition_evidence_digest,
      'actionId',                coalesce(v_plan.action_id, ''),
      -- The raw parameters and the stored column. The transport derives the digest.
      'plannedParameters',       v_plan.planned_parameters,
      'storedParameterDigest',   nullif(v_plan.parameter_digest, ''),
      'policyVersion',           coalesce(v_plan.policy_version, ''),
      'version',                 v_plan.id::text
    ) end
  );
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 3. Loader — the approval snapshot
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- Superseded by ANY later decision, not merely by a later approval: a rejection or an edit
-- after the approval replaces it just as surely.

create or replace function public.r1_exec_load_approval(p_company uuid, p_item uuid, p_action text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_dec  record;
  v_later int;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'r1_exec_load_approval is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  select d.id, d.company_id, d.actor_id, d.decision, d.authority_level, d.created_at
    into v_dec
    from public.management_item_decisions d
   where d.company_id = p_company and d.item_id = p_item and d.decision = 'approve'
   order by d.created_at desc
   limit 1;

  if not found then return null; end if;
  if v_dec.company_id is distinct from p_company then return null; end if;

  select count(*)::int into v_later
    from public.management_item_decisions d
   where d.company_id = p_company and d.item_id = p_item and d.created_at > v_dec.created_at;

  return jsonb_build_object(
    'approvedBy',         v_dec.actor_id,
    'actionId',           p_action,
    'authority',          coalesce(v_dec.authority_level, 'owner_approval'),
    'current',            (v_later = 0),
    'decisionVersion',    v_dec.id::text,
    'evidenceGeneration', public.r1_exec_evidence_digest(p_company, p_item),
    'companyId',          v_dec.company_id
  );
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 4. Loader — the approver's capabilities
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- From the SAME sources the rest of the system asks (R2F-F-021). This once read only
-- `user_company_access`, the legacy table, so an approver whose permissions come from
-- `membership_roles` — which is every user the current model creates — was found to hold
-- nothing and a legitimately approved action was refused. The union mirrors `has_capability`'s
-- own two branches: it asks the question the repository already answers, rather than a
-- narrower one that happens to be answerable from an older table.

create or replace function public.r1_exec_approver_capabilities(p_company uuid, p_user uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare v_caps text[];
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'r1_exec_approver_capabilities is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;
  if p_user is null then return array[]::text[]; end if;

  select coalesce(array_agg(distinct k), array[]::text[]) into v_caps
    from (
      select rp.permission_key as k
        from public.memberships m
        join public.membership_roles mr on mr.membership_id = m.id
        join public.role_permissions rp on rp.role_key = mr.role_key
       where m.user_id = p_user and m.company_id = p_company and m.status = 'active'
      union
      select rp.permission_key
        from public.user_company_access uca
        join public.role_permissions rp on rp.role_key = uca.role_key
       where uca.user_id = p_user and uca.company_id = p_company
    ) s;

  return v_caps;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 5. (removed) Canonical JSON
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- This unit once carried `r1_exec_canonical_json`, a SQL reimplementation of the TypeScript
-- canonical JSON rendering, so that a parameter digest could be computed on both sides and
-- compared. It was wrong on first contact — md5 here against sha256 there — and it was the wrong
-- shape besides: two definitions of one value, agreeing only until somebody edits one.
--
-- Nothing computes a parameter digest in SQL any more. `r1_exec_load_item` returns the raw
-- parameters and the transport calls the same `digestOfPlannedParameters` the SQL loader calls,
-- and the execute below compares the executor's token against the row's own stored column, which
-- `mir_no_update` keeps in step with the parameters it describes.
--
-- Recorded rather than silently deleted: the next person to want a canonical JSON function in
-- SQL should know that this was tried.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 6. THE ATOMIC EXECUTE
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- One transaction: validate, claim the idempotency key, create the effect, write the terminal
-- ledger row. All of it or none of it.
--
-- Porting the ledger's five separate operations to PostgREST would have made five round trips
-- with no transaction spanning them, and the failure that produces is the worst one available:
-- a task created for a customer with no ledger row saying it happened, so a retry creates a
-- second. "No partial task if ledger persistence fails" is only achievable in one statement.
--
-- Refusals return a reason and write NOTHING — in particular they do not consume the
-- idempotency key, so a refusal caused by a transient condition can be retried once the
-- condition clears. A consumed key on refusal would turn a recoverable refusal into a
-- permanent one.
--
-- The ONLY effect this function can produce is an UNASSIGNED internal task. There is no
-- assignee parameter, and the insert names no assignee column. Assignment is a manager's act.

-- ── The caller supplies NO parameters ───────────────────────────────────────────────────
--
-- The first version of this function took p_title, p_description and p_requires_evidence. That
-- was a hole with a comment above it saying there was no hole: a caller who could name the title
-- could create a task saying anything, under an approval granted for something else. Reading the
-- plan row here and taking the parameters from IT closes it — and removes the need to reproduce
-- TypeScript's canonical hash in SQL, because the effect and the digest now come from the same
-- row in the same transaction.
--
-- `p_parameter_digest` remains, as an optimistic-concurrency token: the executor says which plan
-- it read, and this refuses if that is no longer the plan. It is compared against the row's
-- STORED column rather than a re-derivation, which is sound here for a reason specific to this
-- table — `mir_no_update` (draft 014) makes `management_item_recommendations` append-only for
-- UPDATE and DELETE, so `planned_parameters` and `parameter_digest` cannot drift apart after the
-- insert that wrote them together.
create or replace function public.r1_exec_create_internal_task(
  p_company          uuid,
  p_item             uuid,
  p_action           text,
  p_idempotency_key  text,
  p_parameter_digest text,
  p_policy_version   text,
  p_condition_digest text,
  p_eligibility_digest text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_item      record;
  v_plan      record;
  v_existing  record;
  v_approver    uuid;
  v_title       text;
  v_description text;
  v_requires    boolean;
  v_task_id   uuid;
  v_ledger_id uuid;
  v_enabled   boolean;
  -- Whatever the task function reports. Not assumed: a key already present in
  -- `management_task_idempotency` with no terminal ledger row is precisely the crashed-attempt
  -- case, and reporting `created` there would claim a second task had been made.
  v_created   boolean;
begin
  -- ── caller ────────────────────────────────────────────────────────────────────────────
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'r1_exec_create_internal_task is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  -- ── The refusal vocabulary ───────────────────────────────────────────────────────────
  --
  -- Every reason string in this function is a member of the TypeScript `RefusalReason` union,
  -- verbatim. It is not a second vocabulary that something maps into the first: a mapping layer
  -- is a place for the two to drift, and the first draft of this file had one — with reasons like
  -- `action_not_executable` and `item_not_found` that the union does not contain — so the
  -- transport cast a string and called it checked. `r2f-postgrest-adversarial.test.ts` (A27)
  -- asserts the recorder's allowlist is exactly the union.
  --
  -- ── the action is matched EXACTLY, never by prefix, case or normalisation ─────────────
  -- A fuzzy match here would be the whole autonomy ceiling, defeated by a lookalike string.
  if p_action is distinct from 'ops.task.create_internal' then
    return jsonb_build_object('ok', false, 'reason', 'action_not_registered');
  end if;

  -- ── the one thing the caller does supply ─────────────────────────────────────────────
  -- The idempotency key is derived server-side by the executor from values the server holds, but
  -- it arrives over the wire, so it is checked here too.
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    return jsonb_build_object('ok', false, 'reason', 'idempotency_key_missing');
  end if;

  -- ── the global kill switch, server-side ──────────────────────────────────────────────
  -- A row in a table nobody's browser can reach. Absent ⇒ disabled.
  if not coalesce((select enabled from public.r1_exec_global_boundary where id = true), false) then
    return jsonb_build_object('ok', false, 'reason', 'global_boundary_disabled');
  end if;

  -- ── company enablement, separate from observation ────────────────────────────────────
  v_enabled := public.r1_exec_company_enabled(p_company);
  if not v_enabled then
    return jsonb_build_object('ok', false, 'reason', 'company_not_enabled');
  end if;

  -- ── the item, locked, and re-checked against the company it claims ───────────────────
  select i.id, i.company_id, i.state, i.proposed_action_id
    into v_item
    from public.management_items i
   where i.id = p_item
   for update;

  -- A missing item, an item belonging to someone else, and an item in a state that does not
  -- admit execution are ONE refusal on purpose: `item_state_invalid`. Distinguishing them would
  -- tell a caller holding a guessed id whether that id exists and who owns it. The executor's
  -- own three branches collapse the same way, for the same reason.
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'item_state_invalid');
  end if;
  -- The caller's company is a filter, not a fact. This is the recheck.
  if v_item.company_id is distinct from p_company then
    return jsonb_build_object('ok', false, 'reason', 'item_state_invalid');
  end if;
  if v_item.state is distinct from 'approved' then
    return jsonb_build_object('ok', false, 'reason', 'item_state_invalid');
  end if;
  if v_item.proposed_action_id is distinct from p_action then
    return jsonb_build_object('ok', false, 'reason', 'stale_state');
  end if;

  -- ── the plan, and every freshness comparison against it ──────────────────────────────
  select r.id, r.condition_evidence_digest, r.action_id, r.planned_parameters,
         r.parameter_digest, r.policy_version
    into v_plan
    from public.management_item_recommendations r
   where r.company_id = p_company and r.item_id = p_item
     and r.condition_evidence_digest is not null
   order by r.created_at desc
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'evidence_stale');
  end if;

  -- CONDITION evidence: has the thing we observed changed since we decided?
  if public.r1_exec_evidence_digest(p_company, p_item) is distinct from p_condition_digest
     or v_plan.condition_evidence_digest is distinct from p_condition_digest then
    return jsonb_build_object('ok', false, 'reason', 'evidence_stale');
  end if;

  -- ELIGIBILITY evidence: a DIFFERENT record set about a different subject (R2F-F-017).
  -- Comparing condition evidence against eligibility evidence is what made every real item
  -- unexecutable, so the two are carried and checked separately, each where it means something.
  if p_eligibility_digest is not null
     and v_plan.id::text is distinct from p_eligibility_digest then
    return jsonb_build_object('ok', false, 'reason', 'stale_state');
  end if;

  -- PARAMETERS: is this still the plan the executor read? The row is append-only, so its stored
  -- digest is the digest OF these parameters, written in the transaction that wrote them.
  if coalesce(v_plan.parameter_digest, '') is distinct from coalesce(p_parameter_digest, '') then
    return jsonb_build_object('ok', false, 'reason', 'parameters_stale');
  end if;

  -- ── server-side validation of the parameters THE PLAN holds ──────────────────────────
  v_title       := v_plan.planned_parameters ->> 'title';
  v_description := v_plan.planned_parameters ->> 'description';
  v_requires    := coalesce((v_plan.planned_parameters ->> 'requiresEvidence')::boolean, false);

  if v_title is null or btrim(v_title) = '' or length(v_title) > 200 then
    return jsonb_build_object('ok', false, 'reason', 'parameters_invalid');
  end if;
  -- The plan may carry nothing this function does not know how to honour. An unknown key is a
  -- plan written for a different action, or by something that should not be writing plans.
  if exists (
    select 1 from jsonb_object_keys(v_plan.planned_parameters) k
     where k not in ('title', 'description', 'requiresEvidence')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'parameters_invalid');
  end if;

  -- POLICY VERSION: a plan approved under one policy may not execute under another.
  if coalesce(v_plan.policy_version, '') is distinct from coalesce(p_policy_version, '') then
    return jsonb_build_object('ok', false, 'reason', 'policy_version_changed');
  end if;

  -- ── idempotency: claim, or return what the first call produced ───────────────────────
  -- Everything below is one transaction with the claim, so a crash anywhere leaves neither a
  -- task nor a ledger row, and a retry is the first call again.
  select a.id, a.status, a.effect_ref
    into v_existing
    from public.management_execution_attempts a
   where a.company_id = p_company and a.idempotency_key = p_idempotency_key
   for update;

  if found then
    -- A completed attempt returns ITS effect. A second task is exactly what must not happen.
    if v_existing.status = 'executed' and v_existing.effect_ref is not null then
      return jsonb_build_object('ok', true, 'taskId', v_existing.effect_ref,
                                'ledgerId', v_existing.id, 'created', false);
    end if;
    -- Some OTHER terminal outcome already exists under this execution identity — a refusal or a
    -- failure written by an earlier attempt. That is not a fresh refusal to be reported as a
    -- reason: it is a prior verdict, and the caller must be handed it rather than being allowed
    -- to start a second attempt under the same identity. `terminal` says so explicitly, so the
    -- transport cannot mistake it for a retryable condition.
    return jsonb_build_object('ok', false, 'terminal', true,
                              'ledgerId', v_existing.id, 'status', v_existing.status);
  end if;

  -- ── the approver: DERIVED for the task, and deliberately ABSENT from the ledger ──────
  --
  -- Two different questions, and the SQL transport answers them differently, so this does too.
  --
  --   * `tasks.created_by` — who caused this work to exist. `executeManagementAction` re-issues
  --     the request naming whoever the latest approve decision names, and the handler passes
  --     that to the task RPC. A person approved the item; the task exists because they did.
  --
  --   * `management_execution_attempts.approved_by` — the approval THIS EXECUTION stood on.
  --     For an action whose policy is `requiresApproval: false` and whose canonical authority
  --     resolves to `automatic`, the executor never loads an approval and records none. It did
  --     not stand on one (R2E-F-009): it ran automatically.
  --
  -- The parity suite found this by disagreeing with it twice — once when this function recorded
  -- the approver in the ledger, and once when it recorded nobody on the task. Both are stated
  -- here so the next reader does not "fix" one of them into agreeing with the other.
  --
  -- No supersession filter, matching `loadApproval`: the executor takes the latest approve row
  -- as it stands. A later decision would have moved the item out of `approved`, which the state
  -- check above already refuses, so the two cannot disagree in practice.
  select d.actor_id
    into v_approver
    from public.management_item_decisions d
   where d.company_id = p_company and d.item_id = p_item and d.decision = 'approve'
   order by d.created_at desc
   limit 1;

  -- ── the effect: an UNASSIGNED internal task, and nothing else ────────────────────────
  --
  -- Through `r1_draft_create_internal_task` — the SAME function the SQL transport's handler
  -- calls, not a bespoke insert alongside it. An earlier draft of this file inserted into
  -- `public.tasks` directly and named a `management_item_id` column that does not exist; PL/pgSQL
  -- does not resolve column names at creation time, so it applied cleanly and would have failed
  -- on first use. Calling the existing function makes the two transports produce the same effect
  -- by construction — same columns, same idempotency table, same unassigned task — rather than by
  -- a promise that two pieces of SQL agree.
  --
  -- There is still no assignee anywhere: that function takes no assignee argument either.
  select t.task_id, t.created into v_task_id, v_created
    from public.r1_draft_create_internal_task(
           p_company, p_idempotency_key, btrim(v_title), v_description,
           v_requires, v_approver) t;

  if v_task_id is null then
    raise exception 'r1_draft_create_internal_task returned no task id'
      using errcode = 'internal_error';
  end if;

  -- ── the terminal ledger result, in the SAME transaction ─────────────────────────────
  insert into public.management_execution_attempts
    (company_id, item_id, action_id, idempotency_key, status, handler,
     approved_by, resolved_authority, effect_ref, completed_at)
  -- `resolved_authority` is the authority the EXECUTOR resolved, which is a pure function of the
  -- action id — `resolveCanonicalAuthority`, six facts about the catalogue entry and the policy,
  -- none of them about this item or this approver. For the one action that reaches here it is
  -- 'automatic', and writing the APPROVAL's level instead would record a different fact under the
  -- same column name than the SQL transport records, which the parity suite would then have to
  -- excuse. The approver is still recorded, in the column that means the approver.
  values (p_company, p_item, p_action, p_idempotency_key, 'executed',
          'ops.task.create_internal.v1', null,
          'automatic', v_task_id::text, now())
  returning id into v_ledger_id;

  return jsonb_build_object('ok', true, 'taskId', v_task_id,
                            'ledgerId', v_ledger_id, 'created', v_created);
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 6b. Recording a refusal
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- The executor records refusals that happen AFTER both boundaries passed, so that a system
-- which refuses everything is distinguishable from one nobody asked. On the SQL transport that
-- is `createSqlLedger.recordRefusal`; PostgREST needs its own, and it is a separate function
-- rather than a mode of the execute above, because the execute produces an effect and this one
-- must be incapable of producing anything.
--
-- ── The idempotency key is NOT consumed ─────────────────────────────────────────────────
--
-- A refusal must never spend the identity the execution would later use, or an action refused
-- today for a missing approval could never run tomorrow once the approval exists. The SQL path
-- appends a unique suffix in TypeScript. Here the suffix is generated INSIDE the function, so
-- the guarantee does not depend on the caller doing it — a caller that passed the bare key
-- still cannot consume it.
--
-- The reason is checked against the same closed set the transport knows. Free text would let a
-- caller write a reason the executor never produces into a ledger read by the learning fold.

create or replace function public.r1_exec_record_refusal(
  p_company         uuid,
  p_item            uuid,
  p_action          text,
  p_idempotency_key text,
  p_reason          text,
  p_detail          text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
declare
  v_company uuid;
  v_id      uuid;
begin
  if public.caller_jwt_role() is distinct from 'service_role' then
    raise exception 'r1_exec_record_refusal is a service-only boundary'
      using errcode = 'insufficient_privilege';
  end if;

  if p_reason is null or p_reason not in (
    'global_boundary_disabled', 'company_not_enabled', 'action_not_registered',
    'action_not_internal_only', 'no_execution_policy', 'classification_prohibited',
    'classification_draft_only', 'no_handler', 'authority_insufficient',
    'authority_failed_closed', 'approval_missing', 'approval_superseded',
    'approver_lacks_capability', 'evidence_missing', 'evidence_stale',
    'item_state_invalid', 'stale_state', 'parameters_invalid',
    'parameters_stale', 'policy_version_changed', 'idempotency_key_missing',
    'ledger_unavailable'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_refusal_reason');
  end if;

  -- The item's OWN company, re-read. A refusal filed against the wrong company would be a
  -- cross-company write, small but real.
  select i.company_id into v_company from public.management_items i where i.id = p_item;
  if found and v_company is distinct from p_company then
    return jsonb_build_object('ok', false, 'reason', 'wrong_company');
  end if;

  insert into public.management_execution_attempts
    (company_id, item_id, action_id, idempotency_key, status, refusal_reason, detail,
     completed_at)
  values (p_company, p_item, p_action,
          coalesce(p_idempotency_key, 'pre-identity') || '#refused#' || gen_random_uuid()::text,
          'refused', p_reason, left(coalesce(p_detail, ''), 500), now())
  returning id into v_id;

  return jsonb_build_object('ok', true, 'ledgerId', v_id);
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 7. The global boundary row
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- A single-row table, `false` by default, that no browser variable and no client can reach:
-- writing it requires the service role, and the RPCs read it inside their own transaction.
-- This is the SERVER-SIDE half of the kill switch. `EXECUTION_ENABLED=on` in the server
-- process is the other half, and BOTH must permit execution. Two halves under two different
-- kinds of control: one is a deployment variable an operator sets, the other is a row only the
-- service role can write. Enabling execution by accident requires making both mistakes.

create table if not exists public.r1_exec_global_boundary (
  id         boolean primary key default true,
  enabled    boolean not null default false,
  note       text,
  updated_at timestamptz not null default now(),
  constraint r1_exec_global_boundary_singleton check (id = true)
);

insert into public.r1_exec_global_boundary (id, enabled, note)
values (true, false, 'default DISABLED — staging may enable this deliberately; production may not')
on conflict (id) do nothing;

alter table public.r1_exec_global_boundary enable row level security;

-- No policy is created, so no non-superuser role can read or write it through RLS. The RPCs
-- above are SECURITY DEFINER and read it as the owner; that is the only intended path.

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 8. Grants — service-only, with PUBLIC/anon/authenticated explicitly revoked
-- ═════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.r1_exec_evidence_digest(uuid,uuid)',
    'public.r1_exec_company_enabled(uuid)',
    'public.r1_exec_load_item(uuid,uuid)',
    'public.r1_exec_load_approval(uuid,uuid,text)',
    'public.r1_exec_approver_capabilities(uuid,uuid)',
    'public.r1_exec_record_refusal(uuid,uuid,text,text,text,text)',
    'public.r1_exec_create_internal_task(uuid,uuid,text,text,text,text,text,text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_sig);
    execute format('grant execute on function %s to service_role', v_sig);
  end loop;
end
$$;

revoke all on public.r1_exec_global_boundary from public, anon, authenticated;
grant select, insert, update on public.r1_exec_global_boundary to service_role;

-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 9. Fail-closed self-verification
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- A migration that silently half-applied its own grants would leave a service-only boundary
-- reachable by anon. Assert it rather than hope.
--
-- ── Why the EXACT set of signatures is asserted, not just the grants ────────────────────
--
-- `create or replace function` replaces a function with the same name AND argument types.
-- Change an argument list and the old function does not go away — it becomes an OVERLOAD, and
-- PostgreSQL resolves a call to whichever signature fits. Reworking this unit's execute during
-- development left exactly that: an 11-argument `r1_exec_create_internal_task` that still
-- accepted a caller-supplied title, sitting beside the 8-argument one that does not. Either
-- would answer a PostgREST call that matched it.
--
-- This repository has met the class before — the eighth external review's signature-exact
-- trusted-owner check exists for the same reason. So the migration DROPS every `r1_exec_%`
-- signature that is not on this list, and then asserts the list is what remains.

do $$
declare
  v_bad text;
  v_expected text[] := array[
    'r1_exec_approver_capabilities(uuid,uuid)',
    'r1_exec_company_enabled(uuid)',
    'r1_exec_create_internal_task(uuid,uuid,text,text,text,text,text,text)',
    'r1_exec_evidence_digest(uuid,uuid)',
    'r1_exec_load_approval(uuid,uuid,text)',
    'r1_exec_load_item(uuid,uuid)',
    'r1_exec_record_refusal(uuid,uuid,text,text,text,text)'
  ];
  v_sig text;
begin
  -- Remove strays FIRST, so a rerun after a signature change is clean rather than ambiguous.
  for v_sig in
    select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'r1_exec_%'
       and replace(p.oid::regprocedure::text, 'public.', '') <> all (v_expected)
  loop
    raise notice 'R1_DRAFT_029: dropping stray overload %', v_sig;
    execute format('drop function %s', v_sig);
  end loop;

  select string_agg(replace(p.oid::regprocedure::text, 'public.', ''), ', ' order by 1)
    into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'r1_exec_%'
     and replace(p.oid::regprocedure::text, 'public.', '') <> all (v_expected);
  if v_bad is not null then
    raise exception 'R1_DRAFT_029 ABORT: unexpected r1_exec_ signatures remain: %', v_bad;
  end if;

  select string_agg(e, ', ')
    into v_bad
    from unnest(v_expected) e
   where to_regprocedure('public.' || e) is null;
  if v_bad is not null then
    raise exception 'R1_DRAFT_029 ABORT: these expected functions do not exist: %', v_bad;
  end if;

  select string_agg(p.proname, ', ')
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'r1_exec_%'
     and (
       has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE')
     );
  if v_bad is not null then
    raise exception 'R1_DRAFT_029 ABORT: these r1_exec_ functions are reachable by anon/authenticated: %', v_bad;
  end if;

  select string_agg(p.proname, ', ')
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'r1_exec_%'
     and p.prosecdef
     and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=pg_catalog, extensions, public, pg_temp%';
  if v_bad is not null then
    raise exception 'R1_DRAFT_029 ABORT: these SECURITY DEFINER functions lack the canonical search_path: %', v_bad;
  end if;

  if coalesce((select enabled from public.r1_exec_global_boundary where id = true), true) then
    raise exception 'R1_DRAFT_029 ABORT: the global execution boundary must default to DISABLED';
  end if;
end
$$;
