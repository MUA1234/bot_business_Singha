-- 0051_wp14_canonical_json_fingerprint.sql
-- Correction brief 0048 — WP14: replace delimiter-joined fingerprints with a versioned
-- canonical JSON representation.
--
-- Problem: `_fp_lines()` (0044) concatenates account_code, debit, credit and description with
-- ',' and ';' delimiters WITHOUT escaping. A description or memo containing a delimiter can make
-- two DISTINCT payloads serialise to the SAME canonical string, so distinct journals collide to
-- one idempotency fingerprint (silent wrong-reuse).
--
-- Fix: build a versioned canonical JSONB object and hash its canonical text with SHA-256. JSON
-- string values are unambiguously quoted/escaped, so no field can bleed into another. Each line
-- is a JSON object (never delimiter-joined). Line order is documented INSIGNIFICANT: the
-- normalized line objects are sorted deterministically before aggregation. The new fingerprint
-- is prefixed `v3:`.
--
-- Compatibility (does NOT reinterpret stored fingerprints):
--   * a stored `v3:` fingerprint is compared to the new v3 canonical fingerprint;
--   * a stored `v2:` fingerprint is compared using the ORIGINAL v2 algorithm (`_fp_full`) and is
--     left in place — a set fingerprint is never replaced (WP13 immutability);
--   * a legacy NULL fingerprint is reconstructed (`_fp_recon`) and, on a match, upgraded once to
--     the new v3 fingerprint (the NULL->non-NULL transition WP13 permits).
-- `_fp_full` (v2) and `_fp_recon` are retained for the compatibility comparisons.
-- pgcrypto stays reachable via `search_path = public, extensions` (Supabase).
--
-- Forward-only; CREATE OR REPLACE of two new helpers + `_journal_post_internal`. No data change.

-- Canonical, order-independent JSONB array of normalized line objects.
create or replace function public._fp_lines_v3(p_lines jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(obj order by obj::text), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'account_code', l->>'account_code',
      'debit',  round(coalesce((l->>'debit')::numeric, 0), 2)::text,
      'credit', round(coalesce((l->>'credit')::numeric, 0), 2)::text,
      'description', coalesce(l->>'description', '')
    ) as obj
    from jsonb_array_elements(p_lines) l
  ) s;
$$;

-- Versioned canonical fingerprint over a JSONB object (collision-safe; 'v3:' prefix).
create or replace function public._fp_full_v3(
  p_operation text, p_company uuid, p_source_type text, p_source_id uuid,
  p_date date, p_currency text, p_memo text, p_lines jsonb
) returns text language sql immutable set search_path = public, extensions as $$  -- 'extensions' for pgcrypto digest() on Supabase
  select 'v3:' || encode(digest(
    jsonb_build_object(
      'v', 3,
      'operation',   coalesce(p_operation, ''),
      'company',     p_company::text,
      'source_type', coalesce(p_source_type, ''),
      'source_id',   coalesce(p_source_id::text, ''),
      'date',        p_date::text,
      'currency',    upper(coalesce(p_currency, '')),
      'memo',        coalesce(btrim(p_memo), ''),
      'lines',       public._fp_lines_v3(p_lines)
    )::text,
    'sha256'), 'hex');
$$;

-- Poster: compute the v3 fingerprint and apply version-aware reuse comparison.
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

  v_new_fp := public._fp_full_v3(p_operation, p_company, p_source_type, p_source_id, p_date, p_currency, p_memo, p_lines);

  if p_idempotency_key is not null then
    select id, idem_fingerprint into v_existing, v_existing_fp
    from journal_entries where company_id = p_company and idempotency_key = p_idempotency_key for update;
    if v_existing is not null then
      if v_existing_fp is null then
        -- Legacy row: reconstruct + compare, then upgrade NULL -> v3 (allowed once).
        select posting_date, currency, memo into v_old_date, v_old_ccy, v_old_memo from journal_entries where id = v_existing;
        select jsonb_agg(jsonb_build_object('account_code',account_code,'debit',debit,'credit',credit,'description',description) order by line_no)
          into v_old_lines from journal_lines where journal_id = v_existing;
        if public._fp_recon(v_old_date, v_old_ccy, v_old_memo, v_old_lines) is distinct from public._fp_recon(p_date, p_currency, p_memo, p_lines) then
          raise exception 'idempotency key reused with a different operation (legacy conflict)';
        end if;
        update journal_entries set idem_fingerprint = v_new_fp where id = v_existing;
        return v_existing;
      elsif left(v_existing_fp, 3) = 'v2:' then
        -- Stored under the v2 algorithm: compare with v2; never reinterpret or replace it.
        if v_existing_fp <> public._fp_full(p_operation, p_company, p_source_type, p_source_id, p_date, p_currency, p_memo, p_lines) then
          raise exception 'idempotency key reused with a different operation (conflict)';
        end if;
        return v_existing;
      else
        -- v3 canonical: exact match or conflict.
        if v_existing_fp <> v_new_fp then raise exception 'idempotency key reused with a different operation (conflict)'; end if;
        return v_existing;
      end if;
    end if;
  end if;

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
        if v_existing_fp is not null then
          if left(v_existing_fp,3) = 'v2:' then
            if v_existing_fp <> public._fp_full(p_operation, p_company, p_source_type, p_source_id, p_date, p_currency, p_memo, p_lines) then raise exception 'idempotency key reused with a different operation (conflict)'; end if;
          elsif v_existing_fp <> v_new_fp then
            raise exception 'idempotency key reused with a different operation (conflict)';
          end if;
        end if;
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

  update journal_entries set status = 'posted' where id = v_journal_id;

  insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload, idempotency_key)
  values (p_company, coalesce(p_actor_type,'user'), p_actor, 'journal.posted', 'journal', v_journal_id,
          jsonb_build_object('total', round(v_total_debit,2), 'memo', p_memo, 'operation', p_operation), p_idempotency_key);
  return v_journal_id;
end $function$;
