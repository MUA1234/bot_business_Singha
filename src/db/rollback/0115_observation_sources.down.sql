-- Rollback for migration 0115 (promoted from R1_DRAFT_005).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
drop trigger if exists observation_sources_touch on observation_sources;
drop table if exists observation_sources;
