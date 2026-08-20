/**
 * AIM-003 — routing of captured tasks, and the truthfulness of what the UI is given.
 *
 * The defect being regressed against: the Analyze screen said "routed for human approval" when no
 * request, queue, recipient or record existed. These tests assert the SUMMARY the UI renders is
 * derived from routing calls that actually happened.
 */
import { describe, it, expect, vi } from "vitest";
import { routeCapturedTasks, captureRoutingState, type RoutingDeps } from "@/management/routing/route-captured-tasks";

const deps = (over: Partial<RoutingDeps> = {}): RoutingDeps => ({
  listCaseTasks: async () => [{ id: "t1" }, { id: "t2" }],
  routeTask: async (i) => ({ state: i.state, reasonCode: i.reasonCode }),
  ...over,
});

describe("AIM-003 — captured work is never described as assigned", () => {
  it("routine captured work becomes needs_routing, not assigned", () => {
    const d = captureRoutingState(false);
    expect(d.state).toBe("needs_routing");
    expect(d.state).not.toBe("assigned");
    expect(d.reasonCode).toBe("captured_no_assignee_recommender");
  });

  it("work above routine authority becomes manual_review, not awaiting_approval", () => {
    // There is no approval queue yet. Claiming `awaiting_approval` would name a destination that
    // does not exist — the same class of untruth this requirement exists to remove.
    const d = captureRoutingState(true);
    expect(d.state).toBe("manual_review");
    expect(d.state).not.toBe("awaiting_approval");
  });

  it("every captured task gets a durable routing call", async () => {
    const routeTask = vi.fn(async (i: any) => ({ state: i.state, reasonCode: i.reasonCode }));
    const s = await routeCapturedTasks(deps({ routeTask }), {
      companyId: "co-1", managementCaseId: "case-1", needsApproval: false, actorId: "actor-1",
    });
    expect(routeTask).toHaveBeenCalledTimes(2);
    expect(s.routed).toBe(2);
    expect(s.byState).toEqual({ needs_routing: 2 });
    expect(s.failed).toBe(0);
  });

  it("the summary reflects the state the DATABASE returned, not the state requested", async () => {
    // route_task may degrade a request (e.g. an ineligible assignee). The UI must show what was
    // committed, so the summary is built from the RPC's answer.
    const s = await routeCapturedTasks(
      deps({ routeTask: async () => ({ state: "no_eligible_assignee", reasonCode: "lacks_required_capability" }) }),
      { companyId: "co-1", managementCaseId: "case-1", needsApproval: false, actorId: null },
    );
    expect(s.byState).toEqual({ no_eligible_assignee: 2 });
  });

  it("a routing failure is COUNTED, never silently dropped", async () => {
    const s = await routeCapturedTasks(
      deps({
        routeTask: async (i) => {
          if (i.taskId === "t2") throw new Error("db down");
          return { state: i.state, reasonCode: i.reasonCode };
        },
      }),
      { companyId: "co-1", managementCaseId: "case-1", needsApproval: false, actorId: null },
    );
    expect(s.routed).toBe(1);
    expect(s.failed).toBe(1);
  });

  it("if the task list cannot be read, nothing is claimed as routed", async () => {
    const s = await routeCapturedTasks(
      deps({ listCaseTasks: async () => { throw new Error("unavailable"); } }),
      { companyId: "co-1", managementCaseId: "case-1", needsApproval: true, actorId: null },
    );
    expect(s.routed).toBe(0);
    expect(s.byState).toEqual({});
  });

  it("no captured tasks means an empty summary, not a claim", async () => {
    const s = await routeCapturedTasks(deps({ listCaseTasks: async () => [] }), {
      companyId: "co-1", managementCaseId: "case-1", needsApproval: false, actorId: null,
    });
    expect(s).toEqual({ routed: 0, byState: {}, failed: 0 });
  });
});
