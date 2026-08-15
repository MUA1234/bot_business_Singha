/**
 * Quotation domain logic — shared by the WhatsApp pipeline (auto-quoting) and the
 * dashboards (price confirmation, resend). This is the deterministic layer that
 * turns a captured request into a priced quotation:
 *
 *   items → price against product_catalog
 *         → any unpriced item becomes a `price_confirmation` routed to a department
 *         → when every item is priced, finalize totals and send to the customer.
 *
 * The AI never sets a price here (AI-safety + D-017): prices come from the catalog
 * or a human confirmation only.
 */
import Decimal from "decimal.js";
import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { enqueueOutbox } from "@/lib/outbox-enqueue";
import { drainOutbox, type DrainResult } from "@/events/outbox-drain";
import { env } from "@/config/env";

export interface DraftItem {
  description: string;
  quantity: number;
}

export interface CustomerDetails {
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  email?: string | null;
  requestText?: string | null;
}

/**
 * Unguessable token. The public quotation page (/q/<token>) exposes customer PII
 * and is guarded ONLY by this token, so it MUST use a CSPRNG — never Math.random(),
 * whose output is predictable and would let an attacker enumerate quotations.
 * Rejection sampling keeps the character distribution uniform (no modulo bias).
 */
function randToken(n = 24): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 chars
  const max = 256 - (256 % a.length); // largest multiple of 36 ≤ 256; reject above
  let s = "";
  while (s.length < n) {
    for (const byte of randomBytes(n)) {
      if (byte >= max) continue; // discard biased values
      s += a[byte % a.length];
      if (s.length === n) break;
    }
  }
  return s;
}

function quoteNumber(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `SQ-${ymd}-${randToken(4).toUpperCase()}`;
}

export function quoteUrl(token: string): string {
  return `${env.appBaseUrl.replace(/\/$/, "")}/q/${token}`;
}

/**
 * Create an order + quotation + items from a captured request, then price it.
 * Returns the quotation id and whether it is fully priced (ready) or awaiting a
 * human price confirmation.
 */
export async function createQuotationFromItems(input: {
  companyId: string;
  conversationId?: string | null;
  customer: CustomerDetails;
  items: DraftItem[];
  currency?: string;
  routeDepartment?: string;
}): Promise<{ quotationId: string; orderId: string; awaitingPrice: boolean }> {
  const db = supabaseAdmin();
  const currency = (input.currency ?? "LKR").toUpperCase().slice(0, 3);

  const { data: order, error: orderErr } = await db
    .from("orders")
    .insert({
      company_id: input.companyId,
      conversation_id: input.conversationId ?? null,
      customer_name: input.customer.name ?? null,
      customer_phone: input.customer.phone ?? null,
      customer_address: input.customer.address ?? null,
      customer_email: input.customer.email ?? null,
      request_text: input.customer.requestText ?? null,
      status: "new",
    })
    .select("id")
    .single();
  if (orderErr || !order) throw new Error(`order insert failed: ${orderErr?.message}`);

  const { data: quote, error: qErr } = await db
    .from("quotations")
    .insert({
      company_id: input.companyId,
      order_id: order.id,
      quote_number: quoteNumber(),
      currency,
      status: "draft",
      public_token: randToken(28),
    })
    .select("id")
    .single();
  if (qErr || !quote) throw new Error(`quotation insert failed: ${qErr?.message}`);

  const itemRows = input.items.map((it) => ({
    quotation_id: quote.id,
    company_id: input.companyId,
    description: it.description,
    quantity: it.quantity || 1,
    currency,
    status: "needs_confirmation" as const,
  }));
  if (itemRows.length) {
    const { error } = await db.from("quotation_items").insert(itemRows);
    if (error) throw new Error(`items insert failed: ${error.message}`);
  }

  const awaitingPrice = await priceQuotation(input.companyId, quote.id, input.routeDepartment ?? "sales");
  return { quotationId: quote.id, orderId: order.id, awaitingPrice };
}

/**
 * Price every unpriced item against the catalog. Items with no catalog price get a
 * `price_confirmation` routed to `routeDepartment`. Updates the quotation status.
 * Returns true if the quotation is still awaiting at least one human price.
 */
