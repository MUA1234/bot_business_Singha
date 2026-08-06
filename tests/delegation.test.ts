import { describe, it, expect } from "vitest";
import {
  isDelegationActive,
  activeDelegationsTo,
  delegationPermits,
  type Delegation,
} from "@/modules/identity/delegation";

const CO_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CO_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function d(over: Partial<Delegation> = {}): Delegation {
  return {
    id: "d1",
    companyId: CO_A,
    fromMembership: "boss",
    toMembership: "deputy",
    domain: "expense",
    maxAmount: "5000.00",
    currency: "LKR",
    startsAt: "2026-08-01T00:00:00Z",
    endsAt: "2026-08-31T00:00:00Z",
    ...over,
  };
}

const during = new Date("2026-08-15T12:00:00Z");
const before = new Date("2026-07-15T12:00:00Z");
const after = new Date("2026-09-15T12:00:00Z");

describe("delegation validity window", () => {
  it("active only within [start, end)", () => {
    expect(isDelegationActive(d(), during)).toBe(true);
    expect(isDelegationActive(d(), before)).toBe(false);
    expect(isDelegationActive(d(), after)).toBe(false);
    expect(isDelegationActive(d(), new Date("2026-08-31T00:00:00Z"))).toBe(false); // end exclusive
  });

  it("excludes cross-company delegations", () => {
    const list = [d({ companyId: CO_B })];
    expect(activeDelegationsTo("deputy", CO_A, list, during)).toHaveLength(0);
  });

  it("only returns delegations granted to the given membership", () => {
    const list = [d({ toMembership: "someone_else" })];
    expect(activeDelegationsTo("deputy", CO_A, list, during)).toHaveLength(0);
  });
});

describe("delegationPermits", () => {
  const base = { membershipId: "deputy", companyId: CO_A, domain: "expense", amount: "1000.00", currency: "LKR" };

  it("permits within window, domain, currency and ceiling", () => {
    expect(delegationPermits(base, [d()], during)).toBe(true);
  });

  it("denies outside the window", () => {
    expect(delegationPermits(base, [d()], after)).toBe(false);
  });

  it("denies over the ceiling", () => {
    expect(delegationPermits({ ...base, amount: "6000.00" }, [d()], during)).toBe(false);
    expect(delegationPermits({ ...base, amount: "5000.00" }, [d()], during)).toBe(true); // exactly at ceiling
  });

  it("denies wrong domain and wrong currency", () => {
    expect(delegationPermits({ ...base, domain: "payment" }, [d()], during)).toBe(false);
    expect(delegationPermits({ ...base, currency: "USD" }, [d()], during)).toBe(false);
  });

  it("domain/currency-agnostic and no-ceiling delegations are broader", () => {
    const wild = d({ domain: null, currency: null, maxAmount: null });
    expect(delegationPermits({ ...base, domain: "payment", currency: "USD", amount: "999999" }, [wild], during)).toBe(true);
  });

  it("rejects negative amounts", () => {
    expect(delegationPermits({ ...base, amount: "-1" }, [d()], during)).toBe(false);
  });
});
