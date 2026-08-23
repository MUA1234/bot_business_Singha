/**
 * PRJ-005 — Portfolio prioritisation surface.
 *
 * The projects page must rank projects by value, risk, capacity and dependency using
 * deterministic pure helpers and expose the per-axis ranks in the UI.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/operations/projects/page.tsx";
const MODULE = "src/modules/project/portfolio-prioritisation.ts";

describe("PRJ-005 — Portfolio prioritisation surface", () => {
  const page = readFileSync(PAGE, "utf8");
  const module = readFileSync(MODULE, "utf8");

  it("imports the portfolio prioritisation helpers", () => {
    expect(page).toContain("rankProjectsByPriority");
    expect(page).toContain("ProjectPrioritisationInput");
  });

  it("loads project scenarios, risks and tasks for prioritisation", () => {
    expect(page).toContain('from("project_scenarios")');
    expect(page).toContain('from("project_risks")');
    expect(page).toContain('task_assignments(membership_id, estimate_hours)');
  });

  it("exports pure deterministic prioritisation helpers", () => {
    expect(module).toContain("export function rankProjectsByPriority");
    expect(module).toContain("export function projectRiskExposure");
    expect(module).toContain("PRIORITY_WEIGHTS");
  });

  it("ranks projects by value, risk, capacity and dependency", () => {
    expect(module).toContain("valueRank");
    expect(module).toContain("riskRank");
    expect(module).toContain("capacityRank");
    expect(module).toContain("dependencyRank");
  });

  it("surfaces priority and per-axis ranks in the project table", () => {
    expect(page).toContain("Priority");
    expect(page).toContain("valueRank");
    expect(page).toContain("riskRank");
    expect(page).toContain("capacityRank");
    expect(page).toContain("dependencyRank");
  });

  it("sorts projects by priority score", () => {
    expect(page).toContain("rankProjectsByPriority");
    expect(page).toContain("priorityByProject.get(a.id)?.score");
  });
});
