-- Rollback for migration 0111 (promoted from R1_DRAFT_001).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
drop trigger if exists management_items_touch on management_items;
drop table if exists management_items;
-- r1_draft_touch_updated_at is shared with observation_sources (unit 005); by the time this
-- unit rolls back, 005 has already gone (rollback runs in reverse order), so it is safe.
drop function if exists r1_draft_touch_updated_at();
