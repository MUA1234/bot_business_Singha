/**
 * SCH-003 — Leave and workload-aware scheduling.
 *
 * The follow-ups cron route must skip assignees on approved leave, rank reachable
 * assignees by current workload, and advance past on-leave escalation targets.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const ROUTE = "src/app/api/cron/follow-ups/route.ts";
const AVAILABILITY = "src/modules/work/availability.ts";
const ACTIONS = "src/app/app/operations/tasks/actions.ts";

describe("SCH-003 — Leave and workload-aware scheduling", () => {
  const route = readFileSync(ROUTE, "utf8");
  const availability = readFileSync(AVAILABILITY, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");

  it("imports pure availability helpers", () => {
    expect(route).toContain("@/modules/work/availability");
    expect(route).toContain("evaluateAvailability");
    expect(route).toContain("rankAvailableCandidates");
  });

  it("has a pure availability module exposing leave and workload helpers", () => {
    expect(availability).toContain("export function isOnLeave");
    expect(availability).toContain("export function evaluateAvailability");
    expect(availability).toContain("export function rankAvailableCandidates");
    expect(availability).toContain("export function selectBestAvailable");
  });

  it("reads approved leave_requests to determine availability", () => {
    expect(route).toContain('from("leave_requests")');
    expect(route).toContain('eq("status", "approved")');
    expect(route).toContain("leaveByUser");
  });

  it("reads active task estimates to determine workload", () => {
    expect(route).toContain("workloadByUser");
    expect(route).toContain("estimate_hours");
    expect(route).toContain('not("tasks.status", "in", "(completed,cancelled)")');
  });

  it("skips assignees on approved leave when sending reminders", () => {
    expect(route).toContain("if (!avail.available)");
    expect(route).toContain("skippedLeave++");
  });

  it("ranks available assignees by workload before reminding", () => {
    expect(route).toContain("rankAvailableCandidates(userIds.map((id) => availabilityFor(id)))");
  });

  it("advances past on-leave escalation targets before selecting one", () => {
    expect(route).toContain("while (level < safeChain.length)");
    expect(route).toContain("const avail = availabilityFor(candidate)");
    expect(route).toContain("if (avail.available)");
  });

  it("falls back to available admins when the chain is exhausted or all targets are on leave", () => {
    expect(route).toContain("rankAvailableCandidates(\n          (adminsByCompany.get(t.company_id) ?? []).map((a) => availabilityFor(a.id)),\n        )");
  });

  it("reports skipped leave in the cron response and audit payload", () => {
    expect(route).toContain("skippedLeave");
    expect(route).toContain("{ tasks: (tasks ?? []).length, enqueued, remindedTasks, escalatedTasks, skippedLeave, date: day }");
  });

  it("refuses to assign a task to someone on approved leave", () => {
    expect(actions).toContain('from("leave_requests")');
    expect(actions).toContain('eq("status", "approved")');
    expect(actions).toContain("isOnLeave");
    expect(actions).toContain("task.assignment_refused_leave");
  });

  it("still permits unassignment when the assignee field is empty", () => {
    expect(actions).toContain('patch.assigned_to = null');
  });
});
