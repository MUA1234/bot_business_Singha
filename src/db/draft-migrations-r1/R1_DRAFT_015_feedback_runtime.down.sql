-- ⛔ R1/R2B DRAFT — NOT FOR HOSTED APPLICATION. Rollback; disposable local databases only.
--
-- R2B_DRAFT_015 rollback.
--
-- The feedback_type CHECK is restored to unit 006's four values. That will FAIL if any row
-- already carries one of the Decision 3 event names — deliberately. The alternative is deleting
-- rows to make a rollback succeed, and silently destroying recorded human feedback to tidy up a
-- schema change is worse than a rollback that stops and says why.

drop trigger if exists mif_guard_insert on management_item_feedback;
drop trigger if exists mif_correction_guard on management_item_feedback;

drop function if exists r1_draft_guard_feedback_insert();
drop function if exists r1_draft_feedback_correction_guard();
drop function if exists public.r1_draft_record_feedback(uuid, uuid, uuid, text, uuid, jsonb, jsonb, text, text, uuid);

drop index if exists mif_supersedes_uq;
drop index if exists mif_subject_idx;

alter table management_item_feedback drop constraint if exists management_item_feedback_comment_len_ck;
alter table management_item_feedback drop column if exists comment;
alter table management_item_feedback drop column if exists subject_membership_id;
alter table management_item_feedback drop column if exists supersedes_id;

alter table management_item_feedback
  drop constraint if exists management_item_feedback_feedback_type_check;
alter table management_item_feedback
  add constraint management_item_feedback_feedback_type_check check (
    feedback_type in ('decision_reason', 'assignment_override', 'verification_result', 'detector_precision')
  );
