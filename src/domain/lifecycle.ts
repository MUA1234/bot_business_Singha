/**
 * Financial-event lifecycle state machine. Guide §6.
 *
 * The AI may *recommend* a transition, but only backend rules may *write* a state.
 * Any transition not in the ALLOWED table is rejected — the AI can never push an
 * event into an arbitrary state (guide §6, core principle #8).
 */
import { fail, ok, type Result } from "@/lib/result";

export const FINANCIAL_EVENT_STATES = [
  "detected",
  "draft",
  "awaiting_information",
  "awaiting_evidence",
  "awaiting_approval",
  "approved",
  "posted",
  "bank_matched",
  "reconciled",
  "locked",
  // terminal / corrective
  "rejected",
  "cancelled",
  "duplicate",
  "reversed",
  "superseded",
] as const;

export type FinancialEventState = (typeof FINANCIAL_EVENT_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<FinancialEventState> = new Set([
  "rejected",
  "cancelled",
  "duplicate",
  "reversed",
  "superseded",
  "locked",
]);

/**
 * Allowed transitions. The happy path plus every legitimate branch. Anything
 * absent here is a hard reject. Corrective states are reachable from most active
 * states because a human can always reject/cancel/mark-duplicate before posting.
 */
const ALLOWED: Record<FinancialEventState, ReadonlySet<FinancialEventState>> = {
  detected: new Set(["draft", "duplicate", "cancelled"]),
  draft: new Set(["awaiting_information", "awaiting_evidence", "awaiting_approval", "duplicate", "cancelled", "rejected"]),
  awaiting_information: new Set(["draft", "awaiting_evidence", "awaiting_approval", "cancelled", "rejected", "duplicate"]),
  awaiting_evidence: new Set(["draft", "awaiting_information", "awaiting_approval", "cancelled", "rejected", "duplicate"]),
  awaiting_approval: new Set(["approved", "rejected", "awaiting_information", "awaiting_evidence", "cancelled"]),
  approved: new Set(["posted", "cancelled", "superseded"]),
  posted: new Set(["bank_matched", "reversed", "superseded"]),
  bank_matched: new Set(["reconciled", "reversed"]),
  reconciled: new Set(["locked", "reversed"]),
  locked: new Set([]), // terminal for ordinary flow; only a reopen (separate authority) touches this
  rejected: new Set([]),
  cancelled: new Set([]),
  duplicate: new Set([]),
  reversed: new Set([]),
  superseded: new Set([]),
};

export function canTransition(from: FinancialEventState, to: FinancialEventState): boolean {
  return ALLOWED[from]?.has(to) ?? false;
}

export function assertTransition(
  from: FinancialEventState,
  to: FinancialEventState,
): Result<{ from: FinancialEventState; to: FinancialEventState }> {
  if (from === to) {
    return fail("LIFECYCLE_NOOP", `No-op transition ${from} → ${to}`);
  }
  if (!canTransition(from, to)) {
    return fail("LIFECYCLE_ILLEGAL", `Illegal transition ${from} → ${to}`, { from, to });
  }
  return ok({ from, to });
}

export function isTerminal(state: FinancialEventState): boolean {
  return TERMINAL_STATES.has(state);
}
