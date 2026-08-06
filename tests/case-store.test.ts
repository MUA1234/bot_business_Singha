import { describe, it, expect } from "vitest";
import { caseRow } from "@/management/ai-manager/case-store";
import { buildManagementCase } from "@/management/ai-manager/case";
import type { ManagementObservation } from "@/schemas/management";

const observation: ManagementObservation = {
  sourceEventId: "evt-1",
  evidenceRefs: ["doc:1"],
  scope: { companyId: "co-a" },
  involved: { people: [], customers: [], suppliers: [], vehicles: [], assets: [] },
  confirmedFacts: ["paid deposit"],
  inferredFacts: ["wants Friday"],
  detectedTasks: [],
  impact: {},
  confidence: 0.8,
  uncertainty: "date unclear",
  missingInfo: ["address"],
  suggestedActions: [],
  requiredAuthority: "manager_approval",
  followUpDate: null,
};

const mc = buildManagementCase({
  correlationId: "cor_1",
  companyId: "co-a",
  sourceEventId: "evt-1",
  observation,
  proposals: [],
  aiRun: { ai_run_id: "ai_1", model: "gpt-5.6-sol", prompt_version: "mgmt-1.0", cost_usd: "0.01" },
  now: "2026-08-15T00:00:00Z",
});

describe("caseRow (§WP5.1 persistence mapping)", () => {
  it("maps facts, evidence, uncertainty, correlation + ai_run link", () => {
    const row = caseRow(mc, { createdBy: "u1", createdTasks: 2 });
    expect(row).toMatchObject({
      company_id: "co-a",
      correlation_id: "cor_1",
      source_event_id: "evt-1",
      ai_run_id: "ai_1",
      confirmed_facts: ["paid deposit"],
      inferred_facts: ["wants Friday"],
      evidence_refs: ["doc:1"],
      uncertainty: "date unclear",
      confidence: 0.8,
      required_authority: "manager_approval",
      created_tasks: 2,
      created_by: "u1",
    });
  });

  it("requires_human reflects the planner override even with no structured proposals", () => {
    expect(caseRow(mc, { createdBy: null, createdTasks: 0, requiresHuman: true }).requires_human).toBe(true);
    expect(caseRow(mc, { createdBy: null, createdTasks: 0 }).requires_human).toBe(false);
  });
});
