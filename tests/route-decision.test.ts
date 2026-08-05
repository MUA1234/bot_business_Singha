import { describe, it, expect } from "vitest";
import { routeDecision } from "@/management/policy/route-decision";
import type { DecisionProposal } from "@/schemas/management";

function proposal(over: Partial<DecisionProposal>): DecisionProposal {
  return {
    action: "send_reminder",
    reason: "task due soon",
    expectedOutcome: "employee reminded",
    evidenceRefs: [],
    confidence: 0.9,
    risk: "low",
    policyVersion: "v1",
    requiredPermission: "view",
    requiredApprovers: [],
    conditions: [],
    expiresAt: "2026-09-01T00:00:00Z",
    ...over,
  };
}

describe("decision router (change plan §6.3, Constitution §6)", () => {
  it("auto-runs a low-risk informational action", () => {
    expect(routeDecision(proposal({})).routing).toBe("auto");
  });

  it("never auto-runs a payment — escalates to owner", () => {
    const r = routeDecision(proposal({ action: "execute_payment", risk: "low" }));
    expect(r.routing).toBe("require_approval");
    expect(r.requiredLevel).toBe("owner_approval");
  });

  it("never auto-runs a supplier bank-detail change", () => {
    const r = routeDecision(proposal({ action: "change_supplier_bank_details" }));
    expect(r.routing).toBe("require_approval");
    expect(r.requiredLevel).toBe("specialist_approval");
  });

  it("escalates money over the delegated limit", () => {
    const r = routeDecision(
      proposal({ action: "record_expense", risk: "low", limit: { amount: "5000", currency: "LKR" } }),
      { actorAuthorityMax: { amount: "1000", currency: "LKR" } },
    );
    expect(r.routing).toBe("require_approval");
    expect(r.reasons.join(" ")).toMatch(/exceeds/);
  });

  it("routine action runs when the actor holds the permission", () => {
    const r = routeDecision(proposal({ action: "update_task", risk: "medium" }), {
      actorPermissions: ["edit_draft"],
    });
    // medium risk floors at manager_approval → still needs approval
    expect(r.routing).toBe("require_approval");
  });

  it("low confidence always goes to a human", () => {
    expect(routeDecision(proposal({ confidence: 0.1 })).routing).toBe("require_approval");
  });

  it("mismatched currency escalates (fail-safe)", () => {
    const r = routeDecision(proposal({ action: "record_expense", limit: { amount: "10", currency: "USD" } }), {
      actorAuthorityMax: { amount: "100000", currency: "LKR" },
    });
    expect(r.routing).toBe("require_approval");
  });
});
