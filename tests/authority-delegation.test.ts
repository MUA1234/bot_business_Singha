import { describe, it, expect } from "vitest";
import { checkAuthority } from "@/policy/authority";
import type { Delegation } from "@/modules/identity/delegation";

const CO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const during = new Date("2026-08-15T12:00:00Z");

const deleg: Delegation = {
  id: "d1",
  companyId: CO,
  fromMembership: "boss",
  toMembership: "deputy",
  domain: "expense",
  maxAmount: "5000.00",
  currency: "LKR",
  startsAt: "2026-08-01T00:00:00Z",
  endsAt: "2026-08-31T00:00:00Z",
};

const delegationCtx = {
  membershipId: "deputy",
  companyId: CO,
  domain: "expense",
  amount: "1000.00",
  currency: "LKR",
  delegations: [deleg],
  now: during,
};

describe("checkAuthority (delegation-aware)", () => {
  it("allows via own role/permission", () => {
    const r = checkAuthority({
      approver: { user_id: "u1", roles: ["finance_reviewer"], permissions: ["approve"] },
      requiredRoles: ["finance_reviewer"],
      ctx: { submitter_user_id: "u2", approver_is_beneficiary: false, action: null },
    });
    expect(r.allowed).toBe(true);
    expect(r.via).toBe("own");
  });

  it("allows via delegation when own role is missing but delegation covers it", () => {
    const r = checkAuthority({
      approver: { user_id: "deputyUser", roles: ["staff_submitter"], permissions: [] },
      requiredRoles: ["finance_reviewer"],
      ctx: { submitter_user_id: "u2", approver_is_beneficiary: false, action: null },
      delegation: delegationCtx,
    });
    expect(r.allowed).toBe(true);
    expect(r.via).toBe("delegation");
  });

  it("denies when neither own role nor a valid delegation applies", () => {
    const r = checkAuthority({
      approver: { user_id: "u1", roles: ["staff_submitter"], permissions: [] },
      requiredRoles: ["finance_reviewer"],
      ctx: { submitter_user_id: "u2", approver_is_beneficiary: false, action: null },
      delegation: { ...delegationCtx, amount: "9999.00" }, // over ceiling
    });
    expect(r.allowed).toBe(false);
    expect(r.via).toBe(null);
  });

  it("NEVER lets a delegation override self-approval (submitter)", () => {
    const r = checkAuthority({
      approver: { user_id: "same", roles: ["staff_submitter"], permissions: [] },
      requiredRoles: ["finance_reviewer"],
      ctx: { submitter_user_id: "same", approver_is_beneficiary: false, action: null },
      delegation: delegationCtx,
    });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/own submission/);
  });

  it("NEVER lets a delegation override beneficiary self-approval", () => {
    const r = checkAuthority({
      approver: { user_id: "u1", roles: [], permissions: [] },
      requiredRoles: ["finance_reviewer"],
      ctx: { submitter_user_id: "u2", approver_is_beneficiary: true, action: null },
      delegation: delegationCtx,
    });
    expect(r.allowed).toBe(false);
    expect(r.via).toBe(null);
  });

  it("denies delegation outside its validity window", () => {
    const r = checkAuthority({
      approver: { user_id: "deputyUser", roles: [], permissions: [] },
      requiredRoles: ["finance_reviewer"],
      ctx: { submitter_user_id: "u2", approver_is_beneficiary: false, action: null },
      delegation: { ...delegationCtx, now: new Date("2026-09-15T00:00:00Z") },
    });
    expect(r.allowed).toBe(false);
  });
});
