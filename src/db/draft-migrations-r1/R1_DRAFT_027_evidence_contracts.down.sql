-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- Reverse of R1_DRAFT_027.

drop function if exists public.r1_draft_create_management_item_v3(
  uuid, uuid, text, text, text, text, text, text, text, text, numeric, text, text,
  text, boolean, timestamptz, text, jsonb, jsonb, text, text, jsonb, text, text);

drop function if exists public.r1_draft_eligibility_digest(jsonb);
drop function if exists public.r1_draft_condition_digest_of(jsonb);

-- v2 is left as 027 defined it: draft 014 would have to be re-applied to restore its body, and a
-- down that half-restores a function is worse than one that says what it does not undo.

alter table management_item_recommendations
  drop column if exists condition_evidence_digest,
  drop column if exists eligibility_evidence_digest,
  drop column if exists action_id,
  drop column if exists planned_parameters,
  drop column if exists parameter_digest,
  drop column if exists policy_version;
