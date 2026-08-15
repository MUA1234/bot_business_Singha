-- 0050_wp13_posted_journal_immutability.sql
-- Correction brief 0048 — WP13: harden posted-journal immutability with an allowlist-based
-- WHOLE-ROW comparison, and make posted journal LINES immutable against INSERT as well as
-- UPDATE/DELETE.
--
-- Problem 1 (header): `block_posted_mutation()` (0044) compared only a SUBSET of columns for
-- its allowed transitions, so a privileged/definer path could change unrelated posted fields
-- (period_id, exchange_rate, source_event_id, approval_request_id, correlation_id,
-- idempotency_key, posted_at, created_by, …) while satisfying the subset check.
--
-- Problem 2 (lines): the posted-lines guard only fired on UPDATE/DELETE, so a service-role
-- caller could INSERT an extra line into an already-posted journal (unbalancing it).
--
-- Fix 1: each allowed header transition names EXACTLY the column(s) it may change; every other
-- column must be identical (whole-row JSONB comparison with only the approved keys removed).
-- Fix 2: the line guard now also fires on INSERT and rejects any line write whose parent
-- journal is posted. Because the poster previously inserted the journal already 'posted' and
-- then added its lines, `_journal_post_internal` is restructured to insert the journal as
-- 'draft', insert its lines (parent not yet posted → allowed), then flip it to 'posted' (a
-- normal draft→posted update). Net posting behaviour is unchanged except a posted journal's
-- `version` is 2 (the draft→posted bump); no code or test depends on that value.
--
-- Forward-only; CREATE OR REPLACE of three functions + one trigger re-bind. No data change.

-- ── Fix 1: allowlist whole-row header immutability ───────────────────────────────────────
create or replace function public.block_posted_mutation()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'DELETE') then
    if old.status = 'posted' then
      raise exception 'Posted journal % is immutable and cannot be deleted', old.id;
    end if;
    return old;
  end if;

  if old.status is distinct from 'posted' then
    new.updated_at := now();
    new.version := old.version + 1;
    return new;
  end if;

  -- A) Reverse the original: status posted -> reversed; every other column identical.
  if new.status = 'reversed'
     and (to_jsonb(new) - '{status}'::text[]) = (to_jsonb(old) - '{status}'::text[]) then
    return new;
  end if;

  -- B) Link a reversing entry: reversal_of_journal_id NULL -> non-NULL (once); else identical.
  if old.reversal_of_journal_id is null and new.reversal_of_journal_id is not null
     and (to_jsonb(new) - '{reversal_of_journal_id}'::text[]) = (to_jsonb(old) - '{reversal_of_journal_id}'::text[]) then
    return new;
  end if;

  -- C) One-time legacy idempotency-fingerprint upgrade: idem_fingerprint NULL -> non-NULL;
  --    else identical. A fingerprint already set can never be replaced.
  if old.idem_fingerprint is null and new.idem_fingerprint is not null
     and (to_jsonb(new) - '{idem_fingerprint}'::text[]) = (to_jsonb(old) - '{idem_fingerprint}'::text[]) then
    return new;
  end if;

  raise exception 'Posted journal % is immutable (attempted mutation)', old.id;
end;
$$;

-- ── Fix 2a: line guard now also blocks INSERT into a posted journal ──────────────────────
create or replace function public.block_posted_line_mutation()
returns trigger language plpgsql as $$
declare parent_status text;
begin
  select status into parent_status from journal_entries
    where id = coalesce(new.journal_id, old.journal_id);
  if parent_status = 'posted' then
    raise exception 'Lines of a posted journal are immutable';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_block_posted_line_mutation on journal_lines;
create trigger trg_block_posted_line_mutation
  before insert or update or delete on journal_lines
  for each row execute function public.block_posted_line_mutation();

-- ── Fix 2b: poster inserts lines while 'draft', then flips to 'posted' ───────────────────
create or replace function public._journal_post_internal(p_company uuid, p_date date, p_currency text, p_memo text, p_actor uuid, p_actor_type text, p_lines jsonb, p_idempotency_key text, p_operation text, p_source_type text, p_source_id uuid)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_total_debit numeric := 0; v_total_credit numeric := 0; v_line jsonb; v_journal_id uuid;
  v_existing uuid; v_existing_fp text; v_new_fp text; v_period_id uuid; v_period_status text;
  v_line_no int := 0; v_debit numeric; v_credit numeric; v_code text;
  v_old_date date; v_old_ccy text; v_old_memo text; v_old_lines jsonb;
