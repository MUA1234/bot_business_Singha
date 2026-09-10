-- R1 DRAFT ROLLBACK - NOT FOR HOSTED APPLICATION.
drop trigger if exists management_items_require_evidence on management_items;
drop trigger if exists management_item_evidence_company on management_item_evidence;
drop trigger if exists management_item_evidence_no_update on management_item_evidence;
drop table if exists management_item_evidence;
drop function if exists r1_draft_require_evidence();
drop function if exists r1_draft_evidence_company_guard();
drop function if exists r1_draft_evidence_append_only();
