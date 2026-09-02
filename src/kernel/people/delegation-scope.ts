/**
 * Delegation scope and the delegator ceiling (R2B checkpoint 3).
 *
 * The owner's rule: *"Delegation must never exceed the delegator's authority and must have
 * scope, start, expiry and audit history."*
 *
 * ── R2B-F-001, a real gap in existing code ──────────────────────────────────────────────────
 *
 * `src/modules/identity/delegation.ts` checks a delegation against ITS OWN ceiling and window,
 * and `src/policy/authority.ts` trusts that answer. Neither checks the delegation against the
 * DELEGATOR's authority. A manager whose own ceiling is LKR 50,000 can therefore write a
 * delegation granting LKR 5,000,000, and it is honoured — authority is manufactured out of
 * nothing by the person with the least of it.
 *
 * This module closes that for capability routing. It is a NEW function rather than an edit to
 * `delegationPermits`, deliberately: that function sits on the financial-approval path, and
 * silently changing what approves a payment is not something R2B is authorised to do. The gap on
 * that path is recorded for owner decision instead of quietly patched.
 *
 * Every check FAILS CLOSED. An unknown delegator, an unreadable amount, a missing scope and a
 * mismatched currency all refuse the delegation — none of them is treated as permission.
 */
import Decimal from "decimal.js";
import { LADDER } from "@/policy/authority-engine";
import type { AuthorityLevel } from "@/schemas/management";
import type { DelegationScope, Reason } from "./candidate";

/** What the DELEGATOR themselves may do. Resolved from company rules, never from the delegation. */
export interface DelegatorAuthority {
  membershipId: string;
  companyId: string;
  level: AuthorityLevel;
  /** Their own money ceiling. Null means they hold NO money authority to lend. */
  ceiling: { amount: string; currency: string } | null;
  /** Set only by an explicit company rule marked unlimited. */
  unlimited?: boolean;
}

export interface DelegationRequest {
  companyId: string;
  authorityDomain: string | null;
  authorityAmount: { amount: string; currency: string } | null;
  requiredAuthority: AuthorityLevel;
  now: Date;
}

export type DelegationVerdict =
  | {
      valid: true;
      /** The delegation as it may ACTUALLY be exercised — never wider than the delegator. */
      effectiveCeiling: { amount: string; currency: string } | null;
      reasons: Reason[];
    }
  | { valid: false; reasons: Reason[] };

const reason = (code: string, detail: string): Reason => ({ code, detail, evidence: null });
const refuse = (code: string, detail: string): DelegationVerdict => ({ valid: false, reasons: [reason(code, detail)] });
const rank = (l: AuthorityLevel) => LADDER.indexOf(l);

