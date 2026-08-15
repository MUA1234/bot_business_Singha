-- 0058_wp12_message_history_on_completion.sql
-- Phase 1 external-review correction A — WP12: message history must not look "sent" while a
-- quotation is only queued/failed. Previously tryFinalizeAndSend() inserted an outbound wa_messages
-- row at enqueue time (before provider success) and could duplicate it on retries.
--
-- Fix: create the outbound message-history row ATOMICALLY inside the fenced completion RPC — only
-- when the provider send is durably recorded — carrying the provider message id. The RPC completes
-- an outbox row exactly once (processing → sent under the lease fence), so the history row is
-- created exactly once; a retried/duplicate completion returns false and inserts nothing. Queued /
-- failed / dead states remain visible on message_outbox; wa_messages holds only real (sent) records.
--
-- Forward-only; CREATE OR REPLACE of complete_outbox_and_advance. No data change. Service-only grant
-- unchanged (from 0055).

create or replace function public.complete_outbox_and_advance(
  p_outbox_id uuid, p_lease_owner text, p_provider_message_id text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_src_type text; v_src_id uuid; v_order uuid; v_conv uuid; v_body text;
begin
  update message_outbox
     set status = 'sent', sent_at = now(), provider_message_id = p_provider_message_id,
         locked_at = null, lock_owner = null, lease_expires_at = null
   where id = p_outbox_id and lock_owner = p_lease_owner and status = 'processing'
   returning company_id, source_type, source_id, body into v_company, v_src_type, v_src_id, v_body;
  if not found then
    return false;  -- zero-row / wrong-lease / already-completed → nothing advanced
  end if;

  if v_src_type = 'quotation' and v_src_id is not null then
    update quotations set status = 'sent', sent_at = now()
      where id = v_src_id and company_id = v_company and status in ('queued','ready')
      returning order_id into v_order;
    if found then
      if v_order is not null then
        update orders set status = 'quoted', updated_at = now()
          where id = v_order and company_id = v_company and status not in ('confirmed','cancelled');
        select conversation_id into v_conv from orders where id = v_order and company_id = v_company;
        if v_conv is not null then
          update wa_conversations set status = 'quoted', updated_at = now()
            where id = v_conv and company_id = v_company and status <> 'closed';
          -- Outbound message HISTORY is written here — on durable provider success only — with the
          -- provider message id. This is the single writer, so it is created exactly once.
          insert into wa_messages (conversation_id, company_id, direction, body, wa_message_id)
          values (v_conv, v_company, 'outbound', v_body, p_provider_message_id);
        end if;
      end if;
      insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
      values (v_company, 'system', null, 'quotation.sent', 'quotation', v_src_id,
              jsonb_build_object('outbox_id', p_outbox_id, 'provider_message_id', p_provider_message_id));
    end if;
  end if;
  return true;
end $$;

do $$
begin
  revoke all on function public.complete_outbox_and_advance(uuid, text, text) from public;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.complete_outbox_and_advance(uuid, text, text) to service_role;
  end if;
end $$;
