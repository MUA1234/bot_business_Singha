-- Rollback for migration 0113 (promoted from R1_DRAFT_003).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
drop trigger if exists management_items_require_evidence on management_items;
drop trigger if exists management_item_evidence_company on management_item_evidence;
drop trigger if exists management_item_evidence_no_update on management_item_evidence;
drop table if exists management_item_evidence;
drop function if exists r1_draft_require_evidence();
drop function if exists r1_draft_evidence_company_guard();
drop function if exists r1_draft_evidence_append_only();
