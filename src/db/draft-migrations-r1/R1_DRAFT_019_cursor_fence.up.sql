-- ⛔ R1/R2S-P DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
-- Owner decision R1-D-1: no production migration number until PR-F-001 and PR-F-004 close.
--
-- R2S-P_DRAFT_019 — the reconciliation generation's FENCE.
--
-- WHY. A reconciliation sweep with no upper boundary never finishes while rows keep arriving:
-- each page advances the position, new rows land ahead of it, and the generation is extended for
-- as long as the company keeps working. A completion bound of ceil(N / page) then describes
-- nothing, because N is not a fixed number.
--
-- The fence is the instant the generation began. Every page of that generation reads only rows
-- created at or before it; everything newer is the NEXT generation's work. N becomes definite,
-- the generation wraps, and the bound means something.
--
-- WHAT IT IS. A timestamp — position, exactly like `updatedAt` and `id`. It carries no customer
-- content, no financial value, no employee data, no evidence and no secret, which is why it may
-- join the allowlist at all. The 512-character payload bound is unchanged.

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
    -- 'fence' added by R2S-P_DRAFT_019: the reconciliation generation's upper boundary.
    if v_key not in ('kind', 'updatedAt', 'id', 'key', 'fence') then
      raise exception
        'cursor state holds POSITION only; "%" is not a position field. Customer content, financial values, employee data, evidence bodies and secrets may never be stored here.', v_key
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  -- The fence is a POSITION, so it must be a timestamp and nothing else. A guard that accepted
  -- any string here would have re-opened the very smuggling channel the allowlist exists to
  -- close — a free-text field under a position-sounding name.
  if new.cursor ? 'fence' then
    if jsonb_typeof(new.cursor -> 'fence') <> 'string' then
      raise exception 'a cursor fence must be a timestamp string, not %',
        jsonb_typeof(new.cursor -> 'fence')
        using errcode = 'check_violation';
    end if;
    begin
      perform (new.cursor ->> 'fence')::timestamptz;
    exception when others then
      raise exception 'a cursor fence must be a readable timestamp'
        using errcode = 'check_violation';
    end;
  end if;

  if char_length(new.cursor::text) > 512 then
    raise exception 'a cursor payload may not exceed 512 characters (got %)', char_length(new.cursor::text)
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;
