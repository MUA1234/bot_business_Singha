/**
 * Delegated authority: the delegator ceiling rule (defect R2B-F-001).
 *
 * ── The defect this module exists to close ───────────────────────────────────────────────────
 *
 * `delegationPermits` (delegation.ts) checks a delegation against ITS OWN ceiling and window,
 * and `checkAuthority` in src/policy/authority.ts trusted that answer. Neither checked the
 * delegation against the DELEGATOR's authority. A manager whose own ceiling is LKR 50,000 could
 * write a delegation granting LKR 5,000,000, and it was honoured on the financial approval path —
 * authority manufactured from nothing by the person with the least of it.
 *
 * ── The rule ────────────────────────────────────────────────────────────────────────────────
 *
 *     effective delegated ceiling = MIN(delegation ceiling, delegator's valid DIRECT ceiling)
 *
 * "Direct" matters. Authority a delegator holds only by delegation is BORROWED, and borrowed
 * authority may not be delegated onward — otherwise a chain of three people can launder a small
 * ceiling into an unlimited one.
 *
 * ── Why this module and not an edit in place ────────────────────────────────────────────────
 *
 * The rule is needed in two places: the financial approval path (`src/policy/authority.ts`) and
 * capability routing (`src/kernel/people/delegation-scope.ts`). Implementing it twice is how two
 * different answers to the same question appear, which is the class of defect R2B keeps finding.
 * It lives here, in the identity module that already owns `Delegation`, and both callers use it.
 *
 * Everything FAILS CLOSED. An unknown delegator, an unreadable amount, an absent scope, a
 * mismatched currency and a contradictory record all REFUSE. None of them is treated as
 * permission, and no amount is ever silently reduced, rounded or reinterpreted to make one fit.
 *
 * Money is compared with Decimal, never a JS float, because this decides financial authority.
 */
import Decimal from "decimal.js";
import { isDelegationActive, type Delegation } from "./delegation";

export interface Ceiling {
  amount: string;
  currency: string;
}

/**
 * What the DELEGATOR holds in their own right, resolved from company authority rules — never
 * from the delegation itself, which is the whole point.
 */
export interface DelegatorAuthority {
  membershipId: string;
  companyId: string;
  /** Still an active membership? A revoked delegator's grants die with their authority. */
  active: boolean;
  /**
   * Do they hold this authority DIRECTLY, rather than by a delegation of their own?
   * False means it is borrowed, and borrowed authority may not be delegated onward.
   */
  holdsDirectly: boolean;
  /** Their own direct money ceiling. Null means NO direct money authority to lend. */
  directCeiling: Ceiling | null;
  /** True only where a company rule explicitly grants unlimited direct authority. */
  unlimited?: boolean;
  /**
   * Business domains the delegator may act in. `null` means UNKNOWN, which fails closed —
   * an empty array means "explicitly none", which also fails, but for a different reason.
   */
  domains: string[] | null;
}

/** The delegate's own standing at the moment authority is exercised. */
export interface DelegateStatus {
  membershipId: string;
  active: boolean;
}

/** What is being authorised. */
export interface DelegatedRequest {
  companyId: string;
  /** The delegate exercising the authority. */
  membershipId: string;
  /** The business domain: 'expense', 'payment', 'contract', 'hr'… */
  domain: string;
  amount: string;
  currency: string;
  now: Date;
}

export type DelegationRefusalCode =
  | "no_delegation"
  | "delegation_cross_company"
  | "delegate_inactive"
  | "delegation_not_started"
  | "delegation_expired"
  | "delegation_dates_unreadable"
  | "delegation_scope_undefined"
  | "delegation_domain_excluded"
  | "delegation_currency_mismatch"
  | "delegator_unknown"
  | "delegator_inactive"
  | "delegator_cross_company"
  | "delegator_domain_excluded"
  | "delegator_domains_unknown"
  | "redelegation_refused"
  | "delegator_has_no_money_authority"
  | "delegator_currency_mismatch"
  | "delegation_uncapped_but_delegator_is_not"
  | "delegation_exceeds_delegator"
  | "effective_ceiling_exceeded"
  | "amount_unreadable"
  | "amount_negative";

export type DelegatedAuthorityVerdict =
  | {
      ok: true;
      delegationId: string;
      /** MIN(delegation, delegator). Null only when the request commits no money. */
      effectiveCeiling: Ceiling | null;
      /** Which side of the minimum actually bound, for the audit record. */
      boundBy: "delegation" | "delegator" | "none";
      reasons: string[];
    }
  | { ok: false; code: DelegationRefusalCode; reasons: string[] };

const refuse = (code: DelegationRefusalCode, reason: string): DelegatedAuthorityVerdict => ({
  ok: false,
  code,
  reasons: [reason],
});

