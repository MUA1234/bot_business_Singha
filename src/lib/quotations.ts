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
import { outboundIdempotencyKey } from "@/events/outbox";
import { drainOutbox, type DrainResult } from "@/events/outbox-drain";
import { log } from "@/lib/log";
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
 * Format a monetary total for display WITHOUT a lossy JavaScript Number conversion. The DB returns
 * `numeric` as a string; `new Decimal()` parses it exactly, `toFixed(2)` fixes the scale, and the
 * thousands separators are applied with a string-only regex — the value never passes through a
 * binary float. (Totals are non-negative here.)
 */
function formatMoney(total: string | number | null | undefined): string {
  const parts = new Decimal(total ?? 0).toFixed(2).split("."); // always "int.frac" (2dp)
  const int = parts[0] ?? "0";
  const frac = parts[1] ?? "00";
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

// Currency comparison used for item completeness — trim (char(3) padding) + case only. Deliberately NO
// conversion of any kind: two currencies either match or the item goes to the human pricing flow.
function normalizeCurrency(c: string | null | undefined): string {
  return String(c ?? "").trim().toUpperCase();
}

/**
 * Match a requested line description to a catalogue entry for AUTO-pricing.
 *
 * Both the description and the quantity on a customer-originated line come from the model's
 * reading of a WhatsApp message, so both are effectively chosen by the sender. The previous
 * predicate also matched `name.includes(desc)` — the reverse direction — which meant a one- or
 * two-character description matched almost every catalogue row, and `.find()` then returned
 * whichever row the (unordered) query happened to put first. The sender could therefore steer
 * which unit price was applied to a line they described in words.
 *
 * Only the safe direction is kept: an exact name, or a description that CONTAINS the catalogue
 * name ("5x Premium Steel Beam" → "Premium Steel Beam"). Anything else is not auto-priced — it
 * goes to a human price confirmation, which is the designed fallback, not a failure.
 *
 * That alone is NOT sufficient, because a catalogue holding both "Beam" and "Premium Steel Beam"
 * leaves "5x Premium Steel Beam" containing BOTH names, and the query has no ORDER BY — so which
 * price applied was still decided by row order, and a sender could retry phrasings until the cheap
 * short name won. Two further rules close that:
 *   - the LONGEST (most specific) matching name wins, never row order;
 *   - if two matching entries of the same specificity disagree on price, the line is AMBIGUOUS and
 *     is refused, so a human prices it rather than the system picking one.
 */
export function matchCatalogueEntry<T extends { name?: string | null; unit_price?: unknown }>(
  description: string | null | undefined,
  catalog: T[],
): T | undefined {
  const desc = String(description ?? "").trim().toLowerCase();
  if (!desc) return undefined;

  const named = (c: T) => String(c.name ?? "").trim().toLowerCase();
  const matches = catalog.filter((c) => {
    const name = named(c);
    return name !== "" && (desc === name || desc.includes(name));
  });
  if (matches.length === 0) return undefined;

  // Most specific first — deterministic, independent of the order the rows came back in.
  const ranked = [...matches].sort((a, b) => named(b).length - named(a).length);
  const best = ranked[0]!;
  const tied = ranked.filter((c) => named(c).length === named(best).length);
  const prices = new Set(tied.map((c) => String(c.unit_price ?? "")));
  if (prices.size > 1) return undefined; // genuinely ambiguous → a human decides

  return best;
}

/**
 * May this quantity be used to auto-price a line without a human?
 *
 * `QuotationTurn.items[].quantity` is `z.number().positive()`, so 0.001 and 1e6 both validate,
 * and the value was previously multiplied straight into the line total — letting the sender pick
 * an arbitrary fraction of a catalogue price and still reach a `ready`, auto-sent quotation. The
 * money helper `lineTotal()` has always truncated quantities to a non-negative integer for exactly
 * this reason; the customer-facing path simply did not use it.
 *
 * A quantity that is not a finite positive whole number within a sane bound is not auto-priceable.
 * Such a line is routed to a human instead of being silently reinterpreted.
 */
export function isAutoPriceableQuantity(q: unknown): boolean {
  const n = typeof q === "number" ? q : Number(q);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 && n <= 1_000_000;
}

/** The integer quantity used for an auto-priced line (only valid when isAutoPriceableQuantity). */
export function autoPriceQuantity(q: unknown): number {
  const n = typeof q === "number" ? q : Number(q);
  return Math.max(0, Math.trunc(n));
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

  // The quotation's currency governs the whole document: the public quotation renders every item in it,
  // and the enqueue guard (migration 0067) refuses any item whose currency disagrees with it.
  const { data: quo } = await db
    .from("quotations")
    .select("currency")
    .eq("id", quotationId)
    .eq("company_id", companyId)
    .single();
  const qCurrency = normalizeCurrency(quo?.currency);

  const { data: catalog } = await db
    .from("product_catalog")
    .select("id, name, unit_price, currency")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .not("unit_price", "is", null);

  const { data: items } = await db
    .from("quotation_items")
    .select("id, description, quantity, unit_price, line_total, status, currency")
    .eq("quotation_id", quotationId);

  for (const it of items ?? []) {
    // Skip only a COMPLETE line — the same completeness predicate refreshQuotationStatus and the DB
    // enqueue guard use. A legacy item priced in a non-quotation currency (or with a NULL line_total)
    // must RE-ENTER pricing here — same-currency catalogue match → repriced in the quotation currency;
    // otherwise → a human price confirmation — instead of wedging in awaiting_price with no exit.
    if (
      it.status === "priced" &&
      it.unit_price != null &&
      it.line_total != null &&
      normalizeCurrency(it.currency) === qCurrency
    )
      continue;

    const match = matchCatalogueEntry(it.description, catalog ?? []);

    // Auto-price ONLY from a catalogue entry in the QUOTATION's currency. A price in any other
    // currency is NOT copied (no implicit conversion — that would silently misprice the document);
    // it is routed to a human price confirmation in the quotation's currency instead.
    if (match && normalizeCurrency(match.currency) === qCurrency && qCurrency !== "" && isAutoPriceableQuantity(it.quantity)) {
      const line = new Decimal(match.unit_price).times(autoPriceQuantity(it.quantity)).toFixed(2);
      await db
        .from("quotation_items")
        .update({
          unit_price: match.unit_price,
          currency: qCurrency,
          line_total: line,
          status: "priced",
          catalog_id: match.id,
        })
        .eq("id", it.id)
        .eq("company_id", companyId);
    } else {
      // Ensure a single open confirmation for this item — priced in the QUOTATION currency (that is
      // the currency the confirmed number will be used in; the item's own stale currency is not shown).
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
          currency: qCurrency || (it.currency ?? "LKR"),
          status: "open",
        });
      }
    }
  }

  return await refreshQuotationStatus(companyId, quotationId);
}

