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
    // Completed and cancelled work must not count toward anyone's load.
    expect(route).toContain('not("status", "in", "(completed,cancelled)")');
  });

  it("does NOT compute workload through an ambiguous PostgREST embed", () => {
    // Finding F-003. This was read as
    //   task_assignments.select("memberships!inner(user_id), tasks!inner(estimate_hours)")
    // filtered by `tasks.status` and `memberships.status`. That embed cannot be answered:
    // `task_assignments` holds three foreign keys into `tasks` and two into `memberships`,
    // so PostgREST refuses it as ambiguous (PGRST201) and returns an error — which made
    // `workloadError` truthy and this cron return 500 on EVERY run.
    //
    // The previous version of the test above asserted the embed's filter syntax verbatim,
    // which is why a route that could never succeed still passed its suite.
    expect(route).not.toContain("memberships!inner(user_id)");
    expect(route).not.toContain("tasks!inner(estimate_hours)");
    expect(route).not.toContain('not("tasks.status", "in", "(completed,cancelled)")');
    expect(route).not.toContain('eq("memberships.status", "active")');
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

  /**
   * REPLACED (defect PR-F-013). This assertion checked that the route's SOURCE TEXT
   * contained a specific multi-line expression. The embedded `\n` never matched on a CRLF
   * checkout, so it was the single red test on the approved baseline — red for a reason
   * unrelated to the behaviour it claimed to protect. It also could not distinguish a
   * working fallback from a broken one: the characters are present either way.
   *
   * The invariant is now covered behaviourally, by driving the real route handler against a
   * controlled database, in `sch-003-escalation-fallback-behaviour.test.ts`. That test
   * proves the fallback actually happens, that the on-leave chain member is skipped, that
   * admins are ordered by workload, and that a re-run cannot spam — and it reproduced a
   * genuine defect (R1-F-001) this assertion had been passing over.
   *
   * Nothing was weakened: one non-discriminating text check was removed and replaced with
   * seven behavioural ones. The remaining assertions in this file are single-line and
   * CRLF-safe, and are retained as cheap wiring checks.
   */

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
