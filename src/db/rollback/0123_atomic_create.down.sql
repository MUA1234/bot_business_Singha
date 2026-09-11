-- Rollback for migration 0122 (promoted from R1_DRAFT_012).
--
-- The forward runner never reads this directory: it is not src/db/migrations, and the
-- filename is not NNNN_name.sql. Applying this is a deliberate manual act on a database
-- somebody has decided to roll back, in reverse dependency order.
--
drop trigger if exists management_items_guard_insert on management_items;
drop function if exists r1_draft_guard_item_insert();
drop function if exists public.r1_draft_create_management_item(
  uuid,uuid,text,text,text,text,text,text,text,text,numeric,text,text,text,boolean,timestamptz,text,jsonb);

-- Restore the unit-007 authenticated INSERT policy so rolling back 012 alone leaves the
-- table usable rather than write-locked.
do $$
begin
  if to_regprocedure('public.has_capability(uuid, text)') is not null then
    begin
      execute 'create policy management_items_ins on public.management_items
                 for insert to authenticated
                 with check (public.has_capability(company_id, ''operations.task.manage''))';
    exception when duplicate_object then null;
    end;
  end if;
end
$$;
