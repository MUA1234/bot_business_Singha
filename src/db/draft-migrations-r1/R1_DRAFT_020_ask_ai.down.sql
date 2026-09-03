-- ⛔ R1/R2D DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- Reverts R2D_DRAFT_020. Children first, then parents, then the helper functions.

drop function if exists r1_draft_ask_ai_purge_expired();

do $$
declare t text;
begin
  foreach t in array array['ask_ai_threads','ask_ai_turns','ask_ai_citations',
                           'ask_ai_suggested_actions','ask_ai_safety_events'] loop
    if to_regclass('public.'||t) is not null then
      execute format('drop trigger if exists %I on %I', t||'_guard_write', t);
    end if;
  end loop;
end
$$;

drop function if exists r1_draft_guard_ask_ai_write();

drop table if exists ask_ai_suggested_actions;
drop table if exists ask_ai_citations;
drop table if exists ask_ai_turns;
drop table if exists ask_ai_safety_events;
drop table if exists ask_ai_threads;

drop function if exists r1_draft_ask_ai_expiry();
drop function if exists r1_draft_ask_ai_retention_days();
