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
import { handleCustomerMessage } from "@/lib/order-intake";
import { enqueueOutbox } from "@/lib/outbox-enqueue";
import { inngestQueue } from "@/inngest/client";
import type { DispatchDeps } from "@/lib/inbound/dispatch";
import type { ResolvedIdentity } from "@/lib/identity/inbound-routing";
import type { ResolvedCompany } from "@/lib/inbound/company-resolution";
import { recordInboundDispatch } from "@/lib/inbound/receipt";
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
 * Wire the dispatch ports. `dispatchOwner` is the lease this dispatcher holds on the receipt — the
 * capture marker is refused unless it matches, so a stale dispatcher cannot record an outcome after
 * another one took the work over.
 */
/**
 * Which currencies is this company known to transact in?
 *
 * `["LKR"]` was hardcoded for every company — the same single-tenant assumption as the deleted
 * DEFAULT_COMPANY_ID, one layer down. The company's own base currency is the truthful answer; a
 * message in anything else is not captured, which is the fail-closed direction (the finance gate
 * sends it to a person rather than guessing a conversion). An empty list on a failed lookup means
 * nothing is captured at all, which is also the safe direction.
 */
export async function companyKnownCurrencies(companyId: string): Promise<string[]> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("companies").select("base_currency").eq("id", companyId).maybeSingle();
  if (error || !data?.base_currency) {
    log("error", "could not read the company base currency", {
      event: "inbound.currency_lookup_failed",
      companyId,
      error: error?.message ?? "no row",
    });
    return [];
  }
  return [String(data.base_currency).toUpperCase()];
}

export function makeInboundDeps(dispatchOwner: string, knownCurrencies: string[]): DispatchDeps {
  const db = supabaseAdmin();
  return {
    /**
     * Record the finance capture against the EXISTING receipt, atomically making it consumer work.
     * `alreadyCaptured` is what makes the enqueue exactly-once across redeliveries and retries.
     */
    async markCapture(eventId, companyId) {
      const res = await recordInboundDispatch(db, {
        eventId,
        owner: dispatchOwner,
        outcome: "staff_finance",
        companyId,
      });
      return { alreadyCaptured: res.already };
    },

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
        // Link the queue item to the canonical receipt, so a reviewer can reach the original event
        // and a replay finds the SAME row rather than creating a second one.
        p_source_event: msg.receipt?.id ?? null,
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

    // A SECOND persistence path is precisely how one provider message became two `source_events`
    // rows. Production always supplies the canonical receipt, so this port must never be reached —
    // and if a future caller forgets the receipt, that is a loud failure rather than a quiet
    // duplicate.
    store: {
      async upsert() {
        throw new Error(
          "the production inbound path must persist through record_inbound_receipt — a second persistence path is how one message became two rows",
        );
      },
    },
    queue: inngestQueue,
    financeContext: { knownCurrencies },
  };
}
