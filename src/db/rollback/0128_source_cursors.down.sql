-- Rollback for migration 0128 (promoted from R1_DRAFT_018).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
-- R2S-P_DRAFT_018 rollback. Dropping the cursor table loses only POSITION: the next sweep starts
-- from the beginning of each source, which is correct behaviour rather than data loss — a full
-- reconciliation is exactly what an unknown position should fall back to.

drop trigger if exists osc_guard_write on observation_source_cursors;
drop trigger if exists osc_payload_guard on observation_source_cursors;

drop function if exists r1_draft_guard_cursor_write();
drop function if exists r1_draft_cursor_payload_guard();

drop table if exists observation_source_cursors;
