-- Rollback for migration 0127 (promoted from R1_DRAFT_017).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
-- R2C_DRAFT_017 rollback.
--
-- The unique constraints added to `memberships` and `service_providers` are NOT dropped here.
-- Unit 008 and unit 016 also depend on `memberships_id_company_uq`, and removing it would break
-- their rollback in a way that depends on the order units happen to be rolled back in. A
-- redundant unique index is harmless; a broken foreign key is not.

drop table if exists consultant_engagements;
drop table if exists advisor_relationships;
