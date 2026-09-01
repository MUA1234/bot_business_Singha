-- R1 DRAFT ROLLBACK - NOT FOR HOSTED APPLICATION.
drop trigger if exists management_items_touch on management_items;
drop table if exists management_items;
-- r1_draft_touch_updated_at is shared with observation_sources (unit 005); by the time this
-- unit rolls back, 005 has already gone (rollback runs in reverse order), so it is safe.
drop function if exists r1_draft_touch_updated_at();
