/**
 * Inbound dispatch (FOUND-003) — the production path that decides what happens to an inbound
 * message, and the first thing in this codebase that actually calls `ingestSourceEvent`.
 *
 * Before this existed, every inbound WhatsApp message went to customer order intake regardless of
 * who sent it: an employee texting "paid LKR 45,000 to Acme for cement" was asked for a delivery
 * address, and the whole finance consumer pipeline — duplicate scoring, policy evaluation,
 * approval requests — was unreachable in production (recorded as D-009).
 *
 * Order of operations is the security design:
 *   1. resolve identity from TRUSTED RECORDS (never from message wording);
 *   2. classify intent from the text — which may only influence routing WITHIN what the identity
 *      already permits;
 *   3. route deterministically;
 *   4. only the staff_finance route may reach `ingestSourceEvent`, and even then the result is a
 *      persisted event for review — never an accounting entry, a payment or a transfer.
 */
import { ingestSourceEvent, type SourceEventStore, type EventQueue, type StoredSourceEvent } from "@/events/source-event";
import { routeInbound, isFinanceCapture, type ResolvedIdentity, type MessageIntent } from "@/lib/identity/inbound-routing";
import { gateFinanceIntent, type FinanceGateOutcome, type FinanceGateContext } from "@/lib/finance/intent-gate";
import type { FinanceIntent } from "@/schemas/finance-intent";
import { log } from "@/lib/log";

export interface InboundMessage {
  companyId: string;
  channel: "whatsapp" | "email";
  /** The sender's channel identity as the provider gave it (phone number / address). */
  from: string;
  text: string;
  providerMessageId: string;
  rawPayload: unknown;
  /**
   * The canonical receipt this message was already persisted as (migration 0076). Production always
   * supplies it; without it the dispatcher would persist a SECOND row for the same message.
   */
  receipt?: StoredSourceEvent;
}

export interface DispatchDeps {
  /** Trusted identity lookup — the `resolve_channel_identity` RPC in production. */
  resolveIdentity(companyId: string, channel: string, from: string): Promise<ResolvedIdentity>;
  /** Classify the message. Returns null when no classifier is available (no model configured). */
  classifyFinanceIntent(text: string): Promise<FinanceIntent | null>;
  /** The existing customer order-intake flow. */
  handleCustomerOrder(msg: InboundMessage): Promise<{ status: string }>;
  /**
   * Record a message that needs a person, without pretending it was handled. `reasonCode` is a
   * stable machine key for the queue and for metrics; `reason` is the human sentence beside it.
   */
  recordForReview(msg: InboundMessage, reason: string, identity: ResolvedIdentity, reasonCode: ReviewReasonCode): Promise<void>;
  /** Ask the sender one specific question. */
  askClarification(msg: InboundMessage, question: string): Promise<void>;
  store: SourceEventStore;
  queue: EventQueue;
  financeContext: FinanceGateContext;
  /**
   * Idempotently record the finance capture against the existing receipt, reporting whether it was
   * ALREADY recorded. Required whenever `msg.receipt` is present — half-wiring the two is a
   * configuration error and fails loudly rather than quietly persisting a duplicate.
   */
  markCapture?(eventId: string): Promise<{ alreadyCaptured: boolean }>;
}

/**
 * Why a message needs a person. A closed set, so the queue can be filtered, counted and reasoned
 * about — a free-text reason alone cannot be.
 */
export type ReviewReasonCode =
  | "no_finance_classifier"
  | "unroutable_identity"
  | "supplier_message"
  | "staff_other"
  | "not_finance_capture"
  | "finance_gate_manual_review";

export type DispatchResult =
  | { handled: "customer_order"; status: string }
  | { handled: "staff_finance"; sourceEventId: string; ingest: "enqueued" | "duplicate"; gate: FinanceGateOutcome }
  | { handled: "clarification"; question: string }
  | { handled: "manual_review"; reason: string }
  | { handled: "recorded"; reason: string };

export async function dispatchInbound(msg: InboundMessage, deps: DispatchDeps): Promise<DispatchResult> {
  // 1. Identity FIRST, from trusted records.
  const identity = await deps.resolveIdentity(msg.companyId, msg.channel, msg.from);

  // 2. Intent is only classified when identity could make it matter. A customer's message never
  //    needs a finance classification, and not asking is cheaper and safer than asking and ignoring.
  let intent: FinanceIntent | null = null;
  let messageIntent: MessageIntent = "other";
  if (identity.actorType === "staff") {
    intent = await deps.classifyFinanceIntent(msg.text);
    if (intent === null) {
      // No classifier configured. A staff message must NOT fall through to order intake, and we
      // must not guess that it is routine — a person looks at it.
      await deps.recordForReview(msg, "no finance classifier configured", identity, "no_finance_classifier");
      return { handled: "manual_review", reason: "no finance classifier configured" };
    }
    messageIntent = intent.kind === "none" ? "other" : "finance";
  }

  // 3. Deterministic routing.
  const route = routeInbound(identity, messageIntent);

  if (route.route === "customer_order") {
    const res = await deps.handleCustomerOrder(msg);
    return { handled: "customer_order", status: res.status };
  }

  if (route.route === "manual_review" || route.route === "supplier_message" || route.route === "staff_other") {
    const code: ReviewReasonCode =
      route.route === "supplier_message" ? "supplier_message"
        : route.route === "staff_other" ? "staff_other"
          : "unroutable_identity";
    await deps.recordForReview(msg, route.reason, identity, code);
    return route.route === "manual_review"
      ? { handled: "manual_review", reason: route.reason }
      : { handled: "recorded", reason: route.reason };
  }

  // 4. staff_finance. Second gate: nothing but this route may proceed.
  if (!isFinanceCapture(route.route)) {
    await deps.recordForReview(msg, "route is not finance capture", identity, "not_finance_capture");
    return { handled: "manual_review", reason: "route is not finance capture" };
  }

  const gate = gateFinanceIntent(intent!, deps.financeContext);

  if (gate.outcome === "clarify") {
    await deps.askClarification(msg, gate.question);
    return { handled: "clarification", question: gate.question };
  }
  if (gate.outcome === "manual_review") {
    await deps.recordForReview(msg, gate.reasons.join("; "), identity, "finance_gate_manual_review");
    return { handled: "manual_review", reason: gate.reasons.join("; ") };
  }

  // Capture. This persists the event and enqueues it for the policy/authority pipeline. It does not
  // post anything, pay anything or approve anything.
  if (Boolean(msg.receipt) !== Boolean(deps.markCapture)) {
    // One without the other means either a duplicate row (receipt ignored) or a capture that can
    // never be marked. Neither may happen silently.
    throw new Error("inbound capture is half-wired: msg.receipt and deps.markCapture must be supplied together");
  }

  const result = await ingestSourceEvent(
    {
      source: msg.channel === "whatsapp" ? "whatsapp" : "email",
      providerMessageId: msg.providerMessageId,
      rawPayload: msg.rawPayload,
      body: msg.text,
      companyId: msg.companyId,
    },
    deps.store,
    deps.queue,
    msg.receipt && deps.markCapture ? { event: msg.receipt, markCapture: deps.markCapture } : undefined,
  );

  log("info", "staff finance message captured for policy evaluation", {
    event: "inbound.finance_captured",
    sourceEventId: result.event.id,
    companyId: msg.companyId,
    ingest: result.status,
    amountCurrency: `${gate.amount} ${gate.currency}`,
  });

  return { handled: "staff_finance", sourceEventId: result.event.id, ingest: result.status, gate };
}
