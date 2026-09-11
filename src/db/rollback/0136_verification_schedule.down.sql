-- Rollback for migration 0135 (promoted from R1_DRAFT_025).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
-- Reverse of R1_DRAFT_025.

drop trigger if exists management_verification_attempts_guard on management_verification_attempts;
drop function if exists r1_draft_verification_attempts_append_only();

drop trigger if exists management_verification_schedule_touch on management_verification_schedule;

drop index if exists management_verification_attempts_item;
drop index if exists management_verification_schedule_due;

drop table if exists management_verification_attempts;
drop table if exists management_verification_schedule;
