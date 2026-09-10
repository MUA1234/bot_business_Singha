-- ⛔ R1/R2C DRAFT — NOT FOR HOSTED APPLICATION. Rollback; disposable local databases only.
--
-- R2C_DRAFT_017 rollback.
--
-- The unique constraints added to `memberships` and `service_providers` are NOT dropped here.
-- Unit 008 and unit 016 also depend on `memberships_id_company_uq`, and removing it would break
-- their rollback in a way that depends on the order units happen to be rolled back in. A
-- redundant unique index is harmless; a broken foreign key is not.

drop table if exists consultant_engagements;
drop table if exists advisor_relationships;
