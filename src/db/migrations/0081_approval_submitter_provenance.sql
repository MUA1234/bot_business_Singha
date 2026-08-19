-- 0081_approval_submitter_provenance.sql
-- Remediation R1 §7 (OF-013) — an approval request the SYSTEM submitted could not be created.
--
-- FOUND BY the extreme end-to-end run, which is the first thing that ever reached the approval
-- branch of `processSourceEvent` against a real database: the finance consumer was only wired in
-- R1 §4, and a classifier able to get a message that far is an owner gate.
--
-- THE DEFECT. `loadCompanyContext` returned the literal string `"system"` as `submitterUserId`
-- and `approval_requests.submitted_by` is `uuid NOT NULL`. Every captured finance message that
-- reached the approval branch failed with `invalid input syntax for type uuid: "system"`, retried
-- under the sweeper's budget, and dead-lettered. A message describing a real payment therefore
-- reached no approver at all, and the failure read as a transient processing error rather than as
-- the design gap it was.
--
-- THE FIX is the same discipline migration 0078 applied to routing decisions: provenance is
-- DERIVED and EXPLICIT, never a person-shaped string standing in for a machine.
--
--   * `submitted_by` becomes nullable, and `submitted_by_source` says which kind of submitter it
--     was. A human request names the person; a system request names nobody.
--   * The pairing is a CHECK, so neither half can drift from the other.
--   * The system source is refused to any non-service caller by a fail-closed trigger. This
--     matters for separation of duties: `canActOnApproval` refuses an approver who is also the
--     submitter, so a person able to submit AS the system could have approved their own request
--     with nobody named as its submitter. (RLS already forces `submitted_by = auth.uid()` for
--     `authenticated`; the trigger closes the same door for any other non-service caller and does
--     not depend on that policy staying as it is.)
--   * Provenance is IMMUTABLE after insert. The decision (`status`) stays mutable.
--
-- Forward-only. Existing rows all carry a non-null `submitted_by` and are backfilled to 'human',
-- which is what they were. No data is deleted and no approval decision changes.

begin;

-- ── (1) the columns ──────────────────────────────────────────────────────────────────────────
alter table public.approval_requests
  add column if not exists submitted_by_source text not null default 'human';

alter table public.approval_requests alter column submitted_by drop not null;

comment on column public.approval_requests.submitted_by is
  'The PERSON who submitted this request. Null exactly when submitted_by_source = ''system''.';
comment on column public.approval_requests.submitted_by_source is
  'Who submitted: ''human'' (submitted_by names them) or ''system'' (no person; the consumer pipeline did).';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'approval_requests_submitted_by_source_check') then
    alter table public.approval_requests
      add constraint approval_requests_submitted_by_source_check
      check (submitted_by_source in ('human', 'system'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_requests_submitter_provenance_check') then
    alter table public.approval_requests
      add constraint approval_requests_submitter_provenance_check
      check (
        (submitted_by_source = 'human'  and submitted_by is not null)
        or
        (submitted_by_source = 'system' and submitted_by is null)
      );
  end if;
end $$;

-- ── (2) the trust boundary ───────────────────────────────────────────────────────────────────
-- `caller_jwt_role()` is the same trusted-context signal migrations 0077/0078 use. The default is
-- REFUSE: anything that is not an explicit service context may not claim the system source.
create or replace function public.approval_requests_provenance_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, extensions, public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.submitted_by_source = 'system'
       and public.caller_jwt_role() is distinct from 'service_role' then
      raise exception 'only the service context may submit an approval request as the system'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- UPDATE: the submitter and the source are settled facts about how the request came to exist.
  if new.submitted_by is distinct from old.submitted_by then
    raise exception 'approval_requests.submitted_by is immutable';
  end if;
  if new.submitted_by_source is distinct from old.submitted_by_source then
    raise exception 'approval_requests.submitted_by_source is immutable';
  end if;
  return new;
end;
$$;

revoke all on function public.approval_requests_provenance_guard() from public, anon, authenticated, service_role;

drop trigger if exists approval_requests_provenance_trg on public.approval_requests;
create trigger approval_requests_provenance_trg
  before insert or update on public.approval_requests
  for each row execute function public.approval_requests_provenance_guard();

-- ── (3) fail closed on a wrong assumption ────────────────────────────────────────────────────
-- If any pre-existing row somehow violates the new pairing, ABORT rather than leave the table in
-- a state the constraint claims is impossible.
do $$
declare v_bad bigint;
begin
  select count(*) into v_bad
    from public.approval_requests
   where (submitted_by_source = 'human'  and submitted_by is null)
      or (submitted_by_source = 'system' and submitted_by is not null);
  if v_bad > 0 then
    raise exception '0081: % approval_requests rows contradict the submitter provenance pairing', v_bad;
  end if;
end $$;

commit;
