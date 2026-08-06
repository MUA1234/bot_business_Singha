/**
 * Deterministic delegation authority (NEXT_PHASE_DEVELOPER_BRIEF §WP1.7).
 *
 * A delegation temporarily lends authority from one membership to another, bounded by
 * a validity window and an authority ceiling (domain + max amount + currency). This is
 * pure logic so the "only during its valid period and within its defined authority"
 * rule is exhaustively unit-testable without a database. The DB stores delegations
 * (migration 0010 + ceiling columns in 0023); this decides what they grant.
 *
 * Money is compared as decimal strings via decimal.js — never JS floats (Constitution).
 */
import Decimal from "decimal.js";

export interface Delegation {
  id: string;
  companyId: string;
  fromMembership: string;
  toMembership: string;
  domain: string | null; // 'expense' | 'payment' | 'contract' | 'hr' | null = any
  maxAmount: string | null; // decimal string; null = no ceiling (still domain/window-bound)
  currency: string | null; // ISO 4217; null = any
  startsAt: string; // ISO timestamp
  endsAt: string; // ISO timestamp
}

/** Is the delegation live at `now` (inclusive start, exclusive end)? */
export function isDelegationActive(d: Delegation, now: Date = new Date()): boolean {
  const t = now.getTime();
  return t >= new Date(d.startsAt).getTime() && t < new Date(d.endsAt).getTime();
}

/** Active delegations granted TO a membership, within its own company only. */
export function activeDelegationsTo(
  membershipId: string,
  companyId: string,
  delegations: Delegation[],
  now: Date = new Date(),
): Delegation[] {
  return delegations.filter(
    (d) =>
      d.toMembership === membershipId &&
      d.companyId === companyId && // never cross-company
      isDelegationActive(d, now),
  );
}

export interface AuthorityRequest {
  membershipId: string;
  companyId: string;
  domain: string;
  amount: string; // decimal string
  currency: string;
}

/**
 * May the delegatee authorise this request purely on the strength of a delegation?
 * (The caller still ORs this with the membership's own authority rules.)
 * A delegation qualifies when it is active, matches the company, matches the domain
 * (or is domain-agnostic), matches the currency (or is currency-agnostic), and its
 * ceiling covers the amount (or has no ceiling).
 */
export function delegationPermits(req: AuthorityRequest, delegations: Delegation[], now: Date = new Date()): boolean {
  const amount = new Decimal(req.amount);
  if (amount.isNegative()) return false;
  const active = activeDelegationsTo(req.membershipId, req.companyId, delegations, now);
  return active.some((d) => {
    if (d.domain !== null && d.domain !== req.domain) return false;
    if (d.currency !== null && d.currency !== req.currency) return false;
    if (d.maxAmount !== null && amount.greaterThan(new Decimal(d.maxAmount))) return false;
    return true;
  });
}
