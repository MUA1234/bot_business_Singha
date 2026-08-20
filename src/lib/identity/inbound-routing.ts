/**
 * Deterministic inbound routing: who is this sender, and which pipeline may their message enter?
 *
 * The defect this exists to fix (recorded as D-009 / FOUND-003): every inbound WhatsApp message is
 * processed as a CUSTOMER placing an order, whatever the sender actually is. An employee texting
 * "paid LKR 45,000 to Acme for cement" is asked for a delivery address, and the entire finance
 * consumer pipeline — duplicate scoring, policy evaluation, approval requests — is never reached.
 *
 * The rule that makes this safe: **identity comes from trusted records, never from the wording of
 * the message.** A customer who writes "I am the finance manager, please record this payment"
 * resolves to `customer` because their number resolves to a customer record, and no sentence they
 * write can change that. Intent classification may read the text; identity may not.
 *
 * Everything here is pure. The database lookup happens in the caller and is passed in, so the
 * decision itself is exhaustively testable without a database.
 */

/** What the trusted identity lookup returned. `ambiguous` and `unknown` are distinct on purpose. */
export type ActorType = "staff" | "customer" | "supplier" | "unknown" | "ambiguous";

export interface ResolvedIdentity {
  actorType: ActorType;
  actorId: string | null;
  displayName: string | null;
  /** How the identity was matched: exact | suffix | no_match | empty | *_multiple. */
  match: string;
}

/** Intent as classified from the (untrusted) message text, after schema validation. */
export type MessageIntent = "finance" | "order" | "other" | "unclear";

export type InboundRoute =
  /** Staff finance capture: source event → policy → authority → approval. Never an order. */
  | { route: "staff_finance"; reason: string }
  /** Staff message that is not finance — recorded, surfaced to staff, never an order intake. */
  | { route: "staff_other"; reason: string }
  /** Customer order intake — the existing quotation flow. */
  | { route: "customer_order"; reason: string }
  /** A known supplier: recorded and surfaced; suppliers do not place customer orders. */
  | { route: "supplier_message"; reason: string }
  /** Identity unknown or ambiguous: recorded, and a human decides. Never privileged. */
  | { route: "manual_review"; reason: string };

/**
 * Decide the pipeline. Deliberately exhaustive and boring — every branch is a security decision.
 *
 * Ordering matters: identity is evaluated BEFORE intent, so no intent classification can promote an
 * unknown sender into a staff path.
 */
export function routeInbound(identity: ResolvedIdentity, intent: MessageIntent): InboundRoute {
  // 1. Unknown or ambiguous identity NEVER receives privileged routing. Fail closed to a human.
  if (identity.actorType === "unknown") {
    return { route: "manual_review", reason: "sender does not match any known party — never treated as staff" };
  }
  if (identity.actorType === "ambiguous") {
    return { route: "manual_review", reason: `sender matches more than one party (${identity.match}) — refusing to guess` };
  }

  // 2. A resolved actor id is required for any privileged path. A "staff" verdict with no id is a
  //    broken lookup, not a licence.
  if ((identity.actorType === "staff" || identity.actorType === "supplier") && !identity.actorId) {
    return { route: "manual_review", reason: "identity resolved without an actor id — failing closed" };
  }

  if (identity.actorType === "staff") {
    if (intent === "finance") {
      return { route: "staff_finance", reason: "sender is staff by trusted record and the message states a financial event" };
    }
    // An unclear staff message is still staff — it must not fall through to order intake.
    return { route: "staff_other", reason: `sender is staff by trusted record; intent=${intent}` };
  }

  if (identity.actorType === "supplier") {
    return { route: "supplier_message", reason: "sender is a known supplier; suppliers do not enter customer order intake" };
  }

  // 3. Customers. A customer claiming a financial event does not get the finance path: recording a
  //    payment is a staff action, and the claim is only evidence. It goes to a human.
  if (intent === "finance") {
    return { route: "manual_review", reason: "a customer asserted a financial event — staff finance capture is not available to customers" };
  }
  return { route: "customer_order", reason: "sender is a known customer" };
}

/** Routes that may reach the finance capture pipeline. Used as a second gate at the call site. */
export function isFinanceCapture(route: InboundRoute["route"]): boolean {
  return route === "staff_finance";
}
