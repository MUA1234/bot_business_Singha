/**
 * Expense separation-of-duties guard (NEXT_PHASE_DEVELOPER_BRIEF §WP2.5 maker/checker,
 * "prevent prohibited self-approval"). Pure — the caller resolves the claimant's user
 * id and the acting user's id, then asks whether this is a prohibited self-action.
 */

/** True when the actor is the claimant — must not approve/reimburse their own claim. */
export function isSelfAction(claimantUserId: string | null | undefined, actorUserId: string): boolean {
  return !!claimantUserId && claimantUserId === actorUserId;
}
