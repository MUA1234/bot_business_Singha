-- R1 DRAFT ROLLBACK - NOT FOR HOSTED APPLICATION.
--
-- Removes the PostgREST execution transport (unit 029). Everything here was CREATED by unit
-- 029, so unlike unit 008 there is no shared object to be careful about — but the same rule
-- applies and is stated so the next reader does not have to re-derive it: a down migration
-- removes what its up created, and nothing else.

drop function if exists public.r1_exec_create_internal_task(
  uuid, uuid, text, text, text, text, text, text);
drop function if exists public.r1_exec_record_refusal(uuid, uuid, text, text, text, text);
drop function if exists public.r1_exec_approver_capabilities(uuid, uuid);
drop function if exists public.r1_exec_load_approval(uuid, uuid, text);
drop function if exists public.r1_exec_load_item(uuid, uuid);
drop function if exists public.r1_exec_company_enabled(uuid);
drop function if exists public.r1_exec_evidence_digest(uuid, uuid);

drop table if exists public.r1_exec_global_boundary;
