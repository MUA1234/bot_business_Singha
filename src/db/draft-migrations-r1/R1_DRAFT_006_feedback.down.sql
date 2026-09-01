-- R1 DRAFT ROLLBACK - NOT FOR HOSTED APPLICATION.
drop trigger if exists management_item_feedback_no_update on management_item_feedback;
drop table if exists management_item_feedback;
drop function if exists r1_draft_feedback_append_only();
