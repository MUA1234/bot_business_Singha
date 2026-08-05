import { describe, it, expect } from "vitest";
import { planFromObservation } from "@/management/ai-manager/pipeline";
import { ManagementObservation } from "@/schemas/management";

function obs(over: Record<string, unknown>) {
  return ManagementObservation.parse({
    sourceEventId: "manual",
    scope: { companyId: "co-1" },
    confidence: 0.8,
    requiredAuthority: "automatic",
    ...over,
  });
}

describe("observation → plan (change plan §6.2)", () => {
  it("maps detected tasks and stays no-approval for automatic authority", () => {
    const plan = planFromObservation(obs({
      detectedTasks: [{ title: "Call supplier", note: "confirm delivery" }, { title: "Update stock" }],
      requiredAuthority: "automatic",
    }));
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]!.title).toBe("Call supplier");
    expect(plan.needsApproval).toBe(false);
  });

  it("flags approval for manager/specialist/owner authority", () => {
    expect(planFromObservation(obs({ requiredAuthority: "specialist_approval" })).needsApproval).toBe(true);
    expect(planFromObservation(obs({ requiredAuthority: "owner_approval" })).needsApproval).toBe(true);
    expect(planFromObservation(obs({ requiredAuthority: "policy_controlled" })).needsApproval).toBe(false);
  });

  it("requires evidence on tasks when there is material impact", () => {
    const plan = planFromObservation(obs({
      detectedTasks: [{ title: "Reconcile payment" }],
      impact: { financial: "LKR 50,000 unaccounted" },
    }));
    expect(plan.tasks[0]!.requiresEvidence).toBe(true);
  });

  it("passes through clarifications and suggested actions", () => {
    const plan = planFromObservation(obs({ missingInfo: ["which project?"], suggestedActions: ["ask site manager"] }));
    expect(plan.clarifications).toEqual(["which project?"]);
    expect(plan.suggestedActions).toEqual(["ask site manager"]);
  });
});
