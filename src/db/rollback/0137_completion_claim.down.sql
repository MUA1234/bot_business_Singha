-- Rollback for migration 0136 (promoted from R1_DRAFT_026).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
-- Reverse of R1_DRAFT_026.

drop function if exists public.r1_draft_claim_task_completion(uuid, uuid, text, text, text, text, text);

drop trigger if exists management_completion_claims_guard on management_completion_claims;
drop function if exists r1_draft_completion_claims_append_only();

drop index if exists management_completion_claims_idem_uq;
drop index if exists management_completion_claims_item;

drop table if exists management_completion_claims;
