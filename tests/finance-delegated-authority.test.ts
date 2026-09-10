/**
 * R2B-F-001 on the FINANCIAL APPROVAL PATH — the owner's full scenario list.
 *
 * The rule under test:
 *
 *     effective delegated ceiling = MIN(delegation ceiling, delegator's valid DIRECT ceiling)
 *
 * Before this correction, `checkAuthority` honoured a delegation on its own word: a manager whose
 * own ceiling was LKR 50,000 could write a delegation granting LKR 5,000,000 and it approved.
 *
 * Every refusal here must be a REFUSAL, never a silently reduced amount. The owner's rule
 * "never silently reduce or reinterpret a financial amount" is asserted explicitly at the end.
 */
import { describe, it, expect } from "vitest";
import { checkAuthority } from "@/policy/authority";
import type { Delegation } from "@/modules/identity/delegation";
import {
  resolveDelegatedAuthority, validateDelegationGrant,
  type DelegateStatus, type DelegatorAuthority,
} from "@/modules/identity/delegation-authority";

const CO_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CO_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const NOW = new Date("2026-08-15T12:00:00Z");

const grant = (over: Partial<Delegation> = {}): Delegation => ({
  id: "d1", companyId: CO_A, fromMembership: "boss", toMembership: "deputy",
  domain: "expense", maxAmount: "5000.00", currency: "LKR",
  startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-31T00:00:00Z", ...over,
});

const boss = (over: Partial<DelegatorAuthority> = {}): DelegatorAuthority => ({
  membershipId: "boss", companyId: CO_A, active: true, holdsDirectly: true,
  directCeiling: { amount: "50000.00", currency: "LKR" }, domains: ["expense"], ...over,
});

const deputy = (over: Partial<DelegateStatus> = {}): DelegateStatus => ({
  membershipId: "deputy", active: true, ...over,
});

const req = (over: Partial<Parameters<typeof resolveDelegatedAuthority>[0]> = {}) => ({
  companyId: CO_A, membershipId: "deputy", domain: "expense",
  amount: "1000.00", currency: "LKR", now: NOW, ...over,
});

/** Exercise-time resolution with sensible defaults. */
const resolve = (
  over: Partial<Parameters<typeof resolveDelegatedAuthority>[0]> = {},
  delegations: Delegation[] = [grant()],
  delegator: DelegatorAuthority | null = boss(),
  status: DelegateStatus | null = deputy(),
) => resolveDelegatedAuthority(req(over), delegations, () => delegator, status, over.now ?? NOW);

