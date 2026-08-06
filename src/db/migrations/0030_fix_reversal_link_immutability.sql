-- 0030_fix_reversal_link_immutability.sql
-- WP2 bugfix (found by live DB verification): `reverse_journal` (0016) posts a mirror
-- entry and then sets `reversal_of_journal_id` on that NEW (posted) reversing entry to
-- link it back to the original. The immutability trigger from 0002 only permitted a
-- status→reversed change on a posted journal, so it blocked this link and REVERSALS
-- FAILED entirely ("Posted journal is immutable (attempted mutation)").
--
-- This relaxes the guard to ALSO permit a one-time set of `reversal_of_journal_id`
-- (null → value) on a posted journal, with amounts / currency / date / status all
-- unchanged. That is metadata linking a reversing entry to its original — never an
-- edit of posted amounts. Everything else stays immutable.
-- FORWARD-ONLY, IDEMPOTENT (create or replace).

create or replace function public.block_posted_mutation()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'DELETE') then
    if old.status = 'posted' then
      raise exception 'Posted journal % is immutable and cannot be deleted', old.id;
    end if;
    return old;
  end if;

  if old.status = 'posted' then
    -- Permitted #1: mark the original as reversed (amounts unchanged).
    if new.status = 'reversed'
       and new.total_debit = old.total_debit
       and new.total_credit = old.total_credit
       and new.currency = old.currency
       and new.posting_date = old.posting_date then
      return new;
    end if;
    -- Permitted #2: link a reversing entry to its original (set once), nothing else.
    if new.status = old.status
       and old.reversal_of_journal_id is null
       and new.reversal_of_journal_id is not null
       and new.total_debit = old.total_debit
       and new.total_credit = old.total_credit
       and new.currency = old.currency
       and new.posting_date = old.posting_date then
      return new;
    end if;
    raise exception 'Posted journal % is immutable (attempted mutation)', old.id;
  end if;

  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end;
$$;
