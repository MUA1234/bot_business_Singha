-- R1 DRAFT ROLLBACK - NOT FOR HOSTED APPLICATION.
drop function if exists r1_draft_transition_item(uuid, text, text, uuid, text, text, jsonb);
drop trigger if exists management_item_transitions_no_update on management_item_transitions;
drop table if exists management_item_transitions;
drop function if exists r1_draft_transitions_append_only();
