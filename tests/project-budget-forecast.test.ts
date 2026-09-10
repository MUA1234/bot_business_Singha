import { describe, it, expect } from "vitest";
import { computeProjectBudgetForecast } from "@/modules/project/budget-forecast";
import { computeResourceRequirements } from "@/modules/project/resource-requirements";

const currency = "LKR";
const projectId = "prj-1";

const periods = [
  { id: "p1", name: "Jan 2026", start_date: "2026-01-01", end_date: "2026-01-31" },
  { id: "p2", name: "Feb 2026", start_date: "2026-02-01", end_date: "2026-02-28" },
];

const today = "2026-01-15";

describe("PRJ-003 — project budget and forecast", () => {
  it("filters budget lines and journal activity to the requested project", () => {
    const budgetLines = [
      { id: "bl-1", account_code: "EXP-001", project_id: projectId, period_id: "p1", amount: "10000.00" },
      { id: "bl-2", account_code: "EXP-001", project_id: "prj-2", period_id: "p1", amount: "5000.00" },
    ];
    const journalEntries = [
      {
        id: "je-1",
        posting_date: "2026-01-15",
        journal_lines: [{ id: "jl-1", account_code: "EXP-001", debit: "3000.00", credit: "0", project_id: projectId }],
      },
      {
        id: "je-2",
        posting_date: "2026-01-20",
        journal_lines: [{ id: "jl-2", account_code: "EXP-001", debit: "2000.00", credit: "0", project_id: "prj-2" }],
      },
    ];

    const r = computeProjectBudgetForecast({ projectId, budgetLines, journalEntries, periods, currency });

    expect(r.budgetVsActual.lines).toHaveLength(1);
    expect(r.budgetVsActual.lines[0]!.actual).toBe("3000.00");
    expect(r.budgetVsActual.lines[0]!.variance).toBe("-7000.00");
  });

  it("computes exact decimal budget, actual and variance", () => {
    const budgetLines = [
      { id: "bl-1", account_code: "EXP-001", project_id: projectId, period_id: "p1", amount: "1000.00" },
      { id: "bl-2", account_code: "EXP-002", project_id: projectId, period_id: "p1", amount: "2500.00" },
    ];
    const journalEntries = [
      {
        id: "je-1",
        posting_date: "2026-01-10",
        journal_lines: [
          { id: "jl-1", account_code: "EXP-001", debit: "400.00", credit: "0", project_id: projectId },
          { id: "jl-2", account_code: "EXP-002", debit: "1000.00", credit: "200.00", project_id: projectId },
        ],
      },
    ];

    const r = computeProjectBudgetForecast({ projectId, budgetLines, journalEntries, periods, currency });

    expect(r.budgetVsActual.totals.budgeted).toBe("3500.00");
    expect(r.budgetVsActual.totals.actual).toBe("1200.00");
    expect(r.budgetVsActual.totals.variance).toBe("-2300.00");
  });

  it("aggregates a forecast curve by period sorted by start date", () => {
    const budgetLines = [
      { id: "bl-1", account_code: "EXP-001", project_id: projectId, period_id: "p1", amount: "10000.00" },
      { id: "bl-2", account_code: "EXP-001", project_id: projectId, period_id: "p2", amount: "12000.00" },
    ];
    const journalEntries = [
      {
        id: "je-1",
        posting_date: "2026-01-15",
        journal_lines: [{ id: "jl-1", account_code: "EXP-001", debit: "3000.00", credit: "0", project_id: projectId }],
      },
      {
        id: "je-2",
        posting_date: "2026-02-10",
        journal_lines: [{ id: "jl-2", account_code: "EXP-001", debit: "2500.00", credit: "0", project_id: projectId }],
      },
    ];

    const r = computeProjectBudgetForecast({ projectId, budgetLines, journalEntries, periods, currency });

    expect(r.forecastCurve).toHaveLength(2);
    expect(r.forecastCurve[0]!.periodId).toBe("p1");
    expect(r.forecastCurve[0]!.budgeted).toBe("10000.00");
    expect(r.forecastCurve[0]!.actual).toBe("3000.00");
    expect(r.forecastCurve[0]!.variance).toBe("-7000.00");
    expect(r.forecastCurve[1]!.periodId).toBe("p2");
    expect(r.forecastCurve[1]!.actual).toBe("2500.00");
  });

  it("fills missing periods with zero in the forecast curve", () => {
    const budgetLines = [
      { id: "bl-1", account_code: "EXP-001", project_id: projectId, period_id: "p1", amount: "1000.00" },
    ];
    const journalEntries: any[] = [];

    const r = computeProjectBudgetForecast({ projectId, budgetLines, journalEntries, periods, currency });

    expect(r.forecastCurve[0]!.budgeted).toBe("1000.00");
    expect(r.forecastCurve[1]!.budgeted).toBe("0.00");
    expect(r.forecastCurve[1]!.actual).toBe("0.00");
  });

  it("returns zero totals when the project has no budget lines", () => {
    const r = computeProjectBudgetForecast({ projectId, budgetLines: [], journalEntries: [], periods, currency });

    expect(r.budgetVsActual.totals.budgeted).toBe("0.00");
    expect(r.budgetVsActual.totals.actual).toBe("0.00");
    expect(r.budgetVsActual.totals.variancePercent).toBeNull();
  });
});

