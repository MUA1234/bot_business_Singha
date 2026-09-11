-- Rollback for migration 0112 (promoted from R1_DRAFT_002).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
drop function if exists r1_draft_transition_item(uuid, text, text, uuid, text, text, jsonb);
drop trigger if exists management_item_transitions_no_update on management_item_transitions;
drop table if exists management_item_transitions;
drop function if exists r1_draft_transitions_append_only();
