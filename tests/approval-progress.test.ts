import { describe, it, expect } from "vitest";
import { computeApprovalProgress, canActOnApproval } from "@/policy/approval-progress";

describe("approval progress + SoD (change plan §7)", () => {
  it("needs enough distinct approvers", () => {
    expect(computeApprovalProgress([], 2).status).toBe("pending");
    expect(computeApprovalProgress([{ actorUserId: "a", action: "approve" }], 2).remaining).toBe(1);
    expect(computeApprovalProgress([
      { actorUserId: "a", action: "approve" },
      { actorUserId: "b", action: "approve" },
    ], 2).status).toBe("approved");
  });

  it("a duplicate approver does not double-count", () => {
    const p = computeApprovalProgress([
      { actorUserId: "a", action: "approve" },
      { actorUserId: "a", action: "approve" },
    ], 2);
    expect(p.approvals).toBe(1);
    expect(p.status).toBe("pending");
  });

  it("any rejection rejects the request", () => {
    expect(computeApprovalProgress([
      { actorUserId: "a", action: "approve" },
      { actorUserId: "b", action: "reject" },
    ], 2).status).toBe("rejected");
  });

  it("SoD blocks the submitter, non-approvers, repeat actors and closed requests", () => {
    const base = { submitterUserId: "sub", actorIsApprover: true, alreadyActedUserIds: [] as string[], status: "pending" as const };
    expect(canActOnApproval({ ...base, actorUserId: "sub" }).allowed).toBe(false);
    expect(canActOnApproval({ ...base, actorUserId: "x", actorIsApprover: false }).allowed).toBe(false);
    expect(canActOnApproval({ ...base, actorUserId: "x", alreadyActedUserIds: ["x"] }).allowed).toBe(false);
    expect(canActOnApproval({ ...base, actorUserId: "x", status: "approved" }).allowed).toBe(false);
    expect(canActOnApproval({ ...base, actorUserId: "x" }).allowed).toBe(true);
  });
});
