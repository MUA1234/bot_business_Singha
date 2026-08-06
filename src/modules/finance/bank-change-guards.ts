/**
 * Supplier bank-detail change maker/checker guard (NEXT_PHASE_DEVELOPER_BRIEF §WP2.5).
 * Pure — decides whether a pending change may be decided by this approver. A change to
 * supplier bank details is high-risk, so it requires a SECOND person (never the
 * requester) and may only be acted on while still pending.
 */
export interface BankChangeDecision {
  ok: boolean;
  reason?: string;
}

export function canDecideBankChange(status: string, requestedBy: string, approverUserId: string): BankChangeDecision {
  if (status !== "pending") return { ok: false, reason: "change is not pending" };
  if (requestedBy === approverUserId) return { ok: false, reason: "separation of duties: the requester cannot approve their own change" };
  return { ok: true };
}