function toDecimal(v: string): Decimal | null {
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * Creation-time validation: may this delegation be GRANTED at all?
 *
 * The owner requires the delegator's authority to be validated when a delegation is created AND
 * revalidated when it is exercised. This is the first half. It deliberately does not look at any
 * particular request — it asks only whether the grant itself is legitimate.
 */
export function validateDelegationGrant(
  d: Delegation,
  delegator: DelegatorAuthority | null,
  now: Date = new Date(),
): DelegatedAuthorityVerdict {
  if (!delegator) {
    return refuse("delegator_unknown", "the delegator's own authority is not established, so nothing may be granted from it");
  }
  if (delegator.membershipId !== d.fromMembership) {
    return refuse("delegator_unknown", "the supplied delegator is not the person granting this delegation");
  }
  if (delegator.companyId !== d.companyId) {
    return refuse("delegator_cross_company", "the delegator belongs to a different company than the delegation");
  }
  if (!delegator.active) {
    return refuse("delegator_inactive", "an inactive or revoked delegator may not grant authority");
  }
  if (!delegator.holdsDirectly) {
    return refuse(
      "redelegation_refused",
      "the delegator holds this authority only by delegation, and borrowed authority may not be delegated onward",
    );
  }
  // Scope is REQUIRED. An unscoped delegation is an unbounded grant of someone else's authority.
  if (d.domain === null) {
    return refuse("delegation_scope_undefined", "a delegation must name a domain; an unscoped delegation is not valid");
  }
  if (delegator.domains === null) {
    return refuse("delegator_domains_unknown", "the delegator's own domains are not established");
  }
  if (!delegator.domains.includes(d.domain)) {
    return refuse("delegator_domain_excluded", `the delegator may not act in "${d.domain}", so they cannot delegate it`);
  }

  const start = Date.parse(d.startsAt);
  const end = Date.parse(d.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return refuse("delegation_dates_unreadable", "the delegation start or expiry could not be read");
  }
  if (end <= start) {
    return refuse("delegation_dates_unreadable", "the delegation expires before it begins");
  }

  // The ceiling comparison. A grant with no cap is only legitimate from an uncapped delegator.
  if (d.maxAmount === null) {
    if (!delegator.unlimited) {
      return refuse(
        "delegation_uncapped_but_delegator_is_not",
        "the delegation sets no ceiling while the delegator's own authority is limited",
      );
    }
    return { ok: true, delegationId: d.id, effectiveCeiling: null, boundBy: "none", reasons: ["uncapped grant from an uncapped delegator"] };
  }

  const granted = toDecimal(d.maxAmount);
  if (!granted) return refuse("amount_unreadable", "the delegation ceiling could not be read as a decimal");
  if (granted.isNegative()) return refuse("amount_negative", "a delegation ceiling may not be negative");

  if (delegator.unlimited) {
    return {
      ok: true, delegationId: d.id,
      effectiveCeiling: { amount: granted.toString(), currency: d.currency ?? "" },
      boundBy: "delegation",
      reasons: [`capped grant of ${granted.toString()} from an uncapped delegator`],
    };
  }

  if (!delegator.directCeiling) {
    return refuse("delegator_has_no_money_authority", "the delegator holds no direct money authority to delegate");
  }
  if (d.currency !== null && d.currency !== delegator.directCeiling.currency) {
    return refuse(
      "delegator_currency_mismatch",
      `the delegation is in ${d.currency} but the delegator's ceiling is in ${delegator.directCeiling.currency}; no conversion is applied`,
    );
  }
  const delegatorCap = toDecimal(delegator.directCeiling.amount);
  if (!delegatorCap) return refuse("amount_unreadable", "the delegator's ceiling could not be read as a decimal");

  if (granted.greaterThan(delegatorCap)) {
    return refuse(
      "delegation_exceeds_delegator",
      `the delegation grants ${granted.toString()} but the delegator's own direct ceiling is ` +
        `${delegatorCap.toString()}; a delegation may never exceed the delegator's authority`,
    );
  }

  return {
    ok: true,
    delegationId: d.id,
    effectiveCeiling: { amount: granted.toString(), currency: delegator.directCeiling.currency },
    boundBy: granted.equals(delegatorCap) ? "delegator" : "delegation",
    reasons: [`grant of ${granted.toString()} is within the delegator's direct ceiling of ${delegatorCap.toString()}`],
  };
}

/**
 * Exercise-time resolution: may this delegate authorise THIS request, right now?
 *
 * This is the second half of the owner's requirement — the grant is revalidated, not trusted,
 * because between creation and use the delegator may have been revoked, lost the domain, or had
 * their own ceiling reduced. The effective ceiling is recomputed from live evidence every time.
 */
export function resolveDelegatedAuthority(
  req: DelegatedRequest,
  delegations: readonly Delegation[],
  delegatorFor: (fromMembershipId: string) => DelegatorAuthority | null,
  delegate: DelegateStatus | null,
  now: Date = req.now,
): DelegatedAuthorityVerdict {
  // The delegate's own standing first: a revoked delegate exercises nothing.
  if (!delegate) {
    return refuse("delegate_inactive", "the delegate's membership status is not established");
  }
  if (delegate.membershipId !== req.membershipId) {
    return refuse("delegate_inactive", "the supplied delegate status is for a different person");
  }
  if (!delegate.active) {
    return refuse("delegate_inactive", "the delegate's membership is inactive, suspended or revoked");
  }

  const amount = toDecimal(req.amount);
  if (!amount) return refuse("amount_unreadable", "the request amount could not be read as a decimal");
  if (amount.isNegative()) return refuse("amount_negative", "a negative amount is never delegated");

  const candidates = delegations.filter((d) => d.toMembership === req.membershipId);
  if (candidates.length === 0) {
    return refuse("no_delegation", "no delegation names this person");
  }

  // Deterministic order, so the reported reason for a refusal never depends on array order.
  const ordered = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let lastRefusal: DelegatedAuthorityVerdict = refuse("no_delegation", "no delegation applies to this request");

  for (const d of ordered) {
    const v = evaluateOne(d, req, amount, delegatorFor(d.fromMembership), now);
    if (v.ok) return v;
    lastRefusal = v;
  }
  return lastRefusal;
}

function evaluateOne(
  d: Delegation,
  req: DelegatedRequest,
  amount: Decimal,
  delegator: DelegatorAuthority | null,
  now: Date,
): DelegatedAuthorityVerdict {
  if (d.companyId !== req.companyId) {
    return refuse("delegation_cross_company", "the delegation belongs to a different company");
  }

  const start = Date.parse(d.startsAt);
  const end = Date.parse(d.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return refuse("delegation_dates_unreadable", "the delegation start or expiry could not be read");
  }
  if (now.getTime() < start) return refuse("delegation_not_started", `the delegation does not begin until ${d.startsAt}`);
  if (!isDelegationActive(d, now)) return refuse("delegation_expired", `the delegation expired at ${d.endsAt}`);

  if (d.domain === null) {
    return refuse("delegation_scope_undefined", "the delegation names no domain; an unscoped delegation is not valid");
  }
  if (d.domain !== req.domain) {
    return refuse("delegation_domain_excluded", `the delegation covers ${d.domain}, not ${req.domain}`);
  }
  if (d.currency !== null && d.currency !== req.currency) {
    return refuse(
      "delegation_currency_mismatch",
      `the delegation is in ${d.currency} but the request is in ${req.currency}; no conversion is applied`,
    );
  }

  // REVALIDATE THE DELEGATOR. This is the half that was missing entirely.
  const grant = validateDelegationGrant(d, delegator, now);
  if (!grant.ok) return grant;

  // The delegator's live direct ceiling, re-read now rather than trusted from creation time.
  const delegatorCap =
    delegator!.unlimited || !delegator!.directCeiling ? null : toDecimal(delegator!.directCeiling.amount);
  if (!delegator!.unlimited && delegator!.directCeiling && !delegatorCap) {
    return refuse("amount_unreadable", "the delegator's ceiling could not be read as a decimal");
  }
  if (!delegator!.unlimited && delegator!.directCeiling &&
      delegator!.directCeiling.currency !== req.currency) {
    return refuse(
      "delegator_currency_mismatch",
      `the delegator's ceiling is in ${delegator!.directCeiling.currency} but the request is in ${req.currency}; no conversion is applied`,
    );
  }

  const grantedCap = d.maxAmount === null ? null : toDecimal(d.maxAmount);
  if (d.maxAmount !== null && !grantedCap) {
    return refuse("amount_unreadable", "the delegation ceiling could not be read as a decimal");
  }

  // MIN(delegation, delegator) — never the delegation alone.
  let effective: Decimal | null;
  let boundBy: "delegation" | "delegator" | "none";
  if (grantedCap && delegatorCap) {
    effective = grantedCap.lessThanOrEqualTo(delegatorCap) ? grantedCap : delegatorCap;
    boundBy = grantedCap.lessThanOrEqualTo(delegatorCap) ? "delegation" : "delegator";
  } else if (grantedCap) {
    effective = grantedCap;
    boundBy = "delegation";
  } else if (delegatorCap) {
    effective = delegatorCap;
    boundBy = "delegator";
  } else {
    effective = null;
    boundBy = "none";
  }

  if (effective && amount.greaterThan(effective)) {
    return refuse(
      "effective_ceiling_exceeded",
      `${amount.toString()} exceeds the effective delegated ceiling of ${effective.toString()} ${req.currency} ` +
        `(bound by the ${boundBy})`,
    );
  }

  return {
    ok: true,
    delegationId: d.id,
    effectiveCeiling: effective ? { amount: effective.toString(), currency: req.currency } : null,
    boundBy,
    reasons: [
      `delegation ${d.id} from ${d.fromMembership} covering ${d.domain}, expiring ${d.endsAt}; ` +
        `effective ceiling ${effective ? effective.toString() : "none"} ${req.currency} (bound by the ${boundBy})`,
    ],
  };
}