export async function priceQuotation(
  companyId: string,
  quotationId: string,
  routeDepartment = "sales",
): Promise<boolean> {
  const db = supabaseAdmin();

  const { data: catalog } = await db
    .from("product_catalog")
    .select("id, name, unit_price, currency")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .not("unit_price", "is", null);

  const { data: items } = await db
    .from("quotation_items")
    .select("id, description, quantity, unit_price, status, currency")
    .eq("quotation_id", quotationId);

  for (const it of items ?? []) {
    if (it.status === "priced" && it.unit_price != null) continue;

    const desc = (it.description ?? "").toLowerCase();
    const match = (catalog ?? []).find((c: any) => {
      const name = (c.name ?? "").toLowerCase();
      return name && (desc === name || desc.includes(name) || name.includes(desc));
    });

    if (match) {
      const line = new Decimal(match.unit_price).times(it.quantity || 1).toFixed(2);
      await db
        .from("quotation_items")
        .update({
          unit_price: match.unit_price,
          currency: match.currency,
          line_total: line,
          status: "priced",
          catalog_id: match.id,
        })
        .eq("id", it.id)
        .eq("company_id", companyId);
    } else {
      // Ensure a single open confirmation for this item.
      const { data: existing } = await db
        .from("price_confirmations")
        .select("id")
        .eq("quotation_item_id", it.id)
        .eq("status", "open")
        .maybeSingle();
      if (!existing) {
        await db.from("price_confirmations").insert({
          company_id: companyId,
          quotation_id: quotationId,
          quotation_item_id: it.id,
          department: routeDepartment,
          description: it.description,
          quantity: it.quantity || 1,
          currency: it.currency ?? "LKR",
          status: "open",
        });
      }
    }
  }

  return await refreshQuotationStatus(companyId, quotationId);
}

/** Recompute totals + status. Returns true if still awaiting a price. */
export async function refreshQuotationStatus(companyId: string, quotationId: string): Promise<boolean> {
  const db = supabaseAdmin();
  const { data: items } = await db
    .from("quotation_items")
    .select("unit_price, line_total, status")
    .eq("quotation_id", quotationId)
    .eq("company_id", companyId);

  const awaiting = (items ?? []).some((i: any) => i.status !== "priced" || i.unit_price == null);
  let subtotal = new Decimal(0);
  for (const i of items ?? []) if (i.line_total != null) subtotal = subtotal.plus(i.line_total);

  await db
    .from("quotations")
    .update({
      subtotal: subtotal.toFixed(2),
      total: subtotal.toFixed(2),
      status: awaiting ? "awaiting_price" : "ready",
    })
    .eq("id", quotationId)
    .eq("company_id", companyId);

  return awaiting;
}

/**
 * If the quotation is fully priced, finalize and WhatsApp it to the customer.
 *
 * WP12 — truthful delivery state. Enqueueing marks the quotation `queued`, NOT `sent`. The
 * quotation only becomes `sent` when the durable outbox row is completed by the fenced
 * `complete_outbox_and_advance` RPC (the inline drain here, or the scheduled sweep). Delivery is
 * AT-LEAST-ONCE: a provider-success / DB-failure window can still cause a retry, so a lease does
 * not make duplicate external delivery impossible. The returned `sent` reflects the quotation's
 * real state after the inline drain; the `DrainResult` is propagated, never swallowed.
 * Idempotent: a repeated finalise re-uses the same outbox row (dedupe key) and never resends.
 */
