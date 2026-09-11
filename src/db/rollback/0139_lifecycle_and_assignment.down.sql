-- Rollback for migration 0138 (promoted from R1_DRAFT_028).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
-- Reverse of R1_DRAFT_028.

drop function if exists public.r1_draft_assign_management_item(uuid, uuid, text, text, text, text, text);

drop trigger if exists mia_no_update on management_item_assignments;
drop function if exists r1_draft_assignments_append_only();
drop index if exists mia_idem_uq;
drop index if exists mia_item_idx;
drop table if exists management_item_assignments;

-- `r1_draft_transition_item` is left as 028 defined it. Draft 010 would have to be re-applied to
-- restore its map, and a down that half-restores a function is worse than one that says so.
