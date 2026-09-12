import { describe, it, expect } from "vitest";
import {
  evaluateFollowUp,
  resolveFollowUpDelivery,
  DEFAULT_FOLLOW_UP,
  type FollowUpTask,
  type FollowUpAction,
  type FollowUpResult,
} from "@/modules/work/follow-up";

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

describe("resolveFollowUpDelivery — unowned work must reach a human", () => {
  const due = (action: FollowUpAction, reason = "r"): FollowUpResult => ({ due: true, action, reason });

  it("returns nothing when no follow-up is due", () => {
    expect(resolveFollowUpDelivery({ due: false, action: null, reason: "quiet" }, true)).toBeNull();
    expect(resolveFollowUpDelivery({ due: true, action: null, reason: "odd" }, true)).toBeNull();
  });

  it("sends a worker-directed nudge to the assignee when one is active", () => {
    for (const a of ["estimate_request", "overdue_reminder", "verification_request"] as const) {
      expect(resolveFollowUpDelivery(due(a), true)).toEqual({ to: "assignee", action: a, reason: "r" });
    }
  });

  it("escalates to managers instead of dropping a worker-directed nudge with no assignee", () => {
    for (const a of ["estimate_request", "overdue_reminder", "verification_request"] as const) {
      const r = resolveFollowUpDelivery(due(a, "task is overdue"), false);
      expect(r).toMatchObject({ to: "managers", action: "escalation", unowned: true });
      expect(r!.reason).toContain("nobody is assigned");
    }
  });

  it("an escalation always goes to managers, owned or not", () => {
    expect(resolveFollowUpDelivery(due("escalation", "overdue 5d"), true)).toEqual({ to: "managers", action: "escalation", reason: "overdue 5d", unowned: false });
    expect(resolveFollowUpDelivery(due("escalation", "overdue 5d"), false)).toEqual({ to: "managers", action: "escalation", reason: "overdue 5d", unowned: true });
  });

  it("an untriaged captured task raises nothing — triage is not a reminder", () => {
    // Guards the live blast risk: `captured` work with no due date yields no follow-up at
    // all, so widening the sweep to unowned tasks cannot spam anyone about a backlog.
    const d = evaluateFollowUp(task({ status: "captured", dueDate: null }), DEFAULT_FOLLOW_UP, now);
    expect(d.due).toBe(false);
    expect(resolveFollowUpDelivery(d, false)).toBeNull();
  });

  it("an unowned OVERDUE task does reach the managers", () => {
    const d = evaluateFollowUp(task({ status: "in_progress", dueDate: "2026-08-14", lastActivityAt: hoursAgo(48) }), DEFAULT_FOLLOW_UP, now);
    expect(d.action).toBe("overdue_reminder");
    expect(resolveFollowUpDelivery(d, false)).toMatchObject({ to: "managers", unowned: true });
  });
});
