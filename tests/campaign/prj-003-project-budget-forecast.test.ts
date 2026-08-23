/**
 * PRJ-003 — Project budgets, forecasts and resource requirements.
 *
 * Verifies the new project detail page and pure helpers surface budget vs actual,
 * forecast curves and resource concepts without requiring a live database.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { computeProjectBudgetForecast } from "@/modules/project/budget-forecast";
import { computeResourceRequirements } from "@/modules/project/resource-requirements";

const LIST = "src/app/app/operations/projects/page.tsx";
const DETAIL = "src/app/app/operations/projects/[id]/page.tsx";
const ACTIONS = "src/app/app/operations/projects/actions.ts";
const BUDGET_FORECAST = "src/modules/project/budget-forecast.ts";
const RESOURCE_REQUIREMENTS = "src/modules/project/resource-requirements.ts";

describe("PRJ-003 — project budget, forecast and resources surface", () => {
  const list = readFileSync(LIST, "utf8");
  const detail = readFileSync(DETAIL, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const budgetForecast = readFileSync(BUDGET_FORECAST, "utf8");
  const resourceRequirements = readFileSync(RESOURCE_REQUIREMENTS, "utf8");

  it("exports pure deterministic helper modules", () => {
    expect(budgetForecast).toContain("export function computeProjectBudgetForecast");
    expect(budgetForecast).toContain("computeBudgetVsActual");
    expect(budgetForecast).toContain("Money");
    expect(resourceRequirements).toContain("export function computeResourceRequirements");
    expect(resourceRequirements).toContain("computeCapacityDetail");
  });

  it("has a real runtime detail entrypoint under /app/operations/projects/[id]", () => {
    expect(detail).toContain("export default async function ProjectDetailPage");
    expect(detail).toContain('from("projects")');
    expect(detail).toContain("requireDepartment(\"operations\")");
    expect(detail).toContain("company_id");
  });

  it("links the project list to the detail page", () => {
    expect(list).toContain('/app/operations/projects/${proj.id}');
  });

  it("uses the budget/forecast helper on the detail page", () => {
    expect(detail).toContain("computeProjectBudgetForecast");
    expect(detail).toContain("computeResourceRequirements");
  });

  it("shows budgeted, actual, variance and variance %", () => {
    expect(detail).toContain("Budgeted");
    expect(detail).toContain("Actual");
    expect(detail).toContain("Variance");
    expect(detail).toContain("variancePercent");
  });

  it("shows a forecast curve by period", () => {
    expect(detail).toContain("Forecast curve by period");
    expect(detail).toContain("forecastCurve");
    expect(detail).toContain("periodId");
  });

  it("shows resource requirements: people, planned/actual/remaining hours, blocked/overdue", () => {
    expect(detail).toContain("Resource requirements");
    expect(detail).toContain("Assigned people");
    expect(detail).toContain("Planned hours");
    expect(detail).toContain("Actual hours");
    expect(detail).toContain("Remaining hours");
    expect(detail).toContain("Blocked");
    expect(detail).toContain("Overdue");
  });

  it("provides a gated status update action with audit", () => {
    expect(actions).toContain('"use server"');
    expect(actions).toContain("export async function updateProjectStatus");
    expect(actions).toContain("project.status_updated");
    expect(actions).toContain('"active"');
    expect(actions).toContain('"on_hold"');
    expect(actions).toContain('"completed"');
    expect(actions).toContain('"cancelled"');
  });

  it("detail page wires the status update action", () => {
    expect(detail).toContain("updateProjectStatus");
    expect(detail).toContain('name="project_id"');
    expect(detail).toContain('name="status"');
  });

  it("computes project budget vs actual with exact decimals", () => {
    const r = computeProjectBudgetForecast({
      projectId: "prj-1",
      budgetLines: [{ id: "bl-1", account_code: "EXP-001", project_id: "prj-1", period_id: "p1", amount: "10000.00" }],
      journalEntries: [
        {
          id: "je-1",
          posting_date: "2026-01-15",
          journal_lines: [{ id: "jl-1", account_code: "EXP-001", debit: "3500.00", credit: "0", project_id: "prj-1" }],
        },
      ],
      periods: [{ id: "p1", start_date: "2026-01-01", end_date: "2026-01-31" }],
      currency: "LKR",
    });

    expect(r.budgetVsActual.totals.budgeted).toBe("10000.00");
    expect(r.budgetVsActual.totals.actual).toBe("3500.00");
    expect(r.budgetVsActual.totals.variance).toBe("-6500.00");
    expect(r.forecastCurve[0]!.variance).toBe("-6500.00");
  });

  it("filters budget and actuals to the requested project", () => {
    const r = computeProjectBudgetForecast({
      projectId: "prj-1",
      budgetLines: [
        { id: "bl-1", account_code: "EXP-001", project_id: "prj-1", period_id: "p1", amount: "1000.00" },
        { id: "bl-2", account_code: "EXP-001", project_id: "prj-2", period_id: "p1", amount: "5000.00" },
      ],
      journalEntries: [
        {
          id: "je-1",
          posting_date: "2026-01-10",
          journal_lines: [
            { id: "jl-1", account_code: "EXP-001", debit: "200.00", credit: "0", project_id: "prj-1" },
            { id: "jl-2", account_code: "EXP-001", debit: "3000.00", credit: "0", project_id: "prj-2" },
          ],
        },
      ],
      periods: [{ id: "p1", start_date: "2026-01-01", end_date: "2026-01-31" }],
      currency: "LKR",
    });

    expect(r.budgetVsActual.lines).toHaveLength(1);
    expect(r.budgetVsActual.lines[0]!.actual).toBe("200.00");
  });

  it("computes resource requirements for assigned staff", () => {
    const r = computeResourceRequirements({
      projectId: "prj-1",
      tasks: [
        { id: "t1", project_id: "prj-1", status: "in_progress", title: "A", estimate_hours: 10, actual_hours: 4, remaining_hours: 6, due_date: "2026-01-20" },
        { id: "t2", project_id: "prj-1", status: "blocked", title: "B", estimate_hours: 8, actual_hours: 1, remaining_hours: null, due_date: "2026-01-10" },
      ],
      assignments: [
        { id: "a1", task_id: "t1", membership_id: "m1", estimate_hours: null },
        { id: "a2", task_id: "t2", membership_id: "m1", estimate_hours: 8 },
      ],
      memberships: [{ id: "m1", user_id: "u1" }],
      employees: [{ id: "u1", full_name: "Alice", username: "alice", contracted_weekly_hours: 20, reserved_weekly_hours: 0 }],
      today: "2026-01-15",
    });

    expect(r.people).toHaveLength(1);
    expect(r.people[0]!.name).toBe("Alice");
    expect(r.totals.blockedTasks).toBe(1);
    expect(r.totals.overdueTasks).toBe(1);
  });
});
