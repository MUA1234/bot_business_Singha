/**
 * The two delegation implementations must never disagree.
 *
 * The MIN(delegation, delegator) rule is encoded twice, on purpose:
 *
 *   src/modules/identity/delegation-authority.ts   the FINANCIAL approval path
 *   src/kernel/people/delegation-scope.ts          CAPABILITY ROUTING
 *
 * They are not merged because they answer adjacent but different questions — routing also checks
 * the authority LADDER and returns candidate-shaped reasons, while the financial path returns an
 * effective ceiling and an audit record. Merging them would mean one of the two callers carrying
 * fields it has no use for.
 *
 * That duplication is a real risk: R2B exists largely because ONE rule had two implementations
 * and they disagreed. So this file is the guard. It sweeps a matrix of delegation and delegator
 * ceilings through BOTH and asserts they reach the same allow/refuse answer every time. If
 * someone changes one and not the other, this goes red.
 */
import { describe, expect, it } from "vitest";
import type { Delegation } from "@/modules/identity/delegation";
import {
  resolveDelegatedAuthority,
  type DelegatorAuthority as FinanceDelegator,
} from "@/modules/identity/delegation-authority";
import type { DelegationScope } from "@/kernel/people/candidate";
import {
  evaluateDelegation,
  type DelegatorAuthority as RoutingDelegator,
} from "@/kernel/people/delegation-scope";

const CO = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const NOW = new Date("2026-08-15T12:00:00Z");

const AMOUNTS = ["0.00", "1.00", "999.99", "1000.00", "1000.01", "5000.00", "50000.00", "50000.01"];
const DELEGATION_CAPS = ["1000.00", "5000.00", "50000.00"];
const DELEGATOR_CAPS = ["1000.00", "5000.00", "50000.00"];

function financeVerdict(amount: string, delegationCap: string, delegatorCap: string): boolean {
  const d: Delegation = {
    id: "d1", companyId: CO, fromMembership: "boss", toMembership: "deputy",
    domain: "expense", maxAmount: delegationCap, currency: "LKR",
    startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-31T00:00:00Z",
  };
  const delegator: FinanceDelegator = {
    membershipId: "boss", companyId: CO, active: true, holdsDirectly: true,
    directCeiling: { amount: delegatorCap, currency: "LKR" }, domains: ["expense"],
  };
  return resolveDelegatedAuthority(
    { companyId: CO, membershipId: "deputy", domain: "expense", amount, currency: "LKR", now: NOW },
    [d], () => delegator, { membershipId: "deputy", active: true }, NOW,
  ).ok;
}

function routingVerdict(amount: string, delegationCap: string, delegatorCap: string): boolean {
  const scope: DelegationScope = {
    delegationId: "d1", fromMembership: "boss", domain: "expense",
    maxAmount: delegationCap, currency: "LKR",
    startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-31T00:00:00Z",
  };
  const delegator: RoutingDelegator = {
    membershipId: "boss", companyId: CO, level: "manager_approval",
    ceiling: { amount: delegatorCap, currency: "LKR" },
  };
  return evaluateDelegation(
    scope, delegator,
    {
      companyId: CO, authorityDomain: "expense",
      authorityAmount: { amount, currency: "LKR" },
      requiredAuthority: "manager_approval", now: NOW,
    },
    CO,
  ).valid;
}

describe("the financial path and capability routing agree on MIN(delegation, delegator)", () => {
  for (const delegationCap of DELEGATION_CAPS) {
    for (const delegatorCap of DELEGATOR_CAPS) {
      for (const amount of AMOUNTS) {
        it(`amount ${amount} · delegation ${delegationCap} · delegator ${delegatorCap}`, () => {
          const finance = financeVerdict(amount, delegationCap, delegatorCap);
          const routing = routingVerdict(amount, delegationCap, delegatorCap);
          expect(
            finance,
            `finance=${finance} routing=${routing} for amount ${amount}, ` +
              `delegation ${delegationCap}, delegator ${delegatorCap}`,
          ).toBe(routing);
        });
      }
    }
  }

  it("both refuse whenever the grant exceeds the delegator, at every amount", () => {
    for (const amount of AMOUNTS) {
      // Grant 50,000 from a 1,000 delegator: invalid regardless of what is being approved.
      expect(financeVerdict(amount, "50000.00", "1000.00")).toBe(false);
      expect(routingVerdict(amount, "50000.00", "1000.00")).toBe(false);
    }
  });

  it("both allow exactly at the effective ceiling and refuse one unit above it", () => {
    expect(financeVerdict("1000.00", "1000.00", "5000.00")).toBe(true);
    expect(routingVerdict("1000.00", "1000.00", "5000.00")).toBe(true);
    expect(financeVerdict("1000.01", "1000.00", "5000.00")).toBe(false);
    expect(routingVerdict("1000.01", "1000.00", "5000.00")).toBe(false);
  });
});