/**
 * Recompute totals + status. Returns true if still awaiting a price.
 *
 * WP12 hard guard: this NEVER changes a `queued` or terminal (`sent`/`accepted`/`rejected`)
 * quotation's status — only `draft`/`awaiting_price`/`ready` are re-derived. Totals are always
 * refreshed. This holds regardless of the caller, so a mispriced refresh cannot resurrect or resend
 * a document that has already left the pricing stage.
 */
export async function refreshQuotationStatus(companyId: string, quotationId: string): Promise<boolean> {
  const db = supabaseAdmin();
  // The quotation currency is part of item completeness: an item priced in a different currency (e.g. a
  // catalogue currency copied before this rule existed) must NOT count as ready — the public quotation
  // renders every item in the quotation currency, and the enqueue guard (0067) refuses the mismatch.
  const { data: quo } = await db
    .from("quotations")
    .select("currency")
    .eq("id", quotationId)
    .eq("company_id", companyId)
    .single();
  if (!quo) return true; // quotation gone (concurrent delete) → nothing to mark ready; treat as awaiting
  const qCurrency = normalizeCurrency(quo.currency);

  const { data: items } = await db
    .from("quotation_items")
    .select("unit_price, line_total, status, currency")
    .eq("quotation_id", quotationId)
    .eq("company_id", companyId);

  // COMPLETE item = priced + non-null unit_price + non-null line_total + quotation-currency match.
  // Anything less keeps the quotation in `awaiting_price` (the human pricing flow) — mirrored 1:1 by the
  // DB-level enqueue guard, which returns `stale` for the same conditions (no float, no conversion).
  const awaiting = (items ?? []).some(
    (i: any) =>
      i.status !== "priced" ||
      i.unit_price == null ||
      i.line_total == null ||
      normalizeCurrency(i.currency) !== qCurrency,
  );
  let subtotal = new Decimal(0);
  for (const i of items ?? []) if (i.line_total != null) subtotal = subtotal.plus(i.line_total);

  // Concurrency-safe: the allowed-current-status condition is ON THE UPDATE itself, so a `queued`
  // or terminal (`sent`/`accepted`/`rejected`) quotation receives ZERO mutations (status AND totals)
  // even if it transitions concurrently between our read and this write — the UPDATE simply matches
  // no row.
  await db
    .from("quotations")
    .update({ subtotal: subtotal.toFixed(2), total: subtotal.toFixed(2), status: awaiting ? "awaiting_price" : "ready" })
    .eq("id", quotationId)
    .eq("company_id", companyId)
    .in("status", ["draft", "awaiting_price", "ready"]);
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

  // Read the CURRENT status FIRST — before any price refresh — so the legal state machine is honoured
  // (draft → awaiting_price → ready → queued → sent; accepted/rejected terminal).
  const { data: quote } = await db
    .from("quotations")
    .select("status")
    .eq("id", quotationId)
    .eq("company_id", companyId)
    .single();
  if (!quote) return { sent: false, reason: "not_found" };

  // Terminal states never mutate and never (re)send.
  if (quote.status === "sent" || quote.status === "accepted" || quote.status === "rejected") {
    return { sent: quote.status === "sent", status: quote.status, reason: "terminal" };
  }

  // Refresh pricing ONLY for pre-queue states; a `queued` quotation is never re-priced or reset.
  if (quote.status !== "queued") {
    const awaiting = await refreshQuotationStatus(companyId, quotationId);
    if (awaiting) return { sent: false, status: "awaiting_price", reason: "awaiting_price" };
  }

  // RE-READ the authoritative state AFTER the guarded refresh — NEVER assume `ready` just because
  // refreshQuotationStatus returned awaiting=false. Its UPDATE is guarded (a no-op if the row moved
  // concurrently), so between the first read and here the quotation may have gone queued/sent/
  // accepted/rejected, and its total may have been recomputed. Both status AND total come from here.
  const { data: fresh } = await db
    .from("quotations")
    .select("status, total, currency, quote_number, public_token, order_id")
    .eq("id", quotationId)
    .eq("company_id", companyId)
    .single();
  if (!fresh) return { sent: false, reason: "not_found" };
  const curStatus = fresh.status as string;

  // Terminal after the refresh → STOP with zero enqueue/send.
  if (curStatus === "sent" || curStatus === "accepted" || curStatus === "rejected") {
    return { sent: curStatus === "sent", status: curStatus, reason: "terminal" };
  }
  // Only `ready` (freshly priced) or `queued` (already enqueued once) may proceed. A concurrent
  // re-price could leave it `awaiting_price`/`draft` — not sendable now, and never enqueued.
  if (curStatus !== "ready" && curStatus !== "queued") {
    return { sent: false, status: curStatus, reason: curStatus === "awaiting_price" ? "awaiting_price" : "not_ready" };
  }

  const { data: order } = await db
    .from("orders")
    .select("customer_phone, customer_name, conversation_id")
    .eq("id", fresh.order_id)
    .eq("company_id", companyId)
    .maybeSingle();
  const to = order?.customer_phone?.replace(/^\+/, "");
  if (!to) {
    // No deliverable phone → nothing can be queued; leave the quotation retryable (truthful).
    return { sent: false, status: curStatus, reason: "no_recipient" };
  }

  // Build the message from the FRESHLY-persisted total (not the pre-refresh read), formatted without
  // a lossy JavaScript Number conversion (see formatMoney).
  const link = quoteUrl(fresh.public_token);
  const total = `${fresh.currency} ${formatMoney(fresh.total)}`;
  const body =
    `Thank you${order?.customer_name ? `, ${order.customer_name}` : ""}! ` +
    `Here is your quotation ${fresh.quote_number} from Singha.\n\n` +
    `Total: ${total}\n\nView / download your quotation:\n${link}\n\n` +
    `Reply here if you'd like to proceed or have any questions.`;
  const dedupeKey = `quotation:${quotationId}`;

  // ATOMIC enqueue (migration 0063 `enqueue_quotation_outbox`). A single service-only RPC LOCKS the
  // company-scoped quotation row, inspects the authoritative status UNDER THAT LOCK, verifies the body's
  // total/currency still match the locked row, and — only if still legally `ready` — inserts the outbox
  // row AND advances ready→queued in ONE transaction. This closes the previous time-of-check/time-of-use
  // window: a concurrent terminal transition can no longer leave a live pending row (there is no
  // application re-read between the check and the insert). The linearization point is the row lock.
  const key = outboundIdempotencyKey("whatsapp", dedupeKey);
  const { data: enq, error: enqErr } = await db.rpc("enqueue_quotation_outbox", {
    p_company: companyId,
    p_quotation: quotationId,
    p_recipient: to,
    p_body: body,
    p_idempotency_key: key,
    p_expected_total: fresh.total,
    p_expected_currency: fresh.currency,
    p_channel: "whatsapp",
    p_message_purpose: "quotation",
  });
  if (enqErr || !enq) {
    // No durable record written → keep the quotation retryable; never claim queued/sent.
    log("error", "atomic quotation enqueue failed", { event: "quotation.enqueue_failed", quotationId, error: enqErr?.message ?? "no result" });
    return { sent: false, status: curStatus, reason: "enqueue_unavailable" };
  }
  // Results that MUST NOT drain or send — the atomic operation created no sendable row for this caller.
  if (enq === "terminal") {
    const { data: t } = await db.from("quotations").select("status").eq("id", quotationId).eq("company_id", companyId).single();
    const st = (t?.status as string) ?? "sent";
    return { sent: st === "sent", status: st, reason: "terminal" };
  }
  if (enq === "not_ready") return { sent: false, status: curStatus, reason: "not_ready" };
  if (enq === "stale") return { sent: false, status: curStatus, reason: "stale" }; // total moved under the lock; retryable
  if (enq === "inconsistent") {
    log("error", "atomic quotation enqueue inconsistent", { event: "quotation.outbox_source_inconsistent", quotationId, idempotencyKey: key });
    return { sent: false, status: curStatus, reason: "outbox_source_inconsistent" };
  }
  // enq is 'enqueued' or 'duplicate' → a durable row for THIS (company, quotation, key) exists and the
  // quotation is now `queued`. Load that exact row and reconcile/drain it by its real state (below).
  const { data: ob } = await db
    .from("message_outbox")
    .select("id, status")
    .eq("company_id", companyId)
    .eq("idempotency_key", key)
    .eq("source_type", "quotation")
    .eq("source_id", quotationId)
    .maybeSingle();
  if (!ob) {
    // enqueued/duplicate but no company+source-scoped row exists → fail closed; never claim queued/sent.
    return { sent: false, status: curStatus, reason: "outbox_not_found" };
  }

  // Reconcile by the outbox row's REAL state — each state a distinct, truthful outcome. Message
  // history is written only by the fenced completion RPC (never here), so a queued item is never
  // shown as sent.
  let drain: DrainResult | undefined;
  let drainFailed = false;
  let reason: string | undefined;
  if (ob.status === "sent") {
    // Provider already succeeded. Normally the completion RPC advanced the quotation atomically, so
    // it is already `sent`. If it lags (outbox sent, quotation not sent), reconcile through the
    // idempotent service-only RPC; if that cannot make them consistent, FAIL CLOSED with
    // `outbox_source_inconsistent` + operator-visible logging. NEVER return already_sent with sent=false.
    const { data: q0 } = await db.from("quotations").select("status").eq("id", quotationId).eq("company_id", companyId).single();
    if (q0?.status === "sent") return { sent: true, status: "sent", reason: "already_sent" };
    const { data: ok } = await db.rpc("reconcile_quotation_from_outbox", { p_outbox_id: ob.id });
    const { data: q1 } = await db.from("quotations").select("status").eq("id", quotationId).eq("company_id", companyId).single();
    if (ok === true && q1?.status === "sent") return { sent: true, status: "sent", reason: "reconciled" };
    log("error", "outbox sent but quotation not reconciled", { event: "quotation.outbox_source_inconsistent", quotationId, outboxId: ob.id, quotationStatus: q1?.status ?? null });
    return { sent: false, status: q1?.status ?? curStatus, reason: "outbox_source_inconsistent" };
  } else if (ob.status === "dead") {
    reason = "dead";               // permanently failed — visible for operator recovery; no drain.
  } else if (ob.status === "processing") {
    reason = "processing";         // another worker holds the lease; let it complete. No drain.
  } else {
    // pending or failed(due) → attempt an inline drain to progress delivery.
    try { drain = await drainOutbox(db); } catch { drainFailed = true; }
  }

  // Truthful final state: `sent` iff the durable completion advanced the quotation to `sent`.
  const { data: after } = await db
    .from("quotations")
    .select("status")
    .eq("id", quotationId)
    .eq("company_id", companyId)
    .single();
  const status = after?.status ?? curStatus;
  return { sent: status === "sent", status, drain, reason: drainFailed ? "drain_failed" : reason };
}

