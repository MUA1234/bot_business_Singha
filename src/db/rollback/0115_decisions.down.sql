-- Rollback for migration 0114 (promoted from R1_DRAFT_004).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
drop trigger if exists management_item_decisions_guard on management_item_decisions;
drop trigger if exists management_item_decisions_no_update on management_item_decisions;
drop table if exists management_item_decisions;
drop function if exists r1_draft_decision_guard();
drop function if exists r1_draft_decisions_append_only();
