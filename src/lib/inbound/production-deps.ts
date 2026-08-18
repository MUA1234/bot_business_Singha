/**
 * Production wiring for the inbound dispatcher (FOUND-003).
 *
 * This lives outside the webhook route on purpose: BOTH inbound paths must use the same ports. The
 * synchronous route and the durable Inngest worker previously diverged — the worker called the
 * customer order handler directly, so with `WHATSAPP_ASYNC` on, every message was a customer order
 * again and the identity routing this requirement exists for simply did not apply.
 *
 * `classifyFinanceIntent` returns null because no model provider is configured (owner gate). That
 * fails CLOSED: a staff message goes to the review queue rather than falling through to customer
 * order intake. It is never treated as routine.
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import { makeSupabaseSourceEventStore } from "@/db/source-event-store";
import { handleCustomerMessage } from "@/lib/order-intake";
import { enqueueOutbox } from "@/lib/outbox-enqueue";
import { inngestQueue } from "@/inngest/client";
import type { DispatchDeps } from "@/lib/inbound/dispatch";
import type { ResolvedIdentity } from "@/lib/identity/inbound-routing";
import type { ResolvedCompany } from "@/lib/inbound/company-resolution";
import { log } from "@/lib/log";

/** Resolve which company owns a receiving provider account. Fails closed on a lookup error. */
export async function resolveCompanyForAccount(channel: string, providerAccountId: string): Promise<ResolvedCompany> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("resolve_channel_company", {
    p_channel: channel,
    p_provider_account_id: providerAccountId,
  });
  if (error) {
    log("error", "company resolution failed", { event: "inbound.company_lookup_failed", error: error.message });
    return { companyId: null, match: "lookup_error" };
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    companyId: (row?.company_id ?? null) as string | null,
    match: (row?.match ?? "unmapped") as ResolvedCompany["match"],
  };
}

/**
 * Stamp the resolved company onto an already-persisted source event.
 *
 * Persist-first stores the raw event BEFORE anything else runs, so at that moment the company is
 * genuinely unknown and the row is written with `company_id` null. Leaving it null forever would
 * make "events belonging to no company" — the health signal for an unmapped receiving number —
 * indistinguishable from every event that was handled perfectly well. Only ever fills a NULL: an
 * event never changes company.
 */
export async function stampSourceEventCompany(idempotencyKey: string, companyId: string): Promise<void> {
  const db = supabaseAdmin();
  const { error } = await db
    .from("source_events")
    .update({ company_id: companyId })
    .eq("idempotency_key", idempotencyKey)
    .is("company_id", null);
  if (error) {
    log("warn", "could not stamp company onto source event", {
      event: "inbound.company_stamp_failed",
      companyId,
      error: error.message,
    });
  }
}

export function makeInboundDeps(rawPayload: unknown): DispatchDeps {
  void rawPayload; // the raw event is persisted by the caller; kept for signature stability
  const db = supabaseAdmin();
  return {
    async resolveIdentity(companyId, channel, from): Promise<ResolvedIdentity> {
      const { data, error } = await db.rpc("resolve_channel_identity", {
        p_company: companyId,
        p_channel: channel,
        p_raw_identity: from,
      });
      if (error) {
        // A failed lookup must never be read as "not staff, therefore a customer". Fail closed.
        log("error", "identity resolution failed", { event: "inbound.identity_failed", error: error.message });
        return { actorType: "ambiguous", actorId: null, displayName: null, match: "lookup_error" };
      }
      const row = Array.isArray(data) ? data[0] : data;
      return {
        actorType: (row?.actor_type ?? "unknown") as ResolvedIdentity["actorType"],
        actorId: row?.actor_id ?? null,
        displayName: row?.display_name ?? null,
        match: row?.match ?? "no_match",
      };
    },

    // Owner gate: no provider configured. Returning null is the honest answer, and the dispatcher
    // treats it as a reason for human review rather than as an absence of financial content.
    async classifyFinanceIntent() {
      return null;
    },

    async handleCustomerOrder(msg) {
      return handleCustomerMessage({
        from: msg.from,
        text: msg.text,
        waMessageId: msg.providerMessageId,
        companyId: msg.companyId,
      });
    },

    async recordForReview(msg, reason, identity, reasonCode) {
      // The raw event is already durably persisted (persist-first), so nothing is lost. What this
      // adds is a ROW IN A QUEUE a person opens — the previous implementation wrote a log line,
      // which meant "fails closed to manual review" pointed at nowhere.
      //
      // No reply is sent: claiming to have dealt with it would be the false-acknowledgement defect
      // this program exists to eliminate.
      const { error } = await db.rpc("record_inbound_review", {
        p_company: msg.companyId,
        p_channel: msg.channel,
        p_provider_message_id: msg.providerMessageId,
        p_reason_code: reasonCode ?? "unspecified",
        p_reason_detail: reason,
        p_sender_identity: msg.from,
        p_actor_type: identity.actorType,
        p_identity_match: identity.match,
        p_body_excerpt: msg.text,
      });
      if (error) {
        // Surfaced, not swallowed: the message is durable but nobody has been asked to look at it.
        log("error", "inbound review could not be queued", {
          event: "inbound.review_queue_failed",
          reasonCode,
          providerMessageId: msg.providerMessageId,
          companyId: msg.companyId,
          error: error.message,
        });
        throw new Error(`inbound review could not be queued: ${error.message}`);
      }
      log("warn", "inbound message queued for a person", {
        event: "inbound.manual_review",
        reason,
        reasonCode,
        actorType: identity.actorType,
        match: identity.match,
        providerMessageId: msg.providerMessageId,
        companyId: msg.companyId,
      });
    },

    async askClarification(msg, question) {
      // Through the outbox, so the reply is durable and is never recorded as sent unless queued.
      await enqueueOutbox({
        channel: "whatsapp",
        companyId: msg.companyId,
        recipient: msg.from,
        body: question,
        dedupeKey: `wa_clarify:${msg.providerMessageId}`,
      });
    },

    store: makeSupabaseSourceEventStore(supabaseAdmin()),
    queue: inngestQueue,
    financeContext: { knownCurrencies: ["LKR"] },
  };
}
