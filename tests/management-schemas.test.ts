import { describe, it, expect } from "vitest";
import { ManagementObservation, DecisionProposal, AuthorityLevel } from "@/schemas/management";

describe("AI governance schemas (change plan §6.1/§6.3, Constitution §6)", () => {
  it("accepts a valid observation and applies array defaults", () => {
    const r = ManagementObservation.safeParse({
      sourceEventId: "src-1",
      scope: { companyId: "co-1" },
      confidence: 0.8,
      requiredAuthority: "manager_approval",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.confirmedFacts).toEqual([]);
      expect(r.data.involved.people).toEqual([]);
    }
  });

  it("rejects an observation with out-of-range confidence", () => {
    const r = ManagementObservation.safeParse({
      sourceEventId: "src-1", scope: { companyId: "co-1" },
      confidence: 1.5, requiredAuthority: "automatic",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown authority level", () => {
    expect(AuthorityLevel.safeParse("god_mode").success).toBe(false);
    expect(AuthorityLevel.safeParse("owner_approval").success).toBe(true);
  });

  it("accepts a valid decision proposal with a decimal-string money limit", () => {
    const r = DecisionProposal.safeParse({
      action: "post_expense", reason: "receipt", expectedOutcome: "expense recorded",
      confidence: 0.9, risk: "medium", policyVersion: "v1",
      requiredPermission: "post", expiresAt: "2026-09-01T00:00:00Z",
      limit: { amount: "1500.00", currency: "LKR" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a proposal missing the action and one with float money", () => {
    expect(
      DecisionProposal.safeParse({
        reason: "x", expectedOutcome: "y", confidence: 0.5, risk: "low",
        policyVersion: "v1", requiredPermission: "view", expiresAt: "2026-09-01",
      }).success,
    ).toBe(false);
    expect(
      DecisionProposal.safeParse({
        action: "pay", reason: "x", expectedOutcome: "y", confidence: 0.5, risk: "low",
        policyVersion: "v1", requiredPermission: "view", expiresAt: "2026-09-01",
        limit: { amount: 1500.5 as unknown as string, currency: "LKR" },
      }).success,
    ).toBe(false);
  });
});
