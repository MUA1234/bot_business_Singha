-- R1 DRAFT ROLLBACK - NOT FOR HOSTED APPLICATION.
-- Removes the RPC-only lifecycle boundary. The transition function is left in its unit-010
-- form: it still mints and burns the token, which is harmless once no trigger reads it, and
-- restoring the older body here would silently drop the needs_routing provenance writes.
drop trigger if exists management_items_guard_state on management_items;
drop function if exists r1_draft_guard_state_change();
