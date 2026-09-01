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
import { log, newCorrelationId } from "@/lib/log";
import { writeAudit } from "@/lib/audit";
import { makeSupabaseCostLedger } from "@/db/consumer-store";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolve the company that owns the Meta business number a customer messaged.
 *
 * Replaces the compiled-in `DEFAULT_COMPANY_ID`. Returns null when the number is not
 * mapped (migration 0069 `companies.whatsapp_phone_number_id`) so the caller can fail
 * closed rather than guess. Exported for testing.
 */
export async function resolveCompanyByPhoneNumberId(
  db: SupabaseClient,
  phoneNumberId: string | null | undefined,
): Promise<string | null> {
  if (!phoneNumberId) return null;
  const { data, error } = await db
    .from("companies")
    .select("id")
    .eq("whatsapp_phone_number_id", phoneNumberId)
    .maybeSingle();
  if (error) {
    log("error", "company lookup by phone number failed", { event: "wa.company_lookup_failed", error: error.message });
    return null;
  }
  return (data?.id as string | undefined) ?? null;
}

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
  /** Meta business number that received the message — resolves the company (0069). */
  phoneNumberId?: string | null;
  companyId?: string;
}): Promise<{ status: string }> {
  const db = supabaseAdmin();
  const from = input.from.replace(/^\+/, "");

  // Company comes from the number the customer messaged — never a compiled-in default.
  // A message we cannot attribute is NOT processed: writing it into an assumed company is
  // exactly the cross-company leakage the constitution calls a critical failure. The source
  // event is already persisted at the webhook boundary, so an unmapped number loses nothing
  // — map it and replay. The error is loud because silence here looks like a healthy system.
  const companyId = input.companyId ?? (await resolveCompanyByPhoneNumberId(db, input.phoneNumberId));
  if (!companyId) {
    log("error", "inbound WhatsApp message could not be attributed to a company", {
      event: "wa.company_unresolved",
      phoneNumberId: input.phoneNumberId ?? null,
      waMessageId: input.waMessageId,
    });
    return { status: "company_unresolved" };
  }

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

  const correlationId = newCorrelationId();
  const turn = await runQuotationTurn(
    makeOpenAiTransport(),
    {
      message: input.text,
      companyId,
      correlationId,
      state: { name: state.name, address: state.address, email: state.email, items: state.items },
      catalogNames,
    },
    makeSupabaseCostLedger(db), // persist model/tokens/cost/latency per customer turn
  );

  let reply: string;
  const awaitingAlready = status === "awaiting_price";

  if (!turn.ok) {
    // Graceful fallback if the model is unavailable — never drop the customer. LOG THE REASON:
    // a silent fallback here previously hid a schema mismatch that stopped every quotation from
    // being created while the conversation still looked healthy from the outside.
    log("error", "quotation turn failed", {
      event: "wa.turn_failed",
      conversationId,
      companyId,
      waMessageId: input.waMessageId,
      reason: turn.reason,
    });
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

      // AUDIT. A customer-initiated order and quotation are business records created with no
      // human in the loop, and until now the WhatsApp path wrote NOTHING to audit_events while
      // every dashboard action did. The actor is the system, on evidence of this exact message.
      await writeAudit({
        companyId,
        actorId: null, // system actor (0049): actor_type='system' carries actor_id NULL
        actorType: "system",
        action: "quotation.created_from_whatsapp",
        entityType: "quotation",
        entityId: quotationId,
        payload: {
          conversation_id: conversationId,
          wa_message_id: input.waMessageId,
          items: (state.items ?? []).length,
          awaiting_price: awaitingPrice,
        },
      });

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
  await enqueueOutbox({ channel: "whatsapp", companyId, recipient: from, body: reply, dedupeKey: `wa_reply:${input.waMessageId}` });
  await db.from("wa_messages").insert({
    conversation_id: conversationId, company_id: companyId, direction: "outbound", body: reply, wa_message_id: null,
  });
  await db.from("wa_messages").update({ handled_at: new Date().toISOString() }).eq("id", inboundId);
  try { await drainOutbox(db); } catch { /* sweep will recover */ }

  return { status };
}
