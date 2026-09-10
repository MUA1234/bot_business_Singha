-- R1 DRAFT ROLLBACK - NOT FOR HOSTED APPLICATION.
drop function if exists r1_draft_release_cycle_lock(uuid);
drop function if exists r1_draft_try_cycle_lock(uuid);
drop trigger if exists management_cycle_runs_no_update on management_cycle_runs;
drop table if exists management_cycle_runs;
drop function if exists r1_draft_runs_append_only();
drop trigger if exists management_kernel_enablement_touch on management_kernel_enablement;
drop table if exists management_kernel_enablement;
