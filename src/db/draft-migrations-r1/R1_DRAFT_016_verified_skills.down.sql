-- ⛔ R1/R2C DRAFT — NOT FOR HOSTED APPLICATION. Rollback; disposable local databases only.
--
-- R2C_DRAFT_016 rollback. Triggers first, then the functions they reference, then the tables.
-- `skill_record_events` is dropped before `skill_records` even though the FK cascades, so the
-- order reads the same way the dependencies run.

drop trigger if exists skill_records_history_upd on skill_records;
drop trigger if exists skill_records_history on skill_records;
drop trigger if exists skill_records_no_protected on skill_records;
drop trigger if exists skill_record_events_no_update on skill_record_events;

drop function if exists r1_draft_skill_is_verified(skill_records);
drop function if exists r1_draft_skill_record_history();
drop function if exists r1_draft_skill_events_append_only();
drop function if exists r1_draft_skill_no_protected();

drop index if exists membership_languages_one_preferred;
drop table if exists membership_languages;

drop table if exists skill_record_events;
drop table if exists skill_records;
