import { describe, it, expect } from "vitest";
import { buildManagementCase, type ManagementCaseInput } from "@/management/ai-manager/case";
import type { ManagementObservation, DecisionProposal } from "@/schemas/management";
import { routeDecision } from "@/management/policy/route-decision";

const observation: ManagementObservation = {
  sourceEventId: "evt-1",
  evidenceRefs: ["doc:1", "wa:99"],
  scope: { companyId: "co-a" },
  involved: { people: [], customers: [], suppliers: [], vehicles: [], assets: [] },
  confirmedFacts: ["Customer paid deposit"],
  inferredFacts: ["Likely wants delivery Friday"],
  detectedTasks: [],
  impact: {},
  confidence: 0.8,
  uncertainty: "delivery date not explicit",
  missingInfo: ["confirm address"],
  suggestedActions: ["confirm delivery date"],
  requiredAuthority: "manager_approval",
  followUpDate: null,
};

function proposal(over: Partial<DecisionProposal>): DecisionProposal {
  return {
    action: "summarise_records",
    reason: "r",
    expectedOutcome: "o",
    evidenceRefs: [],
    confidence: 1,
    risk: "low",
    policyVersion: "v1",
    requiredPermission: "view",
    requiredApprovers: [],
    limit: null,
    expiresAt: "2026-12-31T00:00:00Z",
    conditions: [],
    reversalPlan: null,
    ...over,
  };
}

function input(over: Partial<ManagementCaseInput> = {}): ManagementCaseInput {
  return {
    correlationId: "cor_1",
    companyId: "co-a",
    sourceEventId: "evt-1",
    observation,
    proposals: [],
    now: "2026-08-15T00:00:00Z",
    ...over,
  };
}

describe("buildManagementCase (§WP5.1)", () => {
  it("keeps confirmed vs inferred facts, evidence, uncertainty separate", () => {
    const c = buildManagementCase(input());
    expect(c.confirmedFacts).toEqual(["Customer paid deposit"]);
    expect(c.inferredFacts).toEqual(["Likely wants delivery Friday"]);
    expect(c.uncertainty).toBe("delivery date not explicit");
    expect(c.evidenceRefs).toContain("doc:1");
    expect(c.confidence).toBe(0.8);
  });

  it("ties company + source event from trusted input (not the model)", () => {
    const c = buildManagementCase(input({ companyId: "co-trusted" }));
    expect(c.companyId).toBe("co-trusted");
    expect(c.sourceEventId).toBe("evt-1");
    expect(c.correlationId).toBe("cor_1");
  });

  it("records each proposal's routing as 'proposed' and flags requiresHuman", () => {
    const benign = proposal({ action: "summarise_records" });
    const sensitive = proposal({ action: "post_journal_now" });
    const c = buildManagementCase(
      input({
        proposals: [
          { proposal: benign, routing: routeDecision(benign, {}) },
          { proposal: sensitive, routing: routeDecision(sensitive, {}) },
        ],
      }),
    );
    expect(c.decisions).toHaveLength(2);
    expect(c.decisions.every((d) => d.status === "proposed")).toBe(true);
    expect(c.requiresHuman).toBe(true); // the sensitive one needs approval
  });

  it("carries the AI run cost/latency reference for the cost ledger", () => {
    const c = buildManagementCase(input({ aiRun: { ai_run_id: "ai_1", model: "gpt-5.6-sol", prompt_version: "p1", cost_usd: "0.0132", latency_ms: 420 } }));
    expect(c.aiRun?.cost_usd).toBe("0.0132");
    expect(c.aiRun?.latency_ms).toBe(420);
  });

  it("no proposals ⇒ requiresHuman false", () => {
    expect(buildManagementCase(input()).requiresHuman).toBe(false);
  });
});
