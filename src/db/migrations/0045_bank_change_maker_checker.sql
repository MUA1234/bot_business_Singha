-- 0045_bank_change_maker_checker.sql
-- Correction phase — WP6. Supplier bank-detail changes become genuine maker-checker:
--   * Direct authenticated INSERT/UPDATE/DELETE of supplier_bank_detail_changes is
--     IMPOSSIBLE — the rows are written only by the two SECURITY DEFINER RPCs below.
--   * request RPC: captures the supplier's current values and creates an immutable
--     pending request (capability finance.bank_details.request).
--   * decision RPC: locks the request + supplier, checks pending lifecycle, checks
--     finance.bank_details.approve, enforces maker <> checker, applies the supplier
--     update (on approve) and writes the audit — all in one transaction.
--   * Audit never contains account numbers (WP6.5).
-- FORWARD-ONLY, IDEMPOTENT.

-- ── RLS: RPC-only. Remove any direct write policy; revoke DML from authenticated. ──
do $$
begin
  alter table supplier_bank_detail_changes enable row level security;
  drop policy if exists supplier_bank_detail_changes_cap_ins on supplier_bank_detail_changes;
  drop policy if exists supplier_bank_detail_changes_cap_upd on supplier_bank_detail_changes;
  drop policy if exists supplier_bank_detail_changes_cap_del on supplier_bank_detail_changes;
  drop policy if exists supplier_bank_detail_changes_w_ins on supplier_bank_detail_changes;
  drop policy if exists supplier_bank_detail_changes_w_upd on supplier_bank_detail_changes;
  drop policy if exists supplier_bank_detail_changes_w_del on supplier_bank_detail_changes;
  drop policy if exists supplier_bank_detail_changes_read on supplier_bank_detail_changes;
  create policy supplier_bank_detail_changes_read on supplier_bank_detail_changes for select using (public.has_company_access(company_id));
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke insert, update, delete on supplier_bank_detail_changes from authenticated;
  end if;
end $$;

-- ── Maker: request a bank-detail change (immutable pending record) ────────────
create or replace function public.request_supplier_bank_change(
  p_company uuid, p_supplier uuid, p_new_name text, p_new_number text, p_by uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text; v_old_name text; v_old_number text; v_id uuid;
begin
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type = 'user' and not public.has_capability(p_company, 'finance.bank_details.request') then
    raise exception 'missing capability finance.bank_details.request';
  end if;
  if coalesce(btrim(p_new_name),'') = '' and coalesce(btrim(p_new_number),'') = '' then
    raise exception 'a bank change must set a new name or number';
  end if;
  select bank_account_name, bank_account_number into v_old_name, v_old_number
  from suppliers where id = p_supplier and company_id = p_company for update;
  if not found then raise exception 'Supplier not found'; end if;

  insert into supplier_bank_detail_changes (
    company_id, supplier_id, old_account_name, old_account_number, new_account_name, new_account_number, requested_by, status
  ) values (
    p_company, p_supplier, v_old_name, v_old_number,
    coalesce(nullif(btrim(p_new_name),''), v_old_name), coalesce(nullif(btrim(p_new_number),''), v_old_number),
    v_actor, 'pending'
  ) returning id into v_id;

  -- Audit WITHOUT account numbers (sensitive).
  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, v_type, v_actor, 'supplier_bank_change.requested', 'supplier', p_supplier, jsonb_build_object('change_id', v_id));
  return v_id;
end $$;

-- ── Checker: decide (approve/reject) a pending change ─────────────────────────
create or replace function public.decide_supplier_bank_change(
  p_company uuid, p_change uuid, p_decision text, p_by uuid, p_note text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_type text; v_supplier uuid; v_status text; v_requested_by uuid; v_new_name text; v_new_number text;
begin
  if p_decision not in ('approved','rejected') then raise exception 'decision must be approved or rejected'; end if;
  select a.v_actor, a.v_type into v_actor, v_type from public._resolve_actor(p_by) a;
  if v_type = 'user' and not public.has_capability(p_company, 'finance.bank_details.approve') then
    raise exception 'missing capability finance.bank_details.approve';
  end if;

  select supplier_id, status, requested_by, new_account_name, new_account_number
    into v_supplier, v_status, v_requested_by, v_new_name, v_new_number
  from supplier_bank_detail_changes where id = p_change and company_id = p_company for update;
  if not found then raise exception 'Bank change not found'; end if;
  if v_status <> 'pending' then raise exception 'Bank change is not pending (is %)', v_status; end if;
  if v_requested_by = v_actor then raise exception 'the requester cannot approve their own bank change (separation of duties)'; end if;

  -- Lock the supplier so a concurrent approval serialises.
  perform 1 from suppliers where id = v_supplier and company_id = p_company for update;

  if p_decision = 'approved' then
    update suppliers set bank_account_name = v_new_name, bank_account_number = v_new_number where id = v_supplier and company_id = p_company;
  end if;
  update supplier_bank_detail_changes
    set status = p_decision, approved_by = v_actor, decided_at = now(), note = p_note
  where id = p_change and company_id = p_company;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
  values (p_company, v_type, v_actor, 'supplier_bank_change.' || p_decision, 'supplier', v_supplier, jsonb_build_object('change_id', p_change));
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.request_supplier_bank_change(uuid,uuid,text,text,uuid) from public;
    revoke all on function public.decide_supplier_bank_change(uuid,uuid,text,uuid,text) from public;
    grant execute on function public.request_supplier_bank_change(uuid,uuid,text,text,uuid) to authenticated, service_role;
    grant execute on function public.decide_supplier_bank_change(uuid,uuid,text,uuid,text) to authenticated, service_role;
  end if;
end $$;
