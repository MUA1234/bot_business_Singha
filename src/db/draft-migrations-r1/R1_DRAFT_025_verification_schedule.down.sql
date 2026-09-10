-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- Reverse of R1_DRAFT_025.

drop trigger if exists management_verification_attempts_guard on management_verification_attempts;
drop function if exists r1_draft_verification_attempts_append_only();

drop trigger if exists management_verification_schedule_touch on management_verification_schedule;

drop index if exists management_verification_attempts_item;
drop index if exists management_verification_schedule_due;

drop table if exists management_verification_attempts;
drop table if exists management_verification_schedule;
