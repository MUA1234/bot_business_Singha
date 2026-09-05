-- ⛔ R1 DRAFT — NOT FOR HOSTED APPLICATION. Disposable local databases only.
--
-- Reverse of R1_DRAFT_026.

drop function if exists public.r1_draft_claim_task_completion(uuid, uuid, text, text, text, text, text);

drop trigger if exists management_completion_claims_guard on management_completion_claims;
drop function if exists r1_draft_completion_claims_append_only();

drop index if exists management_completion_claims_idem_uq;
drop index if exists management_completion_claims_item;

drop table if exists management_completion_claims;