/** Resolve a price confirmation from a dashboard, then finalize if ready. */
export async function resolvePriceConfirmation(input: {
  companyId: string;
  confirmationId: string;
  /** Canonical non-negative decimal STRING (e.g. "1450.50") — money never rides a JS float. */
  resolvedPrice: string;
  userId: string;
}): Promise<{ finalized: boolean }> {
  if (!/^\d+(\.\d+)?$/.test(input.resolvedPrice)) return { finalized: false }; // fail closed on malformed money
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

  // The human confirms the price in the QUOTATION's currency (that is how the confirmation was posed and
  // how the public quotation renders the line), so the resolution stamps the item to that currency — a
  // stale catalogue-copied currency would otherwise keep the quotation out of `ready` forever.
  const { data: quoForCurrency } = await db
    .from("quotations")
    .select("currency")
    .eq("id", conf.quotation_id)
    .eq("company_id", input.companyId)
    .single();

  const line = new Decimal(input.resolvedPrice).times(item?.quantity || 1).toFixed(2);
  await db
    .from("quotation_items")
    .update({
      unit_price: input.resolvedPrice,
      line_total: line,
      status: "priced",
      ...(quoForCurrency?.currency ? { currency: normalizeCurrency(quoForCurrency.currency) } : {}),
    })
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
