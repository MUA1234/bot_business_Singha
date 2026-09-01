/**
 * Management-item lifecycle (R1 — KRN-001).
 *
 * The loop is a PERSISTED STATE MACHINE, not a function call: it survives restarts, can be
 * resumed, can be supervised in flight, and produces an audit trail. This mirrors the
 * discipline `src/modules/work/task-lifecycle.ts` already applies to tasks — deliberately
 * the same shape, because that pattern is proven and tested here.
 *
 * This module is PURE. It has no database, no clock and no I/O, so every rule below is
 * directly testable. The identical transition map is enforced a second time at the database
 * boundary by `r1_draft_transition_item()`, so a direct writer cannot bypass it; the two are
 * pinned to each other by tests.
 */

/**
 * The 16 states.
 *
 * The R1 architecture specified 15. Owner decision R1-D-3 added `needs_routing`: when no
 * suitable authorised assignee can be recommended, the item must go to a department queue
 * with a recorded reason — never silently to the owner or an administrator.
 */
export type ItemState =
  | "observed"
  | "understood"
  | "prioritised"
  | "recommended"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "needs_routing"
  | "assigned"
  | "monitoring"
  | "escalated"
  | "verifying"
  | "verified"
  | "reopened"
  | "dismissed"
  | "expired";

export const ITEM_STATES: readonly ItemState[] = [
  "observed", "understood", "prioritised", "recommended",
  "awaiting_approval", "approved", "rejected",
  "needs_routing", "assigned", "monitoring", "escalated",
  "verifying", "verified", "reopened", "dismissed", "expired",
] as const;

/**
 * Legal transitions (from → allowed next states).
 *
 * `recommended → assigned` skips approval ONLY when the resolved authority is `automatic`
 * and the action is catalogue-registered as low-risk and reversible (owner decision D-9).
 * That condition is not expressible in a transition map, so it is asserted separately by
 * `assertTransition`, which takes the authority context.
 */
const TRANSITIONS: Record<ItemState, ItemState[]> = {
  observed: ["understood", "dismissed", "expired"],
  understood: ["prioritised", "dismissed", "expired"],
  prioritised: ["recommended", "dismissed", "expired"],
  recommended: ["awaiting_approval", "needs_routing", "assigned", "dismissed", "expired"],
  awaiting_approval: ["approved", "rejected", "expired"],
  approved: ["needs_routing", "assigned", "expired"],
  needs_routing: ["assigned", "escalated", "dismissed", "expired"],
  assigned: ["monitoring", "escalated", "dismissed"],
  monitoring: ["verifying", "escalated", "dismissed"],
  escalated: ["monitoring", "verifying", "needs_routing", "dismissed"],
  verifying: ["verified", "reopened"],
  reopened: ["prioritised", "assigned", "needs_routing", "dismissed"],
  verified: [],
  rejected: [],
  dismissed: [],
  expired: [],
};

/** States from which nothing may follow. */
export const TERMINAL_STATES: readonly ItemState[] = ["verified", "rejected", "dismissed", "expired"] as const;

/**
 * States that require a recorded reason to enter.
 *
 * The reason is not bureaucracy — it is the single highest-value learning signal the system
 * can collect (IMP-001). "Why did a human reject this?" is what makes the next
 * recommendation better. A blank reason is refused.
 */
export const REASON_REQUIRED_STATES: readonly ItemState[] = ["dismissed", "rejected"] as const;

/**
 * States an item may only enter with at least one evidence reference.
 *
 * The zero-evidence prohibition: an item cannot be recommended, approved, assigned,
 * monitored or verified on the strength of nothing. Enforced here AND by the
 * `management_items_require_evidence` trigger.
 */
export const EVIDENCE_REQUIRED_STATES: readonly ItemState[] = [
  "recommended", "awaiting_approval", "approved",
  "needs_routing", "assigned", "monitoring", "escalated", "verifying", "verified",
] as const;

export function isTerminal(state: ItemState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function allowedTransitions(from: ItemState): ItemState[] {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(from: ItemState, to: ItemState): boolean {
  return allowedTransitions(from).includes(to);
}

export function requiresReason(to: ItemState): boolean {
  return REASON_REQUIRED_STATES.includes(to);
}

export function requiresEvidence(to: ItemState): boolean {
  return EVIDENCE_REQUIRED_STATES.includes(to);
}

/** Authority levels, matching `src/policy/authority-engine.ts`. Not redefined — mirrored. */
export type AuthorityLevel =
  | "automatic"
  | "policy_controlled"
  | "manager_approval"
  | "specialist_approval"
  | "owner_approval";

export interface TransitionContext {
  /** Resolved by the existing authority engine — never by a model. */
  authority?: AuthorityLevel;
  /** Is the proposed action registered in the catalogue as low-risk AND reversible? */
  actionIsAutomaticSafe?: boolean;
  /** Non-empty reason supplied by the actor. */
  reason?: string | null;
  /** How many evidence references the item holds. */
  evidenceCount?: number;
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: ItemState,
    readonly to: ItemState,
    message: string,
  ) {
    super(message);
    this.name = "IllegalTransitionError";
  }
}

/**
 * Assert a transition is legal, throwing `IllegalTransitionError` if not.
 *
 * Checked, in order:
 *   1. the transition exists in the map (terminal states allow nothing);
 *   2. `recommended → assigned` bypasses approval only at `automatic` authority with a
 *      catalogue-registered low-risk reversible action (D-9);
 *   3. `dismissed`/`rejected` carry a non-blank reason;
 *   4. evidence-requiring states have at least one evidence reference.
 *
 * An illegal transition THROWS. It is never silently ignored — a state machine that
 * quietly declines to move is indistinguishable from one that is broken.
 */
export function assertTransition(from: ItemState, to: ItemState, ctx: TransitionContext = {}): void {
  if (isTerminal(from)) {
    throw new IllegalTransitionError(from, to, `"${from}" is terminal — no transition to "${to}" is possible`);
  }
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(
      from,
      to,
      `illegal transition "${from}" -> "${to}" (allowed: ${allowedTransitions(from).join(", ") || "none"})`,
    );
  }

  if (from === "recommended" && to === "assigned") {
    if (ctx.authority !== "automatic" || ctx.actionIsAutomaticSafe !== true) {
      throw new IllegalTransitionError(
        from,
        to,
        "approval may only be skipped at `automatic` authority for a catalogue-registered low-risk reversible action (D-9); route via awaiting_approval",
      );
    }
  }

  if (requiresReason(to) && !(ctx.reason ?? "").trim()) {
    throw new IllegalTransitionError(from, to, `transition to "${to}" requires a reason`);
  }

  if (requiresEvidence(to) && (ctx.evidenceCount ?? 0) < 1) {
    throw new IllegalTransitionError(
      from,
      to,
      `transition to "${to}" requires at least one evidence reference (zero-evidence prohibition)`,
    );
  }
}

/** Terminal outcome implied by a terminal state, matching the database's own mapping. */
export function outcomeFor(state: ItemState): "resolved" | "rejected" | "dismissed" | "expired" | null {
  switch (state) {
    case "verified":
      return "resolved";
    case "rejected":
      return "rejected";
    case "dismissed":
      return "dismissed";
    case "expired":
      return "expired";
    default:
      return null;
  }
}