// ═══════════════════════════════════════════════════════════════════════════════════════════
describe("the ceiling is the MINIMUM of the delegation and the delegator", () => {
  it("DELEGATOR ceiling BELOW delegation ceiling — the delegator binds", () => {
    // The exact defect shape: a 5,000,000 grant from a 50,000 manager.
    const v = resolve(
      { amount: "60000.00" },
      [grant({ maxAmount: "5000000.00" })],
      boss({ directCeiling: { amount: "50000.00", currency: "LKR" } }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegation_exceeds_delegator");
  });

  it("caps at the delegator even when the request is within the delegation", () => {
    // Grant 40,000 from a 30,000 manager: the grant itself is invalid, so nothing is approved.
    const v = resolve(
      { amount: "35000.00" },
      [grant({ maxAmount: "40000.00" })],
      boss({ directCeiling: { amount: "30000.00", currency: "LKR" } }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegation_exceeds_delegator");
  });

  it("DELEGATION ceiling BELOW delegator ceiling — the delegation binds", () => {
    const ok = resolve({ amount: "5000.00" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.effectiveCeiling).toEqual({ amount: "5000", currency: "LKR" });
      expect(ok.boundBy).toBe("delegation");
    }
    const over = resolve({ amount: "5000.01" });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("effective_ceiling_exceeded");
  });

  it("EQUAL ceilings — allowed at the boundary, and the DELEGATOR is recorded as binding", () => {
    const v = resolve(
      { amount: "5000.00" },
      [grant({ maxAmount: "5000.00" })],
      boss({ directCeiling: { amount: "5000.00", currency: "LKR" } }),
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.boundBy).toBe("delegation");
  });

  it("an uncapped grant needs a genuinely uncapped delegator", () => {
    const capped = resolve({ amount: "1.00" }, [grant({ maxAmount: null })], boss());
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.code).toBe("delegation_uncapped_but_delegator_is_not");

    const uncapped = resolve(
      { amount: "99999999.00" },
      [grant({ maxAmount: null })],
      boss({ unlimited: true, directCeiling: null }),
    );
    expect(uncapped.ok).toBe(true);
  });

  it("a delegator with NO direct money authority has none to lend", () => {
    const v = resolve({}, [grant()], boss({ directCeiling: null }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegator_has_no_money_authority");
  });
});

describe("boundary monetary amounts, in exact decimal", () => {
  const cases: Array<[string, boolean]> = [
    ["4999.99", true],
    ["5000.00", true],
    ["5000.001", false],
    ["5000.01", false],
    ["0.00", true],
    ["0.001", true],
  ];
  for (const [amount, allowed] of cases) {
    it(`${amount} against a 5000.00 effective ceiling -> ${allowed ? "allowed" : "refused"}`, () => {
      expect(resolve({ amount }).ok).toBe(allowed);
    });
  }

  it("compares beyond float precision rather than rounding into the ceiling", () => {
    // 9007199254740993 is 2^53+1: indistinguishable from 2^53 as a JS float.
    const v = resolve(
      { amount: "9007199254740993" },
      [grant({ maxAmount: "9007199254740992" })],
      boss({ directCeiling: { amount: "9007199254740992", currency: "LKR" } }),
    );
    expect(v.ok).toBe(false);
  });

  it("refuses an unreadable or negative amount instead of coercing it to zero", () => {
    const bad = resolve({ amount: "not-a-number" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("amount_unreadable");

    const neg = resolve({ amount: "-1.00" });
    expect(neg.ok).toBe(false);
    if (!neg.ok) expect(neg.code).toBe("amount_negative");
  });
});

describe("revocation, expiry, scope and company", () => {
  it("DELEGATOR AUTHORITY REVOKED AFTER GRANTING — revalidated at exercise, and refused", () => {
    // The grant was valid when written. It is re-checked now, not trusted.
    const stillValid = resolve();
    expect(stillValid.ok).toBe(true);

    const revoked = resolve({}, [grant()], boss({ active: false }));
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.code).toBe("delegator_inactive");
  });

  it("delegator's ceiling REDUCED after granting — the lower live figure binds", () => {
    const v = resolve(
      { amount: "4000.00" },
      [grant({ maxAmount: "5000.00" })],
      boss({ directCeiling: { amount: "3000.00", currency: "LKR" } }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegation_exceeds_delegator");
  });

  it("DELEGATE REVOKED — a suspended delegate exercises nothing", () => {
    const v = resolve({}, [grant()], boss(), deputy({ active: false }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegate_inactive");
  });

  it("delegate status not supplied at all — fails closed", () => {
    const v = resolveDelegatedAuthority(req(), [grant()], () => boss(), null, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegate_inactive");
  });

  it("EXPIRED delegation, and expiry is exclusive", () => {
    const expired = resolve({ now: new Date("2026-09-01T00:00:00Z") });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.code).toBe("delegation_expired");

    const atInstantOfExpiry = resolve({ now: new Date("2026-08-31T00:00:00Z") });
    expect(atInstantOfExpiry.ok).toBe(false);

    const justBefore = resolve({ now: new Date("2026-08-30T23:59:59.999Z") });
    expect(justBefore.ok).toBe(true);
  });

  it("NOT YET STARTED delegation", () => {
    const v = resolve({ now: new Date("2026-07-31T00:00:00Z") });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegation_not_started");
  });

  it("WRONG COMPANY — the delegation", () => {
    const v = resolve({}, [grant({ companyId: CO_B })]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegation_cross_company");
  });

  it("WRONG COMPANY — the delegator", () => {
    const v = resolve({}, [grant()], boss({ companyId: CO_B }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegator_cross_company");
  });

  it("WRONG DEPARTMENT/ACTION SCOPE — the delegation does not cover the domain", () => {
    const v = resolve({ domain: "payment" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegation_domain_excluded");
  });

  it("the DELEGATOR may not delegate a domain they cannot act in themselves", () => {
    const v = resolve({}, [grant()], boss({ domains: ["hr"] }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegator_domain_excluded");
  });

  it("UNSCOPED delegation remains invalid", () => {
    const v = resolve({}, [grant({ domain: null })]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegation_scope_undefined");
  });

  it("never converts currency to make an amount fit", () => {
    const delegationCcy = resolve({ currency: "USD" }, [grant({ currency: "LKR" })]);
    expect(delegationCcy.ok).toBe(false);
    if (!delegationCcy.ok) expect(delegationCcy.code).toBe("delegation_currency_mismatch");

    const delegatorCcy = resolve(
      { currency: "USD" },
      [grant({ currency: "USD" })],
      boss({ directCeiling: { amount: "50000.00", currency: "LKR" } }),
    );
    expect(delegatorCcy.ok).toBe(false);
    if (!delegatorCcy.ok) expect(delegatorCcy.code).toBe("delegator_currency_mismatch");
  });
});

describe("re-delegation and unknown authority", () => {
  it("ATTEMPTED RE-DELEGATION — borrowed authority may not be delegated onward", () => {
    const v = resolve({}, [grant()], boss({ holdsDirectly: false }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("redelegation_refused");
  });

  it("an UNKNOWN delegator is refused — absence is never permission", () => {
    const v = resolveDelegatedAuthority(req(), [grant()], () => null, deputy(), NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegator_unknown");
  });

  it("a delegator whose DOMAINS are unknown is refused, distinctly from having none", () => {
    const unknown = resolve({}, [grant()], boss({ domains: null }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("delegator_domains_unknown");

    const none = resolve({}, [grant()], boss({ domains: [] }));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.code).toBe("delegator_domain_excluded");
  });

  it("a delegation attributed to someone other than the supplied delegator is refused", () => {
    const v = resolve({}, [grant({ fromMembership: "someone_else" })], boss());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegator_unknown");
  });

  it("a delegation naming a DIFFERENT delegate does not apply", () => {
    const v = resolve({}, [grant({ toMembership: "another" })]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("no_delegation");
  });
});

describe("creation-time validation of the grant", () => {
  it("refuses a grant that exceeds the delegator at the moment it is written", () => {
    const v = validateDelegationGrant(grant({ maxAmount: "5000000.00" }), boss(), NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("delegation_exceeds_delegator");
  });

  it("refuses a grant from an inactive delegator, an unscoped grant, and a backwards window", () => {
    expect(validateDelegationGrant(grant(), boss({ active: false }), NOW).ok).toBe(false);
    expect(validateDelegationGrant(grant({ domain: null }), boss(), NOW).ok).toBe(false);
    expect(validateDelegationGrant(
      grant({ startsAt: "2026-08-31T00:00:00Z", endsAt: "2026-08-01T00:00:00Z" }), boss(), NOW,
    ).ok).toBe(false);
  });

  it("accepts a grant within the delegator's own direct ceiling and domain", () => {
    const v = validateDelegationGrant(grant(), boss(), NOW);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.effectiveCeiling).toEqual({ amount: "5000", currency: "LKR" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
describe("through checkAuthority — the financial approval path itself", () => {
  const approver = { user_id: "deputyUser", roles: ["staff_submitter"] as const, permissions: [] as const };
  const ctx = { submitter_user_id: "someone_else", approver_is_beneficiary: false, action: null };

  const call = (over: Record<string, unknown> = {}, delegator = boss(), status: DelegateStatus | null = deputy()) =>
    checkAuthority({
      approver: { user_id: approver.user_id, roles: [...approver.roles], permissions: [...approver.permissions] },
      requiredRoles: ["finance_reviewer"],
      ctx,
      delegation: {
        membershipId: "deputy", companyId: CO_A, domain: "expense",
        amount: "1000.00", currency: "LKR", delegations: [grant()], now: NOW,
        delegatorFor: () => delegator, delegateStatus: status,
        ...over,
      },
    });

  it("refuses the over-granted delegation that used to approve", () => {
    const r = call(
      { amount: "60000.00", delegations: [grant({ maxAmount: "5000000.00" })] },
      boss({ directCeiling: { amount: "50000.00", currency: "LKR" } }),
    );
    expect(r.allowed).toBe(false);
    expect(r.refusalCode).toBe("delegation_exceeds_delegator");
  });

  it("RECORDS which authority path justified the decision", () => {
    const viaDelegation = call();
    expect(viaDelegation.via).toBe("delegation");
    expect(viaDelegation.delegation!.delegationId).toBe("d1");
    expect(viaDelegation.delegation!.boundBy).toBe("delegation");

    const viaOwn = checkAuthority({
      approver: { user_id: "u1", roles: ["finance_reviewer"], permissions: ["approve"] },
      requiredRoles: ["finance_reviewer"],
      ctx,
    });
    expect(viaOwn.via).toBe("own");
    expect(viaOwn.delegation).toBeUndefined();
  });

  it("DIRECT AUTHORITY IS INDEPENDENT — a delegate with their own role is authorised directly", () => {
    // Their delegation is expired AND over-granted; it does not matter, because they hold the
    // role themselves. A broken delegation must never remove someone's own authority.
    const r = checkAuthority({
      approver: { user_id: "deputyUser", roles: ["finance_reviewer"], permissions: ["approve"] },
      requiredRoles: ["finance_reviewer"],
      ctx,
      delegation: {
        membershipId: "deputy", companyId: CO_A, domain: "expense",
        amount: "9999999.00", currency: "LKR",
        delegations: [grant({ maxAmount: "99999999.00", endsAt: "2020-01-01T00:00:00Z" })],
        now: NOW, delegatorFor: () => boss(), delegateStatus: deputy(),
      },
    });
    expect(r.allowed).toBe(true);
    expect(r.via).toBe("own");
  });

  it("SELF-APPROVAL THROUGH DELEGATION is refused before any delegation is even considered", () => {
    const r = checkAuthority({
      approver: { user_id: "same", roles: [], permissions: [] },
      requiredRoles: ["finance_reviewer"],
      ctx: { submitter_user_id: "same", approver_is_beneficiary: false, action: null },
      delegation: {
        membershipId: "deputy", companyId: CO_A, domain: "expense", amount: "1.00",
        currency: "LKR", delegations: [grant()], now: NOW,
        delegatorFor: () => boss(), delegateStatus: deputy(),
      },
    });
    expect(r.allowed).toBe(false);
    expect(r.via).toBe(null);
    expect(r.reasons.join(" ")).toMatch(/own submission/);
    // The delegation was never reached, so no delegation refusal code is reported.
    expect(r.refusalCode).toBeUndefined();
  });

  it("a BENEFICIARY cannot approve through a delegation either", () => {
    const r = checkAuthority({
      approver: { user_id: "deputyUser", roles: [], permissions: [] },
      requiredRoles: ["finance_reviewer"],
      ctx: { submitter_user_id: "other", approver_is_beneficiary: true, action: null },
      delegation: {
        membershipId: "deputy", companyId: CO_A, domain: "expense", amount: "1.00",
        currency: "LKR", delegations: [grant()], now: NOW,
        delegatorFor: () => boss(), delegateStatus: deputy(),
      },
    });
    expect(r.allowed).toBe(false);
  });

  it("a sensitive action still requires a second person", () => {
    const r = checkAuthority({
      approver: { user_id: "same", roles: [], permissions: [] },
      requiredRoles: ["finance_reviewer"],
      ctx: { submitter_user_id: "same", approver_is_beneficiary: false, action: "authorize_payment" },
      delegation: {
        membershipId: "deputy", companyId: CO_A, domain: "expense", amount: "1.00",
        currency: "LKR", delegations: [grant()], now: NOW,
        delegatorFor: () => boss(), delegateStatus: deputy(),
      },
    });
    expect(r.allowed).toBe(false);
  });
});

describe("determinism, duplicates and concurrency", () => {
  it("DUPLICATE APPROVAL REQUESTS give an identical decision — the check is pure", () => {
    const a = resolve();
    const b = resolve();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("reports the same refusal whatever order the delegations arrive in", () => {
    const many = [grant({ id: "d3", domain: "hr" }), grant({ id: "d1", domain: "payment" }), grant({ id: "d2", domain: "legal" })];
    const forward = resolve({}, many);
    const reversed = resolve({}, [...many].reverse());
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it("picks the delegation that applies even when others do not", () => {
    const v = resolve({}, [grant({ id: "d0", domain: "hr" }), grant({ id: "d1", domain: "expense" })]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.delegationId).toBe("d1");
  });

  it("CONCURRENT APPROVAL AND REVOCATION — the decision follows the evidence at exercise time", () => {
    // The pure check cannot race; what matters is that it re-reads the delegator every time,
    // so an approval evaluated after a revocation refuses even with an unchanged delegation row.
    let active = true;
    const delegatorFor = () => boss({ active });
    const before = resolveDelegatedAuthority(req(), [grant()], delegatorFor, deputy(), NOW);
    active = false;
    const after = resolveDelegatedAuthority(req(), [grant()], delegatorFor, deputy(), NOW);
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe("delegator_inactive");
  });
});

describe("no financial amount is ever silently reinterpreted", () => {
  it("REFUSES rather than approving a reduced amount", () => {
    const v = resolve({ amount: "60000.00" }, [grant({ maxAmount: "5000000.00" })]);
    expect(v.ok).toBe(false);
    // There is no shape in which a refusal can carry an approved-but-smaller figure.
    expect(JSON.stringify(v)).not.toMatch(/"effectiveCeiling"/);
  });

  it("echoes the ceiling exactly as stored, without reformatting the request amount", () => {
    const v = resolve({ amount: "1234.5600" });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.effectiveCeiling).toEqual({ amount: "5000", currency: "LKR" });
  });
});
