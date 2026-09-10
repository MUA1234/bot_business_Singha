-- ⛔ R1/R2S-P DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- Reverts R2S-P_DRAFT_019: the cursor payload allowlist returns to the four fields of
-- R2S-P_DRAFT_018, without `fence`.
--
-- NOTE. Any cursor row already carrying a fence keeps it — this restores the GUARD, not the data.
-- The next write of such a row will be refused until its fence is removed, which is the correct
-- direction to fail: a narrower allowlist should reject the wider payload rather than silently
-- accept it.

create or replace function r1_draft_cursor_payload_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_key text;
begin
  if new.cursor is null then return new; end if;

  if jsonb_typeof(new.cursor) <> 'object' then
    raise exception 'a cursor must be a JSON object, not %', jsonb_typeof(new.cursor)
      using errcode = 'check_violation';
  end if;

  for v_key in select k from jsonb_object_keys(new.cursor) as t(k) loop
    if v_key not in ('kind', 'updatedAt', 'id', 'key') then
      raise exception
        'cursor state holds POSITION only; "%" is not a position field. Customer content, financial values, employee data, evidence bodies and secrets may never be stored here.', v_key
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  if char_length(new.cursor::text) > 512 then
    raise exception 'a cursor payload may not exceed 512 characters (got %)', char_length(new.cursor::text)
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;
