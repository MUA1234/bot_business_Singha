-- Rollback for migration 0131 (promoted from R1_DRAFT_021).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
-- Reverse of R1_DRAFT_021.

drop trigger if exists management_execution_attempts_guard on management_execution_attempts;
drop function if exists r1_draft_execution_attempt_guard();

drop trigger if exists management_execution_enablement_touch on management_execution_enablement;

drop index if exists management_execution_attempts_key_uniq;
drop index if exists management_execution_attempts_item;

drop function if exists r1_draft_create_internal_task(uuid, text, text, text, boolean, uuid);
drop table if exists management_task_idempotency;
drop table if exists management_execution_attempts;
drop table if exists management_execution_enablement;
