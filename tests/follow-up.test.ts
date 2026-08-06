import { describe, it, expect } from "vitest";
import { evaluateFollowUp, DEFAULT_FOLLOW_UP, type FollowUpTask } from "@/modules/work/follow-up";

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