describe("PRJ-003 — project resource requirements", () => {
  const tasks = [
    { id: "t1", project_id: projectId, status: "in_progress" as const, title: "Task 1", estimate_hours: 10, actual_hours: 4, remaining_hours: 6, due_date: "2026-01-20" },
    { id: "t2", project_id: projectId, status: "blocked" as const, title: "Task 2", estimate_hours: 8, actual_hours: 1, remaining_hours: null, due_date: "2026-01-10" },
    { id: "t3", project_id: projectId, status: "completed" as const, title: "Task 3", estimate_hours: 5, actual_hours: 5, remaining_hours: 0, due_date: "2026-01-12" },
    { id: "t4", project_id: "prj-2", status: "in_progress" as const, title: "Other project", estimate_hours: 20, actual_hours: 0, remaining_hours: 20, due_date: "2026-01-18" },
  ];

  const assignments = [
    { id: "a1", task_id: "t1", membership_id: "m1", estimate_hours: null },
    { id: "a2", task_id: "t2", membership_id: "m1", estimate_hours: 8 },
  ];

  const memberships = [
    { id: "m1", user_id: "u1" },
  ];

  const employees = [
    { id: "u1", full_name: "Alice", username: "alice", contracted_weekly_hours: 20, reserved_weekly_hours: 0 },
  ];

  it("filters tasks to the requested project", () => {
    const r = computeResourceRequirements({ projectId, tasks, assignments, memberships, employees, today });

    expect(r.totals.plannedHours).toBe(23); // 10 + 8 + 5
    expect(r.totals.blockedTasks).toBe(1);
  });

  it("counts blocked and overdue tasks", () => {
    const r = computeResourceRequirements({ projectId, tasks, assignments, memberships, employees, today });

    expect(r.totals.blockedTasks).toBe(1);
    expect(r.totals.overdueTasks).toBe(1); // t2 due 2026-01-10
    expect(r.totals.openTasks).toBe(2); // in_progress + blocked
  });

  it("summarises assigned people with capacity detail", () => {
    const r = computeResourceRequirements({ projectId, tasks, assignments, memberships, employees, today });

    expect(r.people).toHaveLength(1);
    expect(r.people[0]!.name).toBe("Alice");
    expect(r.people[0]!.plannedHours).toBe(18); // t1 assignment uses task estimate 10 + t2 assignment 8
    expect(r.people[0]!.capacity.netAvailableHours).toBe(20);
    expect(r.people[0]!.status).toBe("healthy");
  });

  it("flags overloaded people when remaining effort exceeds net capacity", () => {
    const overloadedTasks = [
      { id: "t5", project_id: projectId, status: "in_progress" as const, title: "Big task", estimate_hours: 60, actual_hours: 0, remaining_hours: 60, due_date: "2026-01-25" },
    ];
    const overloadedAssignments = [{ id: "a3", task_id: "t5", membership_id: "m1", estimate_hours: null }];

    const r = computeResourceRequirements({ projectId, tasks: overloadedTasks, assignments: overloadedAssignments, memberships, employees, today });

    expect(r.people[0]!.status).toBe("overloaded");
    expect(r.totals.utilizationStatus).toBe("overloaded");
  });

  it("reports unassigned tasks separately", () => {
    const r = computeResourceRequirements({ projectId, tasks, assignments: [], memberships: [], employees: [], today });

    expect(r.unassigned.taskCount).toBe(3);
    expect(r.people).toHaveLength(0);
  });
});
