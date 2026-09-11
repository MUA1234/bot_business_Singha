-- Rollback for migration 0116 (promoted from R1_DRAFT_006).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
drop trigger if exists management_item_feedback_no_update on management_item_feedback;
drop table if exists management_item_feedback;
drop function if exists r1_draft_feedback_append_only();