export async function tryFinalizeAndSend(
  companyId: string,
  quotationId: string,
): Promise<{ sent: boolean; status?: string; reason?: string; drain?: DrainResult }> {
  const db = supabaseAdmin();
  const awaiting = await refreshQuotationStatus(companyId, quotationId);
  if (awaiting) return { sent: false, reason: "awaiting_price" };

  const { data: quote } = await db
    .from("quotations")
    .select("id, quote_number, currency, total, status, public_token, order_id, company_id")
    .eq("id", quotationId)
    .eq("company_id", companyId)
    .single();
  if (!quote) return { sent: false, reason: "not_found" };
  if (quote.status === "sent" || quote.status === "accepted") return { sent: false, reason: "already_sent" };

  const { data: order } = await db
    .from("orders")
    .select("customer_phone, customer_name, conversation_id")
    .eq("id", quote.order_id)
    .eq("company_id", companyId)
    .maybeSingle();

  const to = order?.customer_phone?.replace(/^\+/, "");
  const link = quoteUrl(quote.public_token);
  const total = `${quote.currency} ${Number(quote.total).toLocaleString()}`;
  const body =
    `Thank you${order?.customer_name ? `, ${order.customer_name}` : ""}! ` +
    `Here is your quotation ${quote.quote_number} from Singha.\n\n` +
    `Total: ${total}\n\nView / download your quotation:\n${link}\n\n` +
    `Reply here if you'd like to proceed or have any questions.`;

  if (!to) {
    // No deliverable phone → nothing can be queued; leave the quotation `ready` (truthful).
    return { sent: false, status: quote.status, reason: "no_recipient" };
  }

  // Enqueue to the durable outbox, TAGGED with its source document so the fenced completion can
  // advance the exact quotation. Dedup on the quotation id → a retry/concurrent finalise no-ops.
  await enqueueOutbox({
    channel: "whatsapp",
    companyId,
    recipient: to,
    body,
    dedupeKey: `quotation:${quotationId}`,
    sourceType: "quotation",
    sourceId: quotationId,
    messagePurpose: "quotation",
  });
  if (order?.conversation_id) {
    await db.from("wa_messages").insert({
      conversation_id: order.conversation_id,
      company_id: companyId,
      direction: "outbound",
      body,
      wa_message_id: null,
    });
  }
  // Mark QUEUED, not sent. `sent` (+ order `quoted` + conversation `quoted`) is set only by the
  // fenced RPC when the outbox row is durably completed. Never regress an already sent/accepted quote.
  await db.from("quotations").update({ status: "queued" }).eq("id", quotationId).eq("company_id", companyId).in("status", ["ready", "queued"]);

  // Best-effort inline drain — the completion advances the document truthfully. Propagate the
  // result rather than swallowing it and claiming `sent: true`.
  let drain: DrainResult | undefined;
  try { drain = await drainOutbox(db); } catch { /* the scheduled sweep will recover */ }

  // Truthful state: `sent` iff the outbox row was durably completed and advanced the quotation.
  const { data: after } = await db
    .from("quotations")
    .select("status")
    .eq("id", quotationId)
    .eq("company_id", companyId)
    .single();
  const status = after?.status ?? "queued";
  return { sent: status === "sent", status, drain };
}

/** Resolve a price confirmation from a dashboard, then finalize if ready. */
export async function resolvePriceConfirmation(input: {
  companyId: string;
  confirmationId: string;
  resolvedPrice: number;
  userId: string;
}): Promise<{ finalized: boolean }> {
  const db = supabaseAdmin();
  const { data: conf } = await db
    .from("price_confirmations")
    .select("id, quotation_id, quotation_item_id, status")
    .eq("id", input.confirmationId)
    .eq("company_id", input.companyId)
    .maybeSingle();
  if (!conf || conf.status !== "open") return { finalized: false };

  const { data: item } = await db
    .from("quotation_items")
    .select("id, quantity, currency")
    .eq("id", conf.quotation_item_id)
    .eq("company_id", input.companyId)
    .single();

  const line = new Decimal(input.resolvedPrice).times(item?.quantity || 1).toFixed(2);
  await db
    .from("quotation_items")
    .update({ unit_price: input.resolvedPrice, line_total: line, status: "priced" })
    .eq("id", conf.quotation_item_id)
    .eq("company_id", input.companyId);

  await db
    .from("price_confirmations")
    .update({
      status: "resolved",
      resolved_price: input.resolvedPrice,
      resolved_by: input.userId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", conf.id)
    .eq("company_id", input.companyId);

  const result = await tryFinalizeAndSend(input.companyId, conf.quotation_id);
  return { finalized: result.sent };
}
