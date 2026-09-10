-- ⛔ R1/R2B DRAFT — NOT FOR HOSTED APPLICATION. Rollback; disposable local databases only.
--
-- R2B_DRAFT_014 rollback. Order matters: the guard triggers reference their functions, and the
-- v2 RPC references the table, so everything is dropped from the outside in.
--
-- The append-only trigger refuses DELETE, which would ordinarily block dropping rows — but
-- DROP TABLE is DDL and does not fire row triggers, so the table goes cleanly. That is stated
-- here because the asymmetry is surprising, and a future reader should not "fix" it by
-- weakening the trigger.

drop trigger if exists mir_guard_insert on management_item_recommendations;
drop trigger if exists mir_no_protected on management_item_recommendations;
drop trigger if exists mir_no_update on management_item_recommendations;

drop function if exists public.r1_draft_create_management_item_v2(
  uuid, uuid, text, text, text, text, text, text, text, text, numeric, text, text, text,
  boolean, timestamptz, text, jsonb, jsonb, text, text
);

drop function if exists r1_draft_guard_recommendation_insert();
drop function if exists r1_draft_recommendation_no_protected();
drop function if exists r1_draft_recommendation_append_only();

drop table if exists management_item_recommendations;
