-- 0055_wp12_truthful_delivery_state.sql
-- Correction brief 0048 — WP12: make quotation/order delivery state truthful.
--
-- Problem. `tryFinalizeAndSend()` enqueued a WhatsApp message, ran a best-effort inline outbox
-- drain, and then IMMEDIATELY marked the quotation `sent`, the order `quoted` and the conversation
-- `quoted`, returning `{ sent: true }` even when the provider send or the durable completion had
-- failed. The commercial document lied about delivery.
--
-- Fix (this migration provides the DB half):
--   * `message_outbox` gains `source_type`, `source_id`, `message_purpose` so a completed send can
--     advance the exact linked document (no secrets stored).
--   * `quotations.status` gains an explicit **`queued`** state (draft → awaiting_price → ready →
--     queued → sent). The app marks the quotation `queued` on enqueue, NOT `sent`.
--   * `complete_outbox_and_advance(outbox_id, lease_owner, provider_message_id)` — a fenced,
--     service-only RPC that ATOMICALLY: verifies the outbox id + lease owner (only a 'processing'
--     row owned by this worker), records the provider message id, flips the outbox row to `sent`,
--     advances the linked quotation → `sent` / order → `quoted` / conversation → `quoted`
--     (company-scoped, so a cross-company source id can never be linked or advanced; terminal
--     order/conversation states are never regressed), and writes a non-sensitive audit event.
--     Returns TRUE only when exactly one owned row was completed; a zero-row/wrong-lease/duplicate
--     call returns FALSE and advances nothing.
--
-- Delivery is AT-LEAST-ONCE: a provider-success / DB-failure window can still cause a retry, so the
-- lease does NOT make duplicate external delivery impossible. `delivered` (a later state) may only
-- be set from a verified provider callback — not modelled here.
--
-- Forward-only, idempotent. Grants are service-role only.

-- ── 1. Outbox source metadata (no secrets) ───────────────────────────────────
alter table message_outbox add column if not exists source_type    text;
alter table message_outbox add column if not exists source_id      uuid;
alter table message_outbox add column if not exists message_purpose text;

-- ── 2. Truthful quotation lifecycle: add the explicit `queued` state ──────────
alter table quotations drop constraint if exists quotations_status_check;
alter table quotations add constraint quotations_status_check
  check (status in ('draft','awaiting_price','ready','queued','sent','accepted','rejected'));

-- ── 3. Fenced, service-only completion that advances the linked document ──────
create or replace function public.complete_outbox_and_advance(
  p_outbox_id uuid, p_lease_owner text, p_provider_message_id text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_src_type text; v_src_id uuid; v_order uuid; v_conv uuid;
begin
  -- Fence: only the current lease owner may complete a still-'processing' row. This flips the
  -- outbox row to `sent` and returns its identity in one atomic step.
  update message_outbox
     set status = 'sent', sent_at = now(), provider_message_id = p_provider_message_id,
         locked_at = null, lock_owner = null, lease_expires_at = null
   where id = p_outbox_id and lock_owner = p_lease_owner and status = 'processing'
   returning company_id, source_type, source_id into v_company, v_src_type, v_src_id;
  if not found then
    return false;  -- zero-row / wrong-lease / already-completed → nothing advanced
  end if;

  -- Advance the linked commercial document TRUTHFULLY, company-scoped (a cross-company source id
  -- matches no row here, so it can never be linked or advanced). Only on a real state change.
  if v_src_type = 'quotation' and v_src_id is not null then
    update quotations set status = 'sent', sent_at = now()
      where id = v_src_id and company_id = v_company and status in ('queued','ready')
      returning order_id into v_order;
    if found then
      if v_order is not null then
        -- new → quoted; keep quoted; never regress a confirmed/cancelled order.
        update orders set status = 'quoted', updated_at = now()
          where id = v_order and company_id = v_company and status not in ('confirmed','cancelled');
        select conversation_id into v_conv from orders where id = v_order and company_id = v_company;
        if v_conv is not null then
          update wa_conversations set status = 'quoted', updated_at = now()
            where id = v_conv and company_id = v_company and status <> 'closed';
        end if;
      end if;
      insert into audit_events (company_id, actor_type, actor_id, action, entity_type, entity_id, payload)
      values (v_company, 'system', null, 'quotation.sent', 'quotation', v_src_id,
              jsonb_build_object('outbox_id', p_outbox_id, 'provider_message_id', p_provider_message_id));
    end if;
  end if;
  return true;
end $$;

-- ── 4. Grants: service-only (the drain worker runs as service_role) ───────────
do $$
begin
  revoke all on function public.complete_outbox_and_advance(uuid, text, text) from public;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.complete_outbox_and_advance(uuid, text, text) to service_role;
  end if;
end $$;
