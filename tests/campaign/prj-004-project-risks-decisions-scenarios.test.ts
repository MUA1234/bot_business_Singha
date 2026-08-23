/**
 * PRJ-004 — Per-project risk register, decision log and scenario comparison.
 *
 * Verifies the project detail page and pure helpers surface risks, decisions and
 * scenario comparison without requiring a live database.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { riskExposureLevel, riskNeedsReview } from "@/modules/project/risks";
import { isValidDecisionOption, decisionStatusLabel } from "@/modules/project/decisions";
import { compareScenarios } from "@/modules/project/scenarios";

const DETAIL = "src/app/app/operations/projects/[id]/page.tsx";
const ACTIONS = "src/app/app/operations/projects/actions.ts";
const RISKS_MODULE = "src/modules/project/risks.ts";
const DECISIONS_MODULE = "src/modules/project/decisions.ts";
const SCENARIOS_MODULE = "src/modules/project/scenarios.ts";
const MIGRATION = "src/db/migrations/0107_project_risks_decisions_scenarios.sql";
const RLS = "security/rls-classification.json";

describe("PRJ-004 — project risks, decisions and scenarios surface", () => {
  const detail = readFileSync(DETAIL, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const risks = readFileSync(RISKS_MODULE, "utf8");
  const decisions = readFileSync(DECISIONS_MODULE, "utf8");
  const scenarios = readFileSync(SCENARIOS_MODULE, "utf8");
  const migration = readFileSync(MIGRATION, "utf8");
  const rls = readFileSync(RLS, "utf8");

  it("has a migration adding project_risks, project_decisions and project_scenarios", () => {
    expect(migration).toContain("create table if not exists project_risks");
    expect(migration).toContain("create table if not exists project_decisions");
    expect(migration).toContain("create table if not exists project_scenarios");
    expect(migration).toContain("operations.project.manage");
    expect(migration).toContain("project_risks_read");
    expect(migration).toContain("project_decisions_read");
    expect(migration).toContain("project_scenarios_read");
  });

  it("classifies the new tables as capability-gated in the RLS matrix", () => {
    expect(rls).toContain('"project_risks": "capability"');
    expect(rls).toContain('"project_decisions": "capability"');
    expect(rls).toContain('"project_scenarios": "capability"');
  });

  it("exports pure deterministic helper modules", () => {
    expect(risks).toContain("export function riskExposureLevel");
    expect(risks).toContain("export function riskNeedsReview");
    expect(decisions).toContain("export function isValidDecisionOption");
    expect(decisions).toContain("export function decisionStatusLabel");
    expect(scenarios).toContain("export function compareScenarios");
  });

  it("the detail page surfaces project risks with exposure and review state", () => {
    expect(detail).toContain("Project risks");
    expect(detail).toContain("riskExposureLevel");
    expect(detail).toContain("riskNeedsReview");
    expect(detail).toContain("updateProjectRiskStatus");
    expect(detail).toContain('name="risk_id"');
  });

  it("the detail page surfaces project decisions and a record-decision form", () => {
    expect(detail).toContain("Project decisions");
    expect(detail).toContain("decisionStatusLabel");
    expect(detail).toContain("createProjectDecision");
    expect(detail).toContain("decideProjectDecision");
    expect(detail).toContain('name="decision_id"');
  });

  it("the detail page surfaces scenario comparison with advisory preference", () => {
    expect(detail).toContain("Scenario comparison");
    expect(detail).toContain("compareScenarios");
    expect(detail).toContain("createProjectScenario");
    expect(detail).toContain("chooseProjectScenario");
    expect(detail).toContain("advisory preferred");
  });

  it("provides gated create/update actions with audit", () => {
    expect(actions).toContain("export async function createProjectRisk");
    expect(actions).toContain("export async function updateProjectRiskStatus");
    expect(actions).toContain("export async function createProjectDecision");
    expect(actions).toContain("export async function decideProjectDecision");
    expect(actions).toContain("export async function createProjectScenario");
    expect(actions).toContain("export async function chooseProjectScenario");
    expect(actions).toContain("project_risk.created");
    expect(actions).toContain("project_decision.decided");
    expect(actions).toContain("project_scenario.chosen");
  });

  it("computes risk exposure level from impact × likelihood", () => {
    expect(riskExposureLevel({ impact: "high", likelihood: "high", status: "open" })).toBe("high");
    expect(riskExposureLevel({ impact: "critical", likelihood: "critical", status: "open" })).toBe("severe");
  });

  it("flags a risk whose review date has arrived", () => {
    expect(riskNeedsReview(new Date(Date.now() - 86400000).toISOString().slice(0, 10))).toBe(true);
    expect(riskNeedsReview(null)).toBe(false);
  });

  it("validates decision options", () => {
    const options = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
    expect(isValidDecisionOption(options, "a")).toBe(true);
    expect(isValidDecisionOption(options, "c")).toBe(false);
  });

  it("labels decision statuses", () => {
    expect(decisionStatusLabel("pending")).toBe("pending");
    expect(decisionStatusLabel("decided", "a")).toBe("decided");
    expect(decisionStatusLabel("reversed")).toBe("reversed");
  });

  it("prefers the scenario with the highest expected total", () => {
    const result = compareScenarios([
      { id: "s1", title: "A", bestCaseTotal: "110", expectedTotal: "100", worstCaseTotal: "90", currency: "LKR" },
      { id: "s2", title: "B", bestCaseTotal: "120", expectedTotal: "115", worstCaseTotal: "80", currency: "LKR" },
    ]);
    expect(result.preferredId).toBe("s2");
  });
});
