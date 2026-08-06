import { describe, it, expect } from "vitest";
import { canActOnTask, type TaskActor, type TaskRef } from "@/modules/identity/can-act-on-task";

const CO_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CO_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function actor(over: Partial<TaskActor> = {}): TaskActor {
  return {
    companyId: CO_A,
    membershipId: "m-1",
    userId: "u-1",
    isAdmin: false,
    isManager: false,
    ...over,
  };
}
function task(over: Partial<TaskRef> = {}): TaskRef {
  return { companyId: CO_A, assignedToUserId: null, assigneeMembershipIds: [], ...over };
}

describe("canActOnTask", () => {
  it("blocks any action across companies", () => {
    const a = actor({ isAdmin: true, companyId: CO_A });
    expect(canActOnTask(a, task({ companyId: CO_B }), "view").allowed).toBe(false);
  });

  it("assignee may update progress / add evidence / accept / submit estimate", () => {
    const a = actor({ userId: "u-9" });
    const t = task({ assignedToUserId: "u-9" });
    for (const act of ["view", "update_progress", "add_evidence", "accept", "submit_estimate", "request_verification"] as const) {
      expect(canActOnTask(a, t, act).allowed).toBe(true);
    }
  });

  it("assignee may NOT verify, approve, reassign, edit plan, or cancel own task", () => {
    const a = actor({ userId: "u-9" });
    const t = task({ assignedToUserId: "u-9" });
    for (const act of ["verify", "approve_completion", "reassign", "edit_plan", "cancel"] as const) {
      expect(canActOnTask(a, t, act).allowed).toBe(false);
    }
  });

  it("recognises assignment by membership id, not only by user id", () => {
    const a = actor({ membershipId: "m-7", userId: "u-x" });
    const t = task({ assigneeMembershipIds: ["m-7"] });
    expect(canActOnTask(a, t, "update_progress").allowed).toBe(true);
  });

  it("manager may reassign, edit plan, approve and verify tasks in company", () => {
    const a = actor({ isManager: true });
    const t = task({ assignedToUserId: "someone-else" });
    for (const act of ["reassign", "edit_plan", "approve_completion", "verify", "cancel"] as const) {
      expect(canActOnTask(a, t, act).allowed).toBe(true);
    }
  });

  it("manager who is also the assignee cannot self-approve/verify/reassign (SoD)", () => {
    const a = actor({ isManager: true, userId: "u-mgr" });
    const t = task({ assignedToUserId: "u-mgr" });
    expect(canActOnTask(a, t, "approve_completion").allowed).toBe(false);
    expect(canActOnTask(a, t, "verify").allowed).toBe(false);
    expect(canActOnTask(a, t, "reassign").allowed).toBe(false);
    // but may still progress their own work
    expect(canActOnTask(a, t, "update_progress").allowed).toBe(true);
  });

  it("admin may intervene on anything in-company (audited)", () => {
    const a = actor({ isAdmin: true });
    const t = task({ assignedToUserId: "other" });
    for (const act of ["verify", "approve_completion", "reassign", "cancel"] as const) {
      expect(canActOnTask(a, t, act).allowed).toBe(true);
    }
  });

  it("a non-assignee non-manager company member is read-only", () => {
    const a = actor();
    const t = task({ assignedToUserId: "other" });
    expect(canActOnTask(a, t, "view").allowed).toBe(true);
    expect(canActOnTask(a, t, "update_progress").allowed).toBe(false);
  });
});
