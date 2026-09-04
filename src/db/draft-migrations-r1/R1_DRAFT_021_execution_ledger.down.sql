-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
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
