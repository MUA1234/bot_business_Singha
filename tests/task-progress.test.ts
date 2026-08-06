import { describe, it, expect } from "vitest";
import { applyWorkflowAction, type TaskSnapshot } from "@/modules/work/task-progress";

const snap = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  status: "awaiting_estimate",
  requiresEvidence: false,
  hasEvidence: false,
  ...over,
});

describe("applyWorkflowAction", () => {
  it("worker accepts an assigned task (stays awaiting_estimate)", () => {
    const r = applyWorkflowAction(snap(), { action: "accept" });
    expect(r.ok).toBe(true);
    expect(r.toState).toBe("awaiting_estimate");
  });

  it("decline requires a reason and routes back to planned", () => {
    expect(applyWorkflowAction(snap(), { action: "decline" }).ok).toBe(false);
    const r = applyWorkflowAction(snap(), { action: "decline", reason: "not my skill" });
    expect(r.ok).toBe(true);
    expect(r.toState).toBe("planned");
    expect(r.patch.declined_reason).toBe("not my skill");
  });

  it("submit_estimate records hours + expected completion", () => {
    const r = applyWorkflowAction(snap(), { action: "submit_estimate", hours: "12", expectedCompletion: "2026-09-01" });
    expect(r.ok).toBe(true);
    expect(r.patch.estimate_hours).toBe(12);
    expect(r.patch.expected_completion).toBe("2026-09-01");
  });

  it("rejects a negative/garbage estimate", () => {
    expect(applyWorkflowAction(snap(), { action: "submit_estimate", hours: "-3" }).ok).toBe(false);
    expect(applyWorkflowAction(snap(), { action: "submit_estimate", hours: "abc" }).ok).toBe(false);
  });

  it("manager accept_estimate → scheduled, then start → in_progress", () => {
    expect(applyWorkflowAction(snap(), { action: "accept_estimate" }).toState).toBe("scheduled");
    expect(applyWorkflowAction(snap({ status: "scheduled" }), { action: "start" }).toState).toBe("in_progress");
  });

  it("blocker requires a reason; unblock clears it", () => {
    expect(applyWorkflowAction(snap({ status: "in_progress" }), { action: "report_blocker" }).ok).toBe(false);
    const b = applyWorkflowAction(snap({ status: "in_progress" }), { action: "report_blocker", reason: "waiting parts" });
    expect(b.toState).toBe("blocked");
    expect(b.patch.blocker_reason).toBe("waiting parts");
    const u = applyWorkflowAction(snap({ status: "blocked" }), { action: "unblock" });
    expect(u.toState).toBe("in_progress");
    expect(u.patch.blocker_reason).toBeNull();
  });

  it("log_progress records actual hours without changing state", () => {
    const r = applyWorkflowAction(snap({ status: "in_progress" }), { action: "log_progress", hours: "4.5" });
    expect(r.ok).toBe(true);
    expect(r.toState).toBe("in_progress");
    expect(r.patch.actual_hours).toBe(4.5);
  });

  it("cannot log progress from a non-active state", () => {
    expect(applyWorkflowAction(snap({ status: "scheduled" }), { action: "log_progress", hours: "1" }).ok).toBe(false);
  });

  it("verify_complete is evidence-gated and human-only", () => {
    // requires evidence but none → blocked
    const blocked = applyWorkflowAction(snap({ status: "verification", requiresEvidence: true, hasEvidence: false }), {
      action: "verify_complete",
      byHuman: true,
    });
    expect(blocked.ok).toBe(false);
    // evidence present + human → completes
    const ok = applyWorkflowAction(snap({ status: "verification", requiresEvidence: true, hasEvidence: true }), {
      action: "verify_complete",
      byHuman: true,
    });
    expect(ok.ok).toBe(true);
    expect(ok.toState).toBe("completed");
    // evidence present but NOT human → blocked
    const notHuman = applyWorkflowAction(snap({ status: "verification", requiresEvidence: true, hasEvidence: true }), {
      action: "verify_complete",
      byHuman: false,
    });
    expect(notHuman.ok).toBe(false);
  });

  it("return_for_correction sends verification back to in_progress", () => {
    const r = applyWorkflowAction(snap({ status: "verification" }), { action: "return_for_correction" });
    expect(r.ok).toBe(true);
    expect(r.toState).toBe("in_progress");
  });

  it("rejects structurally illegal transitions", () => {
    expect(applyWorkflowAction(snap({ status: "completed" }), { action: "start" }).ok).toBe(false);
  });
});