function toDecimal(v: string): Decimal | null {
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * May this delegation be exercised for this request?
 *
 * Order matters: scope and window are cheap and are the commonest reasons a delegation does not
 * apply, so they are reported before the ceiling arithmetic.
 */
export function evaluateDelegation(
  d: DelegationScope,
  delegator: DelegatorAuthority | null,
  req: DelegationRequest,
  delegationCompanyId: string,
): DelegationVerdict {
  // ── Company. A delegation never crosses a company boundary.
  if (delegationCompanyId !== req.companyId) {
    return refuse("delegation_cross_company", "the delegation belongs to a different company");
  }

  // ── Window. Inclusive start, exclusive end — the same convention as isDelegationActive.
  const start = Date.parse(d.startsAt);
  const end = Date.parse(d.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return refuse("delegation_dates_unreadable", "the delegation start or expiry could not be read");
  }
  const t = req.now.getTime();
  if (t < start) return refuse("delegation_not_started", `the delegation does not begin until ${d.startsAt}`);
  if (t >= end) return refuse("delegation_expired", `the delegation expired at ${d.endsAt}`);

  // ── Scope. The owner requires a delegation to HAVE a scope. A domain-agnostic delegation is
  //    an unbounded grant of someone else's authority, so it is refused rather than honoured.
  if (d.domain === null) {
    return refuse("delegation_scope_undefined", "the delegation defines no domain; an unscoped delegation is not accepted");
  }
  if (req.authorityDomain !== null && d.domain !== req.authorityDomain) {
    return refuse("delegation_domain_excluded", `the delegation covers ${d.domain}, not ${req.authorityDomain}`);
  }

  // ── The delegator. Unknown authority is never permission (R2B-F-001).
  if (!delegator) {
    return refuse("delegator_authority_unknown", "the delegator's own authority is not established, so the delegation cannot be trusted");
  }
  if (delegator.companyId !== req.companyId) {
    return refuse("delegator_cross_company", "the delegator belongs to a different company");
  }
  if (delegator.membershipId !== d.fromMembership) {
    return refuse("delegator_mismatch", "the supplied delegator is not the person who granted this delegation");
  }
  if (rank(delegator.level) < rank(req.requiredAuthority)) {
    return refuse(
      "delegation_exceeds_delegator_level",
      `the delegator holds ${delegator.level} and cannot delegate ${req.requiredAuthority} — nobody may lend authority they do not have`,
    );
  }

  // ── Money. Only reached when the work actually commits money.
  if (!req.authorityAmount) {
    return {
      valid: true,
      effectiveCeiling: null,
      reasons: [reason("delegation_ok", `active delegation from ${d.fromMembership} covering ${d.domain}, expiring ${d.endsAt}`)],
    };
  }

  const granted = d.maxAmount;
  if (granted === null) {
    // An uncapped grant is only legitimate if the delegator is genuinely uncapped.
    if (!delegator.unlimited) {
      return refuse(
        "delegation_uncapped_but_delegator_is_not",
        "the delegation sets no ceiling while the delegator's own authority is limited",
      );
    }
  }
  if (d.currency !== null && d.currency !== req.authorityAmount.currency) {
    return refuse("delegation_currency_mismatch", `the delegation is in ${d.currency} but the work is in ${req.authorityAmount.currency}; no conversion is applied`);
  }

  const amount = toDecimal(req.authorityAmount.amount);
  if (!amount) return refuse("delegation_amount_unreadable", "the work amount could not be read as a decimal");
  if (amount.isNegative()) return refuse("delegation_amount_negative", "a negative amount is never delegated");

  // The delegator's own ceiling, which the delegation can never exceed.
  let delegatorCap: Decimal | null = null;
  if (!delegator.unlimited) {
    if (!delegator.ceiling) {
      return refuse("delegator_has_no_money_authority", "the delegator holds no money authority to delegate");
    }
    if (delegator.ceiling.currency !== req.authorityAmount.currency) {
      return refuse(
        "delegator_currency_mismatch",
        `the delegator's ceiling is in ${delegator.ceiling.currency} but the work is in ${req.authorityAmount.currency}; no conversion is applied`,
      );
    }
    delegatorCap = toDecimal(delegator.ceiling.amount);
    if (!delegatorCap) return refuse("delegator_ceiling_unreadable", "the delegator's ceiling could not be read as a decimal");
  }

  const grantedCap = granted === null ? null : toDecimal(granted);
  if (granted !== null && !grantedCap) {
    return refuse("delegation_ceiling_unreadable", "the delegation ceiling could not be read as a decimal");
  }

  // THE R2B-F-001 CHECK: a delegation may not grant more than the delegator holds.
  if (grantedCap && delegatorCap && grantedCap.greaterThan(delegatorCap)) {
    return refuse(
      "delegation_exceeds_delegator",
      `the delegation grants ${granted} ${req.authorityAmount.currency} but the delegator's own ceiling is ` +
        `${delegator.ceiling!.amount} ${delegator.ceiling!.currency}; a delegation may never exceed the delegator's authority`,
    );
  }

  // Effective ceiling is the LOWER of the two — never the delegation alone.
  const effective = grantedCap && delegatorCap
    ? (grantedCap.lessThan(delegatorCap) ? grantedCap : delegatorCap)
    : (grantedCap ?? delegatorCap);

  if (effective && amount.greaterThan(effective)) {
    return refuse(
      "delegation_ceiling_exceeded",
      `the amount exceeds the effective delegated ceiling of ${effective.toString()} ${req.authorityAmount.currency}`,
    );
  }

  return {
    valid: true,
    effectiveCeiling: effective ? { amount: effective.toString(), currency: req.authorityAmount.currency } : null,
    reasons: [
      reason(
        "delegation_ok",
        `active delegation from ${d.fromMembership} covering ${d.domain} up to ` +
          `${effective ? effective.toString() : "no ceiling"} ${req.authorityAmount.currency}, expiring ${d.endsAt}`,
      ),
    ],
  };
}

/**
 * Refuse a re-delegation chain.
 *
 * If A delegates to B, B must not then delegate onward to C on the strength of that. Nothing in
 * the schema records a chain, so this cannot be detected from a single row — it is detected by
 * the delegator themselves holding their authority ONLY by delegation. The caller resolves
 * `delegatorHoldsOwnAuthority` from `authority_rules`; false means the authority is borrowed.
 */
export function refuseRedelegation(delegatorHoldsOwnAuthority: boolean): DelegationVerdict | null {
  if (delegatorHoldsOwnAuthority) return null;
  return refuse(
    "redelegation_refused",
    "the delegator holds this authority only by delegation, and delegated authority may not be delegated onward",
  );
}
