-- Rollback for migration 0121 (promoted from R1_DRAFT_011).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
drop function if exists r1_draft_release_cycle_lock(uuid);
drop function if exists r1_draft_try_cycle_lock(uuid);
drop trigger if exists management_cycle_runs_no_update on management_cycle_runs;
drop table if exists management_cycle_runs;
drop function if exists r1_draft_runs_append_only();
drop trigger if exists management_kernel_enablement_touch on management_kernel_enablement;
drop table if exists management_kernel_enablement;
