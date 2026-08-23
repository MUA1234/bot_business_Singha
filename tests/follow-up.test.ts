import { describe, it, expect } from "vitest";
import { evaluateFollowUp, selectEscalationTarget, DEFAULT_FOLLOW_UP, type FollowUpTask } from "@/modules/work/follow-up";

const now = new Date("2026-08-15T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

const task = (over: Partial<FollowUpTask> = {}): FollowUpTask => ({
  status: "in_progress",
  dueDate: null,
  lastActivityAt: hoursAgo(48),
  lastReminderAt: null,
  ...over,
});

describe("evaluateFollowUp (§WP3.8 / §WP4.7)", () => {
  it("no follow-up for terminal tasks", () => {
    expect(evaluateFollowUp(task({ status: "completed" }), DEFAULT_FOLLOW_UP, now).due).toBe(false);
    expect(evaluateFollowUp(task({ status: "cancelled" }), DEFAULT_FOLLOW_UP, now).due).toBe(false);
  });

  it("nudges for a missing estimate after the interval", () => {
    const r = evaluateFollowUp(task({ status: "awaiting_estimate", lastActivityAt: hoursAgo(30) }), DEFAULT_FOLLOW_UP, now);
    expect(r.due).toBe(true);
    expect(r.action).toBe("estimate_request");
  });

  it("stays quiet within the reminder interval", () => {
    const r = evaluateFollowUp(task({ status: "awaiting_estimate", lastActivityAt: hoursAgo(2) }), DEFAULT_FOLLOW_UP, now);
    expect(r.due).toBe(false);
  });

  it("sends an overdue reminder for an in-progress task past its due date", () => {
    const r = evaluateFollowUp(task({ status: "in_progress", dueDate: "2026-08-14", lastActivityAt: hoursAgo(48) }), DEFAULT_FOLLOW_UP, now);
    expect(r.due).toBe(true);
    expect(r.action).toBe("overdue_reminder");
  });

  it("escalates when overdue beyond the escalation window", () => {
    const r = evaluateFollowUp(task({ status: "in_progress", dueDate: "2026-08-10", lastActivityAt: hoursAgo(48) }), DEFAULT_FOLLOW_UP, now);
    expect(r.due).toBe(true);
    expect(r.action).toBe("escalation");
  });

  it("escalates a stuck 'escalated' task regardless of due date", () => {
    expect(evaluateFollowUp(task({ status: "escalated", lastActivityAt: hoursAgo(48) }), DEFAULT_FOLLOW_UP, now).action).toBe("escalation");
  });

  it("nudges for verification when awaiting evidence/verification", () => {
    expect(evaluateFollowUp(task({ status: "awaiting_evidence", lastActivityAt: hoursAgo(48) }), DEFAULT_FOLLOW_UP, now).action).toBe("verification_request");
    expect(evaluateFollowUp(task({ status: "verification", lastActivityAt: hoursAgo(48) }), DEFAULT_FOLLOW_UP, now).action).toBe("verification_request");
  });

  it("respects lastReminderAt to avoid spamming", () => {
    const r = evaluateFollowUp(task({ status: "awaiting_estimate", lastActivityAt: hoursAgo(72), lastReminderAt: hoursAgo(1) }), DEFAULT_FOLLOW_UP, now);
    expect(r.due).toBe(false);
  });

  it("in-progress and not overdue → no follow-up", () => {
    const r = evaluateFollowUp(task({ status: "in_progress", dueDate: "2026-08-20", lastActivityAt: hoursAgo(48) }), DEFAULT_FOLLOW_UP, now);
    expect(r.due).toBe(false);
  });
});

describe("selectEscalationTarget", () => {
  it("advances one step into a defined chain", () => {
    const r = selectEscalationTarget(["u1", "u2", "u3"], 0);
    expect(r.targetId).toBe("u1");
    expect(r.nextLevel).toBe(1);
    expect(r.reason).toBe("escalation_step_1");
  });

  it("advances to the next person on a subsequent escalation", () => {
    const r = selectEscalationTarget(["u1", "u2", "u3"], 1);
    expect(r.targetId).toBe("u2");
    expect(r.nextLevel).toBe(2);
  });

  it("reports chain_exhausted when the chain is empty", () => {
    const r = selectEscalationTarget([], 0);
    expect(r.targetId).toBeNull();
    expect(r.reason).toBe("chain_exhausted");
  });

  it("reports chain_exhausted after the last step", () => {
    const r = selectEscalationTarget(["u1"], 1);
    expect(r.targetId).toBeNull();
    expect(r.nextLevel).toBe(1);
    expect(r.reason).toBe("chain_exhausted");
  });

  it("ignores non-string entries in the chain", () => {
    const r = selectEscalationTarget(["u1", "", "u2"] as unknown as string[], 0);
    expect(r.targetId).toBe("u1");
    expect(r.nextLevel).toBe(1);
  });
});
