-- Rollback for migration 0120 (promoted from R1_DRAFT_010).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
-- Removes the RPC-only lifecycle boundary. The transition function is left in its unit-010
-- form: it still mints and burns the token, which is harmless once no trigger reads it, and
-- restoring the older body here would silently drop the needs_routing provenance writes.
drop trigger if exists management_items_guard_state on management_items;
drop function if exists r1_draft_guard_state_change();
