/**
 * WhatsApp order-intake conversation engine. One customer message in → one reply
 * out. It drives the AI intake turn, merges collected details into the persistent
 * conversation state, and — once enough is known — creates a quotation:
 *
 *   • fully priced from the catalog → finalize + send the quotation link.
 *   • any price unknown → route a price_confirmation to a department and keep
 *     chatting with the customer, appending the "(Quotation is being generated.
 *     Please wait)" footer to every message until it's resolved (D-017).
 *
 * Idempotent on the provider message id (a redelivered webhook is a no-op).
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import { makeOpenAiTransport } from "@/ai/openai-transport";
import { runQuotationTurn } from "@/ai/quotation";
import { withPendingFooter } from "@/lib/whatsapp";
import { enqueueOutbox } from "@/lib/outbox-enqueue";
import { drainOutbox } from "@/events/outbox-drain";
import { createQuotationFromItems, tryFinalizeAndSend } from "@/lib/quotations";
import { DEFAULT_COMPANY_ID } from "@/lib/constants";
import { log } from "@/lib/log";

interface ConvState {
  name?: string | null;
  address?: string | null;
  email?: string | null;
  items?: { description: string; quantity: number }[];
  quotationId?: string | null;
}

export async function handleCustomerMessage(input: {
  from: string; // customer WA id (digits, no '+')
  text: string;
  waMessageId: string;
  companyId?: string;
}): Promise<{ status: string }> {
  const db = supabaseAdmin();
  const companyId = input.companyId ?? DEFAULT_COMPANY_ID;
  const from = input.from.replace(/^\+/, "");

  // Idempotency + resume-safety (§WP-C): treat as a duplicate ONLY if a prior run fully
  // HANDLED this message (reply sent). If a prior attempt crashed after logging the
  // inbound row but before replying, handled_at is null → we resume and still reply.
  const { data: prior } = await db
    .from("wa_messages")
    .select("id, handled_at")
    .eq("company_id", companyId)
    .eq("wa_message_id", input.waMessageId)
    .eq("direction", "inbound")
    .maybeSingle();
  if (prior?.handled_at) return { status: "duplicate" };

  // Load or create the conversation.
  const { data: convo } = await db
    .from("wa_conversations")
    .select("id, status, state, customer_name")
    .eq("company_id", companyId)
    .eq("customer_wa_id", from)
    .maybeSingle();

  let conversationId: string;
  let state: ConvState = (convo?.state as ConvState) ?? {};
  let status: string = convo?.status ?? "collecting";

  if (convo) {
    conversationId = convo.id;
  } else {
    const { data: created, error } = await db
      .from("wa_conversations")
      .insert({ company_id: companyId, customer_wa_id: from, status: "collecting", state: {} })
      .select("id")
      .single();
    if (error || !created) throw new Error(`conversation insert failed: ${error?.message}`);
    conversationId = created.id;
  }

  // Log the inbound message (or reuse the row left by a crashed prior attempt).
  let inboundId: string;
  if (prior) {
    inboundId = prior.id;
  } else {
    const { data: ins, error: insErr } = await db
      .from("wa_messages")
      .insert({ conversation_id: conversationId, company_id: companyId, direction: "inbound", body: input.text, wa_message_id: input.waMessageId })
      .select("id")
      .single();
    if (insErr || !ins) {
      // A concurrent delivery won the unique index — re-read; if already handled, stop.
      const { data: race } = await db.from("wa_messages").select("id, handled_at").eq("company_id", companyId).eq("wa_message_id", input.waMessageId).eq("direction", "inbound").maybeSingle();
      if (race?.handled_at) return { status: "duplicate" };
      if (!race?.id) throw new Error(`inbound insert failed: ${insErr?.message}`);
      inboundId = race.id;
    } else {
      inboundId = ins.id;
    }
  }
  await db
    .from("wa_conversations")
    .update({ last_inbound_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("company_id", companyId);

  // Catalog names help the model name items consistently (never prices).
  const { data: catalog } = await db
    .from("product_catalog")
    .select("name")
    .eq("company_id", companyId)
    .eq("is_active", true);
  const catalogNames = (catalog ?? []).map((c: any) => c.name);

  const turn = await runQuotationTurn(makeOpenAiTransport(), {
    message: input.text,
    state: { name: state.name, address: state.address, email: state.email, items: state.items },
    catalogNames,
  });

  let reply: string;
  const awaitingAlready = status === "awaiting_price";

  if (!turn.ok) {
    // Graceful fallback if the model is unavailable — never drop the customer.
    reply = "Thanks for your message! One of our team will get back to you shortly.";
  } else {
    // Merge collected details.
    const t = turn.turn;
    state = {
      ...state,
      name: t.customer.name ?? state.name,
      address: t.customer.address ?? state.address,
      email: t.customer.email ?? state.email,
      items: t.items.length ? t.items : state.items,
    };
    reply = t.reply;

    const haveEnough =
      t.ready_to_quote && state.items && state.items.length > 0 && state.name && state.address;

    // Create the quotation once (only if we don't already have one in flight).
    if (haveEnough && !state.quotationId && !awaitingAlready && status !== "quoted") {
      const { quotationId, awaitingPrice } = await createQuotationFromItems({
        companyId,
        conversationId,
        customer: {
          name: state.name,
          phone: from,
          address: state.address,
          email: state.email,
          requestText: input.text,
        },
        items: state.items!,
      });
      state.quotationId = quotationId;

      if (awaitingPrice) {
        status = "awaiting_price";
        reply = withPendingFooter(
          "Thank you! We have everything we need and your quotation is being prepared. " +
            "We'll send it here very shortly.",
        );
      } else {
        // Fully priced — finalize + send the quotation link (its own message). The conversation
        // advances to `quoted` ONLY on durable provider success (via the fenced completion RPC);
        // while the send is merely queued/failed it stays `quoting` (truthful, not delivered).
        const res = await tryFinalizeAndSend(companyId, quotationId);
        status = res.sent ? "quoted" : "quoting";
        reply = res.sent
          ? "Perfect — I've just sent your quotation. Please check the message above. 🦁"
          : "Thank you! Your quotation is ready and being sent now.";
      }
    } else if (awaitingAlready || status === "awaiting_price") {
      // Still waiting on staff pricing — keep the footer on every message.
      reply = withPendingFooter(reply);
      status = "awaiting_price";
    }
  }

  // Persist conversation state.
  await db
    .from("wa_conversations")
    .update({ state, status, customer_name: state.name ?? convo?.customer_name ?? null, updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("company_id", companyId);

  // §WP5: ENQUEUE the reply to the durable outbox (dedup on the inbound provider id) rather
  // than sending directly — a transport/provider failure can never lose or double-send it.
  // A best-effort inline drain delivers it promptly; the outbox sweep is the recovery path.
  // Delivery is at-least-once (the outbox idempotency key makes a redelivery a no-op).
  const enqueued = await enqueueOutbox({ channel: "whatsapp", companyId, recipient: from, body: reply, dedupeKey: `wa_reply:${input.waMessageId}` });

  // Migration 0058 exists because writing the outbound history row before the message is durably
  // queued makes the thread claim a delivery that never happened. That rule was applied to the
  // quotation path and not to this one: the enqueue result used to be discarded, so an
  // "unavailable" outbox (RPC missing or erroring) still rendered a sent-looking message to staff.
  // Record the reply ONLY when it is durably queued; otherwise leave the inbound unhandled so the
  // message is retried rather than silently dropped with a false record of having answered.
  if (enqueued === "unavailable") {
    log("error", "reply not recorded — outbox unavailable", {
      event: "order_intake.reply_not_queued",
      conversationId,
      companyId,
    });
    return { status };
  }

  await db.from("wa_messages").insert({
    conversation_id: conversationId, company_id: companyId, direction: "outbound", body: reply, wa_message_id: null,
  });
  await db.from("wa_messages").update({ handled_at: new Date().toISOString() }).eq("id", inboundId);
  try { await drainOutbox(db); } catch { /* sweep will recover */ }

  return { status };
}