begin
  if p_lines is null or jsonb_array_length(p_lines) < 2 then raise exception 'A journal needs at least two lines'; end if;

  select id, status into v_period_id, v_period_status
  from accounting_periods where company_id = p_company and p_date between start_date and end_date
  order by start_date desc limit 1;
  if v_period_status is not null and v_period_status in ('closed','locked') then
    raise exception 'Accounting period is % for %', v_period_status, p_date;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_code := v_line->>'account_code';
    v_debit := round(coalesce((v_line->>'debit')::numeric, 0), 2);
    v_credit := round(coalesce((v_line->>'credit')::numeric, 0), 2);
    if v_debit < 0 or v_credit < 0 then raise exception 'Line has a negative amount'; end if;
    if v_debit > 0 and v_credit > 0 then raise exception 'Line % has both a debit and a credit', v_code; end if;
    if not exists (select 1 from chart_of_accounts where company_id = p_company and code = v_code and is_active) then
      raise exception 'Account % not found or inactive in this company', v_code;
    end if;
    v_total_debit := v_total_debit + v_debit; v_total_credit := v_total_credit + v_credit;
  end loop;
  if round(v_total_debit,2) <> round(v_total_credit,2) then raise exception 'Journal is unbalanced: debit % <> credit %', v_total_debit, v_total_credit; end if;
  if round(v_total_debit,2) = 0 then raise exception 'A zero-value journal is not allowed'; end if;

  v_new_fp := public._fp_full(p_operation, p_company, p_source_type, p_source_id, p_date, p_currency, p_memo, p_lines);

  if p_idempotency_key is not null then
    select id, idem_fingerprint into v_existing, v_existing_fp
    from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key for update;
    if v_existing is not null then
      if v_existing_fp is not null then
        if v_existing_fp <> v_new_fp then raise exception 'idempotency key reused with a different operation (conflict)'; end if;
        return v_existing;
      else
        select posting_date, currency, memo into v_old_date, v_old_ccy, v_old_memo from journal_entries where id = v_existing;
        select jsonb_agg(jsonb_build_object('account_code',account_code,'debit',debit,'credit',credit,'description',description) order by line_no)
          into v_old_lines from journal_lines where journal_id = v_existing;
        if public._fp_recon(v_old_date, v_old_ccy, v_old_memo, v_old_lines) is distinct from public._fp_recon(p_date, p_currency, p_memo, p_lines) then
          raise exception 'idempotency key reused with a different operation (legacy conflict)';
        end if;
        update journal_entries set idem_fingerprint = v_new_fp where id = v_existing;
        return v_existing;
      end if;
    end if;
  end if;

  -- Insert as DRAFT so the lines can be added (the posted-line guard blocks writes once posted).
  begin
    insert into journal_entries (
      company_id, period_id, posting_date, currency, exchange_rate, memo, status,
      correlation_id, idempotency_key, payload_hash, idem_fingerprint, total_debit, total_credit, posted_at, posted_by, created_by
    ) values (
      p_company, v_period_id, p_date, p_currency, 1, p_memo, 'draft',
      'corr_' || gen_random_uuid(), coalesce(p_idempotency_key, 'jm_' || gen_random_uuid()), md5(p_lines::text), v_new_fp,
      round(v_total_debit,2), round(v_total_credit,2), now(), p_actor, p_actor
    ) returning id into v_journal_id;
  exception when unique_violation then
    if p_idempotency_key is not null then
      select id, idem_fingerprint into v_journal_id, v_existing_fp
      from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key;
      if v_journal_id is not null then
        if v_existing_fp is not null and v_existing_fp <> v_new_fp then raise exception 'idempotency key reused with a different operation (conflict)'; end if;
        return v_journal_id;
      end if;
    end if;
    raise;
  end;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_line_no := v_line_no + 1;
    insert into journal_lines (journal_id, company_id, account_code, debit, credit, description, line_no)
    values (v_journal_id, p_company, v_line->>'account_code',
      round(coalesce((v_line->>'debit')::numeric,0),2), round(coalesce((v_line->>'credit')::numeric,0),2),
      v_line->>'description', v_line_no);
  end loop;

  -- Flip to posted now that all lines are in place (normal draft->posted update).
  update journal_entries set status = 'posted' where id = v_journal_id;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, coalesce(p_actor_type,'user'), p_actor, 'journal.posted', 'journal', v_journal_id,
          jsonb_build_object('total', round(v_total_debit,2), 'memo', p_memo, 'operation', p_operation), p_idempotency_key);
  return v_journal_id;
end $function$;
