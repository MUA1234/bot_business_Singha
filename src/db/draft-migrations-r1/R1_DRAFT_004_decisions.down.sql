-- R1 DRAFT ROLLBACK - NOT FOR HOSTED APPLICATION.
drop trigger if exists management_item_decisions_guard on management_item_decisions;
drop trigger if exists management_item_decisions_no_update on management_item_decisions;
drop table if exists management_item_decisions;
drop function if exists r1_draft_decision_guard();
drop function if exists r1_draft_decisions_append_only();
