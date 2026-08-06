import { describe, it, expect } from "vitest";
import { computeCapacityDetail, taskRemaining, type CapacityTask } from "@/modules/work/capacity-detail";

const t = (over: Partial<CapacityTask> = {}): CapacityTask => ({
  status: "in_progress",
  estimateHours: 10,
  actualHours: 0,
  remainingHours: null,
  dueDate: null,
  ...over,
});

describe("taskRemaining", () => {
  it("uses explicit remaining when present", () => {
    expect(taskRemaining(t({ remainingHours: 3 }))).toBe(3);
  });
  it("derives estimate − actual, floored at 0", () => {
    expect(taskRemaining(t({ estimateHours: 10, actualHours: 4 }))).toBe(6);
    expect(taskRemaining(t({ estimateHours: 10, actualHours: 15 }))).toBe(0);
  });
});

describe("computeCapacityDetail", () => {
  it("net = contracted − leave − holidays − reserved", () => {
    const r = computeCapacityDetail({
      contractedWeeklyHours: 40,
      approvedLeaveHours: 8,
      holidayHours: 0,
      reservedHours: 4,
      tasks: [],
    });
    expect(r.netAvailableHours).toBe(28);
    expect(r.freeHours).toBe(28);
    expect(r.status).toBe("underallocated");
  });

  it("sums planned/actual/remaining over OPEN tasks only", () => {
    const r = computeCapacityDetail({
      contractedWeeklyHours: 40,
      approvedLeaveHours: 0,
      holidayHours: 0,
      reservedHours: 0,
      tasks: [
        t({ estimateHours: 10, actualHours: 4 }), // remaining 6
        t({ estimateHours: 8, actualHours: 2, status: "blocked" }), // remaining 6, blocked
        t({ status: "completed", estimateHours: 20, actualHours: 20 }), // excluded
      ],
    });
    expect(r.openTasks).toBe(2);
    expect(r.plannedHours).toBe(18);
    expect(r.actualHours).toBe(6);
    expect(r.remainingHours).toBe(12);
    expect(r.freeHours).toBe(28);
    expect(r.blockedTasks).toBe(1);
  });

  it("flags overdue by due date", () => {
    const r = computeCapacityDetail({
      contractedWeeklyHours: 40,
      approvedLeaveHours: 0,
      holidayHours: 0,
      reservedHours: 0,
      today: "2026-08-15",
      tasks: [t({ dueDate: "2026-08-01" }), t({ dueDate: "2026-08-20" })],
    });
    expect(r.overdueTasks).toBe(1);
  });

  it("marks overloaded when remaining exceeds net", () => {
    const r = computeCapacityDetail({
      contractedWeeklyHours: 40,
      approvedLeaveHours: 0,
      holidayHours: 0,
      reservedHours: 0,
      tasks: [t({ estimateHours: 50, remainingHours: 50 })],
    });
    expect(r.freeHours).toBe(-10);
    expect(r.status).toBe("overloaded");
  });

  it("healthy in the normal band", () => {
    const r = computeCapacityDetail({
      contractedWeeklyHours: 40,
      approvedLeaveHours: 0,
      holidayHours: 0,
      reservedHours: 0,
      tasks: [t({ estimateHours: 30, remainingHours: 30 })], // 75% util
    });
    expect(r.status).toBe("healthy");
  });
});
